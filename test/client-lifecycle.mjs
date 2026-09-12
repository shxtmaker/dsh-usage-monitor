// test/client-lifecycle.mjs — A1 客户端请求生命周期回归
// 用法：node --test test/client-lifecycle.mjs
//
// 覆盖技术方案 A1 的验收项（全部通过组件渲染 + 真实 AbortController 验证，不只看函数返回值）：
//   1) 每次 GET 延迟 15s、连续三轮：三个有效结果都能发布，最大后台 GET 并发为 1；
//   2) GET 永不结束：30s 触发取消并按退避恢复，不积累悬挂请求；
//   3) A/B 切页后 A 的迟到响应不得进入 B 的显示或覆盖 B 缓存；
//   4) 隐藏超过 30s 不发后台 GET，恢复只启动一次查询；
//   5) 卸载后计时器与监听为零，不发布新状态；
//   6) 手动刷新超过 10s 仍能发布结果，不被后台请求作废；
//   7) 合并重复点击的同一刷新操作；完成后恢复后台轮询且最大并发仍为 1。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

const POLL_MS = 10_000;
const GET_TIMEOUT_MS = 30_000;
const MUTATE_TIMEOUT_MS = 150_000; // refresh/test：后端最长 120s 查询 + 余量
const BACKOFF_MS = [10_000, 20_000, 40_000, 60_000];

/** 挂载客户端插件；fetch 由用例给出，计时器走手动桩，页面可见性可切换。 */
function client(fetch) {
  const timers = [];
  const timeouts = []; // 每个 GET 的 30s 初始等待上限，按发起顺序
  const listeners = {};
  const slots = {};
  const pending = () => timers.filter((t) => !t.fired);
  let plugin; // 必须在 vm.runInNewContext 之前声明：ModuleLoader.load 在脚本求值时同步回调
  const document = {
    querySelector: () => true,
    body: {},
    visibilityState: "visible",
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
  };
  const window = {
    __ModuleLoader__: { load({ factory }) {
      plugin = factory((id) => id === "react" ? React : { createPortal: (child) => child });
    } },
    location: { search: "" },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
  };
  const context = {
    window, document, fetch, console, location: { search: "" },
    AbortController, AbortSignal,
    setTimeout(fn, ms) {
      // 返回句柄本身（不是新对象）：客户端的 clearTimeout(handle) 必须能按同一引用撤销
      const handle = { fn, ms, fired: false, fire() { handle.fired = true; fn(); }, unref() {} };
      timers.push(handle);
      if (ms === GET_TIMEOUT_MS) timeouts.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const index = timers.indexOf(handle);
      if (index >= 0) timers.splice(index, 1);
      const timeoutIndex = timeouts.indexOf(handle);
      if (timeoutIndex >= 0) timeouts.splice(timeoutIndex, 1);
    },
    setInterval(fn) { timers.push({ fn, ms: "interval" }); return fn; },
    clearInterval() {},
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), context);
  // 「当前显示页」订阅源：与官方 sessions.list 同形（getSnapshot/subscribe）
  const sessionListeners = new Set();
  let current = "";
  const sessions = {
    list: {
      getSnapshot: () => ({ current }),
      subscribe(fn) { sessionListeners.add(fn); return () => sessionListeners.delete(fn); },
    },
  };
  plugin.apply({ locale: { register() {} }, effect() {}, get: (name) => (name === "sessions" ? sessions : undefined), slots: {
    inject(name, fn) { fn(); },
    register(descriptor, component) { slots[descriptor.name ?? descriptor.key] = component; },
  } });
  return {
    Component: slots["sidebar.footer.action"],
    timers,
    timeouts,
    /** 仍在排定中的计时器（已触发的会被移出）。 */
    pending,
    fire: (handle) => handle.fire(),
    documentListeners: listeners,
    /**
     * 触发「当前在途请求」的 30s 初始等待上限（每次请求恰好一个，随请求结算/取消被清理）。
     * @returns 是否真的触发了一个仍在挂起的上限。
     */
    expireTimeout() {
      const guard = timeouts.find((t) => pending().includes(t));
      if (!guard) return false;
      guard.fire();
      return true;
    },
    /** 清空计时器台账：用于按阶段精确断言（不影响已排定的回调）。 */
    resetTimers: () => { timers.length = 0; },
    /** 切到某个会话页（等价于官方 sessions.list.current 变化）。 */
    setSession(id) {
      current = id;
      for (const fn of [...sessionListeners]) fn();
    },
    timers,
    document,
    /** 本会话内的后台 GET 计时器（10s/20s/40s/60s）。 */
    pendingPolls: () => timers.filter((t) => BACKOFF_MS.includes(t.ms)),
    timeouts: () => timers.filter((t) => t.ms === GET_TIMEOUT_MS || t.ms === 150_000),
    /** 把页面切到隐藏/可见并派发 visibilitychange。 */
    setVisibility(state) {
      document.visibilityState = state;
      for (const fn of listeners.visibilitychange || []) fn();
    },
  };
}

