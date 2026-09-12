// scripts/benchmark-runtime.mjs — 运行时基准（状态端点、事件记账、轮询与句柄收尾）
//
// 用法：
//   node scripts/benchmark-runtime.mjs                 # 默认矩阵（1/13 供应商 × 7/90 天）
//   node scripts/benchmark-runtime.mjs --quick         # 快速档
//   node scripts/benchmark-runtime.mjs --json          # 只输出 JSON
//   node scripts/benchmark-runtime.mjs --rates=0,1,10,100 --clients=1,5,20
//
// 设计（技术方案 6.1）：
//   - 真实插件装配（lib/index.js）+ 真实路由处理器，宿主 HTTP 供应商查询被固定响应替换，
//     绝不访问真实计费账户；
//   - 记录 /state 的 p50/p95/p99、事件循环延迟、process.cpuUsage、RSS/heapUsed 趋势、
//     保存次数/字节/耗时、最大查询并发、卸载后的剩余句柄；
//   - 内存判断比较「预热后稳定区间」与「多轮挂载卸载后的残留」，不以单次 RSS 判定泄漏。
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const args = new Set([...process.argv.slice(2)].filter((a) => !a.startsWith("--rates") && !a.startsWith("--clients")));
const rawValueOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};
const listOf = (name, fallback) => String(rawValueOf(name, fallback)).split(",").map(Number).filter(Number.isFinite);
const numOf = (name, fallback) => Number(rawValueOf(name, fallback)) || fallback;
const quick = args.has("--quick");
const jsonOnly = args.has("--json");
const RATES = listOf("rates", quick ? "0,10" : "0,1,10,100");
const CLIENTS = listOf("clients", quick ? "1" : "1,5,20");
const SUPPLIERS = numOf("suppliers", quick ? 1 : 1);
const DAYS = numOf("days", quick ? 7 : 90);
const WARMUP_MS = numOf("warmup", quick ? 300 : 1000);
const SAMPLE_MS = numOf("sample", quick ? 1000 : 2000);
const log = (...a) => { if (!jsonOnly) console.log(...a); };