/** 可手动结算的 fetch：记录 URL / 方法 / signal，并支持断言「请求已被 abort」。 */
function fakeFetch() {
  const calls = [];
  const pending = [];
  const fetch = (url, options = {}) => new Promise((resolve, reject) => {
    const call = { url: String(url), method: options.method || "GET", aborted: false, resolve, reject };
    options.signal?.addEventListener?.("abort", () => {
      call.aborted = true;
      // 浏览器 fetch 以 signal.reason 拒绝：超时是 TimeoutError、切页取消是 AbortError
      const reason = options.signal.reason;
      if (reason && typeof reason === "object") reject(reason);
      else { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }
    });
    calls.push(call);
    pending.push(call);
  });
  const ok = (call, body, status = 200) => { call.settled = true; return call.resolve({ ok: status < 400, status, json: async () => body }); };
  const fail = (call, error) => { call.settled = true; return call.reject(error); };
  const gets = () => calls.filter((c) => c.method === "GET");
  const posts = () => calls.filter((c) => c.method === "POST");
  return { calls, fetch, ok, fail, gets, posts, lastGet: () => gets().at(-1), lastPost: () => posts().at(-1) };
}

const stateFor = (name, suppliers = []) => ({
  ok: true,
  traffic: { channelAlive: true },
  suppliers,
  active: { supplierId: "x", name, model: "m", at: Date.now() },
});
const textOf = (node) => {
  const walk = (c) => Array.isArray(c) ? c.map(walk).join("") : typeof c === "string" ? c : c?.children ? walk(c.children) : "";
  return walk(node.children ?? node);
};
const line2 = (tree) => {
  const nodes = tree.root.findAllByProps({ className: "qm-l2" });
  return nodes.length ? textOf(nodes[0]) : "";
};
/** 打开紧凑条弹层 → 进入详情弹层 → 返回其中的刷新按钮。 */
const openDetail = (tree) => {
  const entry = tree.root.findAllByProps({ "data-qm-entry": "" })[0];
  act(() => { entry.props.onClick(); });
  const detailButton = tree.root.findAllByType("button").find((b) => textOf(b).includes("detail"));
  assert.ok(detailButton, "Popover 应有详情入口");
  act(() => { detailButton.props.onClick(); });
  const refreshButton = tree.root.findAllByType("button").find((b) => textOf(b).includes("refresh"));
  assert.ok(refreshButton, "详情弹层应有刷新按钮");
  return refreshButton;
};
/**
 * 让取消/结算沿 Promise 链走完。
 * AbortController.abort() 只做同步通知，fetch 的拒绝、load 的 finally（释放等待上限）
 * 都在随后的微任务里结算 —— 必须显式让出宏任务，否则断言会看到「上一轮仍未收尾」的中间态。
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const flushPending = async () => { await act(async () => { await settle(); await act(async () => { await settle(); }); }); };
const mount = async (Component, props) => {
  let tree;
  await act(async () => { tree = create(React.createElement(Component, { wide: true, t: (k, p) => (p?.n !== undefined ? `${k}:${p.n}` : k), ...props })); });
  return tree;
};

test("slow GETs still publish three rounds and never exceed one background GET in flight", async () => {
  const net = fakeFetch();
  const { Component, timers } = client(net.fetch);
  let tree;
  try {
    tree = await mount(Component, {});
    assert.equal(net.gets().length, 1, "挂载后发起一次后台 GET");
    for (const name of ["round-1", "round-2", "round-3"]) {
      assert.equal(net.gets().filter((c) => !c.settled).length, 1, "同一时刻最多一个后台 GET");
      const call = net.lastGet();
      call.settled = true;
      await act(async () => { net.ok(call, stateFor(name)); });
      assert.ok(line2(tree).includes(name), `第 ${name} 轮结果必须发布（实际 ${line2(tree)}）`);
      // 「完成后调度」：结果发布后才排下一次，且延迟为正常节奏 10s
      const poll = timers.find((t) => t.ms === POLL_MS);
      assert.ok(poll, `${name} 之后必须排下一次后台 GET`);
      await act(async () => { poll.fn(); });
    }
    // 每一轮只有一次查询：三轮 = 3 次已完成 + 1 次刚排出的后续请求
    assert.equal(net.gets().length, 4, "三轮各自完成一次查询，之后才排下一次（不被饥饿丢弃）");
    assert.equal(net.gets().filter((c) => !c.settled).length, 1, "只允许一个尚未结算的后续请求");
    assert.equal(net.gets().filter((c) => c.aborted).length, 0, "慢请求正常结算，不得被误取消");
    assert.equal(timers.filter((t) => t.ms === "interval").length, 0, "不得再使用固定间隔轮询");
  } finally { await act(async () => { tree?.unmount(); }); }
});


test("a GET that never finishes is cancelled at 30s and retried with backoff", async () => {
  const net = fakeFetch();
  const { Component, timers, expireTimeout, resetTimers } = client(net.fetch);
  let tree;
  const backoffs = () => timers.filter((t) => BACKOFF_MS.includes(t.ms)).map((t) => t.ms);
  const takeBackoff = () => timers.filter((t) => BACKOFF_MS.includes(t.ms)).at(-1);
  try {
    tree = await mount(Component, {});
    await act(async () => { net.ok(net.lastGet(), stateFor("first")); });
    assert.ok(line2(tree).includes("first"), "首轮正常结果必须发布");

    // 阶段一：下一次 GET 永远不结束 → 30s 上限到点必须取消它
    const nextPoll = timers.filter((t) => t.ms === POLL_MS).at(-1);
    assert.ok(nextPoll, "首轮成功后必须排下一次轮询");
    resetTimers();
    await act(async () => { nextPoll.fire(); });
    const hanging = net.lastGet();
    assert.equal(hanging.aborted, false, "在途请求此时仍未被取消");
    assert.equal(expireTimeout(), true, "GET 必须有 30s 初始等待上限");
    await flushPending();
    assert.equal(hanging.aborted, true, "30s 到点必须取消挂起的 GET");
    assert.ok(backoffs().length > 0, "超时后必须按退避重试");

    // 阶段二：连续超时使退避档位单调递增并封顶 60s（不再固定间隔）
    let previous = backoffs().at(-1);
    for (let step = 0; step < 4; step++) {
      const timer = takeBackoff();
      assert.ok(timer, `第 ${step + 1} 轮必须有退避计时器`);
      resetTimers();
      await act(async () => { timer.fire(); });
      const startedAt = Date.now();
      assert.equal(expireTimeout(), true, `第 ${step + 1} 轮请求应有 30s 上限`);
      assert.ok(Date.now() - startedAt < 1000, "超时上限是本次请求新建的（不是上一轮的残留）");
      await flushPending();
      const next = backoffs().at(-1);
      assert.ok(next, `第 ${step + 2} 次失败后必须继续排重试`);
      assert.ok(next >= previous, `退避不得倒退（${previous} → ${next}）`);
      if (step >= 1) assert.ok(next > POLL_MS, "连续失败必须超过 10s 正常节奏");
      previous = Math.max(previous, next);
    }
    assert.equal(previous, BACKOFF_MS.at(-1), "退避最终封顶在 60s");

    // 阶段三：成功后复位到 10s 正常节奏
    const finalRetry = takeBackoff();
    assert.ok(finalRetry, "封顶退避到点后仍须重试一次");
    resetTimers();
    await act(async () => { finalRetry.fire(); });
    await act(async () => { net.ok(net.lastGet(), stateFor("recovered")); });
    assert.ok(line2(tree).includes("recovered"), "退避后恢复成功必须发布");
    assert.ok(timers.find((t) => t.ms === POLL_MS), "成功后复位到 10s 正常节奏");
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("a page hidden at mount does not fetch until it becomes visible", async () => {
  const net = fakeFetch();
  const { Component, setVisibility } = client(net.fetch);
  let tree;
  try {
    setVisibility("hidden");
    tree = await mount(Component, {});
    assert.equal(net.gets().length, 0, "隐藏状态下不得发起后台 GET");
    await act(async () => { setVisibility("visible"); });
    assert.equal(net.gets().length, 1, "恢复可见只启动一次查询");
    await act(async () => { net.ok(net.lastGet(), stateFor("resumed")); });
    assert.ok(line2(tree).includes("resumed"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("a late response from page A never enters page B display or cache", async () => {
  const net = fakeFetch();
  const { Component, setSession } = client(net.fetch);
  let tree;
  try {
    await act(async () => { setSession("A"); });
    tree = await mount(Component, {});
    const callA = net.lastGet();
    assert.match(callA.url, /\?session=A/, "页 A 的查询必须带会话标识");
    await act(async () => { setSession("B"); });
    assert.equal(callA.aborted, true, "切页必须取消旧会话的在途 GET");
    const callB = net.lastGet();
    assert.match(callB.url, /\?session=B/);
    await act(async () => { net.ok(callB, stateFor("B-page")); });
    assert.ok(line2(tree).includes("B-page"));
    // A 的迟到响应即使结算也不得回写（代次校验兜住不可取消的路径）
    await act(async () => { net.ok(callA, stateFor("A-late")); });
    assert.ok(!line2(tree).includes("A-late"), "A 的迟到响应不得进入 B 的显示");
    await act(async () => { setSession("A"); });
    assert.ok(!line2(tree).includes("A-late"), "A 的迟到响应不得覆盖 A 的缓存");
    assert.ok(!line2(tree).includes("B-page"), "切回 A 不得残留 B 的供应商");
    await act(async () => { net.ok(net.lastGet(), stateFor("A-fresh")); });
    assert.ok(line2(tree).includes("A-fresh"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("a hidden page stops background GETs; becoming visible starts exactly one", async () => {
  const net = fakeFetch();
  const { Component, timers, pending, setVisibility } = client(net.fetch);
  let tree;
  try {
    tree = await mount(Component, {});
    await act(async () => { net.ok(net.lastGet(), stateFor("visible")); });
    await flushPending(); // 等 getState 的 finally 释放 30s 等待上限
    assert.equal(net.gets()[0].settled, true);
    assert.equal(pending().filter((t) => t.ms === GET_TIMEOUT_MS).length, 0, "结算后必须释放请求等待上限");
    const pendingPoll = timers.find((t) => t.ms === POLL_MS && !t.fired);
    assert.ok(pendingPoll, "正常节奏下必须有下一次轮询");
    await act(async () => { pendingPoll.fire(); }); // 让第二次 GET 真的在途
    const inflight = net.lastGet();
    assert.equal(net.gets().filter((c) => !c.settled && !c.aborted).length, 1, "隐藏前必须有一个在途 GET");
    await act(async () => { setVisibility("hidden"); });
    await flushPending();
    assert.equal(inflight.aborted, true, "隐藏时必须取消后台 GET");
    assert.equal(pending().includes(pendingPoll), false, "隐藏时必须停掉已排定的后台轮询");
    // 隐藏时在途请求已被释放；此时不得再有「为在途请求服务的」等待上限
    assert.equal(net.gets().filter((c) => !c.aborted && !c.settled).length, 0, "隐藏后不得留悬挂请求");
    assert.equal(pending().filter((t) => t.ms === POLL_MS || BACKOFF_MS.includes(t.ms)).length, 0,
      "隐藏时必须停掉后台轮询/退避计时器");
    assert.equal(net.gets().filter((c) => !c.aborted && !c.settled).length, 0, "隐藏后不得留悬挂请求");
    // 隐藏期间推进任何残余计时器，都不得再发 GET
    const hiddenAt = net.gets().length;
    for (const timer of [...pending()]) await act(async () => { timer.fire(); });
    await act(async () => { setVisibility("visible"); });
    assert.equal(net.gets().length, hiddenAt + 1, "恢复可见只启动一次查询");
    // 恢复可见的那次查询结算后，只排一个后续轮询（恢复与定时不叠加）
    await act(async () => { net.ok(net.lastGet(), stateFor("resumed")); });
    await flushPending();
    const repoll = [...pending()].filter((t) => t.ms === POLL_MS);
    assert.equal(repoll.length, 1, "恢复后只排一个后续轮询（不出现恢复+定时双发）");
    await act(async () => { repoll[0].fire(); });
    assert.equal(net.gets().length, hiddenAt + 2, "恢复后的下一次查询只由正常节奏触发一次");
    await act(async () => { net.ok(net.lastGet(), stateFor("back")); });
    assert.ok(line2(tree).includes("back"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("unmount releases timers, listeners and in-flight GETs without publishing", async () => {
  const net = fakeFetch();
  const { Component, timers, pending, documentListeners } = client(net.fetch);
  let tree;
  tree = await mount(Component, {});
  await act(async () => { net.ok(net.lastGet(), stateFor("loaded")); });
  const pendingPoll = timers.find((t) => t.ms === POLL_MS);
  assert.ok(pendingPoll, "结算后应排下一次轮询");
  await act(async () => { pendingPoll.fire(); });
  const inflight = net.lastGet();
  const before = net.gets().length;
  const listenerCount = () => (documentListeners.visibilitychange || []).length;
  const listenersBefore = listenerCount();
  await act(async () => { tree.unmount(); });
  await flushPending();
  assert.equal(inflight.aborted, true, "卸载必须释放在途 GET");
  assert.equal(pending().includes(pendingPoll), false, "卸载后不得残留轮询计时器");
  assert.equal(net.gets().filter((c) => !c.aborted && !c.settled).length, 0, "卸载后不得留悬挂请求");
  assert.equal(pending().filter((t) => t.ms === POLL_MS || BACKOFF_MS.includes(t.ms)).length, 0,
    "卸载后不得残留轮询/退避计时器");
  assert.equal(listenerCount(), listenersBefore - 1, "卸载必须摘掉 visibilitychange 监听");
  assert.equal(listenersBefore, 1, "挂载期间应恰好一个 visibilitychange 监听");
  await act(async () => { net.ok(inflight, stateFor("ghost")); });
  assert.equal(net.gets().length, before, "卸载后不得再发起查询");
  assert.equal(net.posts().length, 0);
});

test("manual refresh slower than the poll interval still publishes and resumes polling", async () => {
  const net = fakeFetch();
  const { Component, timers } = client(net.fetch);
  let tree;
  try {
    tree = await mount(Component, {});
    await act(async () => { net.ok(net.lastGet(), stateFor("background")); });
    const detail = openDetail(tree);
    await act(async () => { detail.props.onClick(); });
    const refresh = net.lastPost();
    assert.match(refresh.url, /\/refresh/);
    assert.ok(timers.some((t) => t.ms === MUTATE_TIMEOUT_MS), "refresh 需要独立的更长等待上限（130s+），不是 30s");
    // 后台 GET 已暂停：推进轮询/退避计时器都不应产生新的 GET
    // （不能推进请求自身的等待上限 —— 那等于宣告此时刷新超时）
    const getsBefore = net.gets().length;
    const pollTimers = timers.filter((t) => t.ms === POLL_MS || BACKOFF_MS.includes(t.ms));
    for (const timer of pollTimers) await act(async () => { timer.fire(); });
    assert.equal(net.gets().length, getsBefore, "手动刷新期间不得并发后台 GET");
    // 手动刷新在 10s 之后才回来：仍然必须发布结果
    await act(async () => { net.ok(refresh, stateFor("manual")); });
    assert.ok(line2(tree).includes("manual"), "超过轮询周期的手动刷新结果仍必须发布");
    assert.ok(timers.find((t) => t.ms === POLL_MS), "刷新完成后必须恢复后台轮询");
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("duplicate refresh clicks merge into one POST and keep one background GET at a time", async () => {
  const net = fakeFetch();
  const { Component, timers, pending } = client(net.fetch);
  let tree;
  try {
    tree = await mount(Component, {});
    await act(async () => { net.ok(net.lastGet(), stateFor("background")); });
    const detail = openDetail(tree);
    await act(async () => { detail.props.onClick(); detail.props.onClick(); detail.props.onClick(); });
    assert.equal(net.posts().length, 1, "重复点击同一刷新必须合并为一次请求");
    await act(async () => { net.ok(net.lastPost(), stateFor("merged")); });
    const polls = timers.filter((t) => t.ms === POLL_MS);
    assert.equal(polls.length, 1, "刷新结束后只恢复一个后台循环");
    await act(async () => { polls[0].fire(); });
    await flushPending(); // cycle 是异步的：让它在断言前真正发起 GET
    assert.equal(net.gets().filter((c) => !c.settled && !c.aborted).length, 1, "恢复后仍最多一个在途 GET");
    await act(async () => { net.ok(net.lastGet(), stateFor("after-refresh")); });
    assert.ok(line2(tree).includes("after-refresh"));
  } finally { await act(async () => { tree?.unmount(); }); }
});