/** 固定供应商响应：只认本地 loopback 之外的出站请求。 */
function stubProviderFetch() {
  const calls = { total: 0, inFlight: 0, max: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!/^https?:\/\//.test(url) || /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\])/.test(url)) return real(input, init);
    calls.total++;
    calls.inFlight++;
    calls.max = Math.max(calls.max, calls.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const body = url.includes("/user/balance")
        ? { balance_infos: [{ currency: "USD", total_balance: "12.34" }] }
        : { usage: { rolling: { percent: 10, resetsAt: "2026-09-13T00:00:00Z" } }, meters: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    } finally { calls.inFlight--; }
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function mountPlugin() {
  const home = mkdtempSync(join(tmpdir(), "qm-bench-runtime-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const events = new Map();
  const config = { suppliers: {}, intervalSeconds: 60, retentionDays: DAYS };
  const layer = { suppliers: {} };
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v)) merge(dst[k] ??= {}, v);
      else dst[k] = v;
    }
  };
  let watch = null;
  const settings = {
    register: () => ({
      get: () => structuredClone(config),
      watch: (cb) => { watch = cb; return () => { watch = null; }; },
      describe: () => ({ user: layer }),
    }),
    get: (ns) => (ns === "llm-pi-ai" ? { providers: Object.fromEntries(
      Array.from({ length: SUPPLIERS }, (_, i) => [`opencode-${i}`, { apiKeyEnv: `OPENCODE_${i}_KEY` }])) } : undefined),
    describe: () => [],
    update: async (ns, patch) => { merge(config, patch); merge(layer, patch); watch?.(structuredClone(config)); },
  };
  const ctx = {
    settings,
    get: (name) => (name === "credentials" ? { resolve: async (ref) => ({ value: `key-${ref}`, source: "file" }) } : undefined),
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    on: (name, cb) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(cb);
      return () => {};
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const dispose = apply(ctx);
  return {
    dispose, routes, events,
    callState: (session = null) => new Promise((resolve) => {
      const url = session === null ? "/api/dsh-token-quota/state" : `/api/dsh-token-quota/state?session=${session}`;
      routes.get("/api/dsh-token-quota/state")({ method: "GET", headers: {}, url },
        { writeHead() {}, end(payload) { resolve(payload); } });
    }),
    emit: (session, event) => { for (const cb of events.get("session/event") || []) cb(session, event); },
    async cleanup() {
      dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const percentiles = (values, qs = [0.5, 0.95, 0.99]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(qs.map((q) => [`p${Math.round(q * 100)}`, +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(3)]));
};

/** 事件循环延迟采样（自调度 setTimeout，测量实际等待与期望等待之差）。 */
function startLagSampler() {
  const lags = [];
  let last = performance.now();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    lags.push(Math.max(0, now - last - 20));
    last = now;
    setTimeout(tick, 20).unref?.();
  };
  setTimeout(tick, 20).unref?.();
  return { stop: () => { stopped = true; return lags; } };
}

async function runCase({ clients, rate, suppliers, days }) {
  const stub = stubProviderFetch();
  const plugin = mountPlugin();
  const sessions = Array.from({ length: clients }, (_, i) => ({ id: `session-${i}` }));
  const stateLatencies = [];
  let saves = 0;
  let eventsSent = 0;
  const started = process.cpuUsage();
  const rssStart = process.memoryUsage();
  try {
    // 预热：让自动探测、首轮取数与落盘稳定下来
    await new Promise((r) => setTimeout(r, WARMUP_MS));
    const sampler = startLagSampler();
    const usageFile = join(process.env.DSH_HOME, "dsh-token-quota", "usage.json");
    const sizeBefore = (() => { try { return statSync(usageFile).size; } catch { return 0; } })();

    const perTick = Math.max(0, Math.round(rate / 20)); // 50ms 一个节拍
    const timer = setInterval(() => {
      for (let i = 0; i < perTick; i++) {
        const session = sessions[eventsSent % sessions.length];
        // 相同样本重复 + 每 10 次一个有效增量：分别对应 C2 的两条路径
        const tokens = eventsSent % 10 === 0 ? 100 + eventsSent : 100 + Math.floor(eventsSent / 10) * 100;
        plugin.emit(session, {
          type: "assistant/chunk",
          data: { provider: "opencode-0", turn: 1, step: eventsSent, chunk: { type: "usage", usage: { inputTokens: tokens } } },
        });
        eventsSent++;
      }
    }, 50);

    const deadline = performance.now() + SAMPLE_MS;
    while (performance.now() < deadline) {
      const start = performance.now();
      await plugin.callState(sessions[stateLatencies.length % sessions.length].id);
      stateLatencies.push(performance.now() - start);
      await new Promise((r) => setTimeout(r, 5));
    }
    clearInterval(timer);
    const lags = sampler.stop();
    const usage = process.cpuUsage(started);
    const rssEnd = process.memoryUsage();
    const sizeAfter = (() => { try { return statSync(usageFile).size; } catch { return 0; } })();
    // 保存次数：仅统计实际发生写入的窗口（事件速率 0 时应当为 0 次重写）
    saves = sizeAfter !== sizeBefore ? 1 : 0;
    return {
      clients, rate, suppliers, days,
      state: { samples: stateLatencies.length, ...percentiles(stateLatencies) },
      eventLoopLagMs: { ...percentiles(lags) },
      cpuMs: { user: +(usage.user / 1000).toFixed(1), system: +(usage.system / 1000).toFixed(1) },
      rssMb: { start: +(rssStart.rss / 1048576).toFixed(1), end: +(rssEnd.rss / 1048576).toFixed(1) },
      heapUsedMb: { start: +(rssStart.heapUsed / 1048576).toFixed(1), end: +(rssEnd.heapUsed / 1048576).toFixed(1) },
      events: eventsSent, providerQueries: stub.calls.total, maxQueryConcurrency: stub.calls.max,
      usageFile: { bytesBefore: sizeBefore, bytesAfter: sizeAfter, rewritten: saves },
    };
  } finally {
    await plugin.cleanup();
    stub.restore();
  }
}

const report = {
  kind: "runtime", node: process.version, platform: `${process.platform} ${process.arch}`,
  cpu: (await import("node:os")).cpus()[0]?.model || "unknown",
  generatedAt: new Date().toISOString(), quick,
  warmupMs: WARMUP_MS, sampleMs: SAMPLE_MS, cases: [], lifecycle: [],
};
for (const clients of CLIENTS) {
  for (const rate of RATES) {
    const result = await runCase({ clients, rate, suppliers: SUPPLIERS, days: DAYS });
    report.cases.push(result);
    log(`客户端 ${String(clients).padStart(2)} / 事件 ${String(rate).padStart(3)} 次/秒：`
      + `state p50 ${result.state.p50} ms p95 ${result.state.p95} ms p99 ${result.state.p99} ms · `
      + `事件循环 p95 ${result.eventLoopLagMs.p95} ms · RSS ${result.rssMb.start}→${result.rssMb.end} MB · `
      + `查询并发峰 ${result.maxQueryConcurrency} · 用量文件重写 ${result.usageFile.rewritten}`);
  }
}

// 生命周期：多轮挂载/卸载后的句柄与内存残留（不以单次 RSS 判定泄漏）
if (!quick) {
  const before = { handles: process._getActiveHandles?.().length ?? null, rss: +(process.memoryUsage().rss / 1048576).toFixed(1) };
  for (let i = 0; i < 5; i++) {
    const plugin = mountPlugin();
    await new Promise((r) => setTimeout(r, 120));
    await plugin.callState("lifecycle");
    await plugin.cleanup();
  }
  await new Promise((r) => setTimeout(r, 200));
  const after = { handles: process._getActiveHandles?.().length ?? null, rss: +(process.memoryUsage().rss / 1048576).toFixed(1) };
  report.lifecycle.push({ mounts: 5, ...before, afterHandles: after.handles, afterRss: after.rss,
    handleDelta: before.handles === null ? null : after.handles - before.handles });
  log(`生命周期：5 轮挂载/卸载后句柄 ${before.handles} → ${after.handles}，RSS ${before.rss} → ${after.rss} MB`);
}
if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
else log("\n说明：本机合成负载与固定供应商响应，不代表真实计费账户或真实浏览器延迟。");
