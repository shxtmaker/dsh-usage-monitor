// test/usage-saves.mjs — C2 集成回归：高频相同样本不得重复写盘
// 用法：node --test test/usage-saves.mjs
//
// 真实链路：settings → session/event → createUsageRecorder → markDirty → 2s 防抖冲刷 → usage.json。
// 用最小 Cordis ctx 挂真实插件，并在 fs 层统计 usage.json 的写入次数（保存 = tmp 写 + rename；
// 短写锁写的是 *.lock，不计入）。断言：
//   - 首个样本触发恰好一次保存；
//   - 之后同一 (session, turn, step) 的相同最终样本重复数百次（流式 usage chunk 的真实节奏）
//     不再产生任何写盘，文件内容与 mtime 都不变；
//   - 真正的新增（新 step）仍然照常保存一次；
//   - 保留期变化（setRetention → dirty）依旧触发保存。
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";
import { loadUsageFile, usageFilePath } from "../lib/storage.js";

const NS = "dsh-token-quota";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- fs 层写入探针：只统计用量文件本体（tmp 写 + rename 落位） ----
const usageDirFile = (path) => /dsh-token-quota[\\/]usage\.json/.test(String(path));
const realWriteFileSync = fs.writeFileSync;
const realRenameSync = fs.renameSync;
const writes = [];
fs.writeFileSync = function patchedWriteFileSync(path, ...rest) {
  if (usageDirFile(path)) writes.push({ phase: "tmp", path: String(path) });
  return realWriteFileSync.call(this, path, ...rest);
};
fs.renameSync = function patchedRenameSync(from, to, ...rest) {
  if (usageDirFile(to)) writes.push({ phase: "rename", path: String(to) });
  return realRenameSync.call(this, from, to, ...rest);
};
syncBuiltinESMExports();

const TEST_HOME = mkdtempSync(join(tmpdir(), "qm-usage-saves-"));
process.env.DSH_HOME = TEST_HOME;
const usageFile = usageFilePath(TEST_HOME);
const sessions = new Map();
const events = [];
const routes = new Map();
const updates = [];

const config = {
  intervalSeconds: 3600, // 不触发宿主取数轮询，聚焦记账路径
  retentionDays: 7,
  suppliers: { deepseek: { enabled: false, apiKey: "sk-test", baseUrl: "https://api.deepseek.com" } },
};

const scopeValue = () => structuredClone(config);
let scopeWatch = null; // 插件 apply 时注册的 settings.watch 回调（模拟宿主热重载路径）
const ctx = {
  settings: {
    register: (ns) => {
      assert.equal(ns, NS);
      return {
        get: scopeValue,
        describe: () => ({ user: {} }),
        watch: (cb) => { scopeWatch = cb; return () => { scopeWatch = null; }; },
      };
    },
    describe: () => [],
    update: async (ns, patch) => { updates.push({ ns, patch }); },
  },
  get: (name) => (name === "credentials" ? { resolve: async () => null } : undefined),
  webServer: { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
  on: (name, cb) => { if (name === "session/event") { events.push(cb); return () => {}; } return () => {}; },
  logger: { info() {}, warn() {}, error() {} },
};

const dispose = apply(ctx);
await sleep(80); // 自动探测一轮（无 llm/credentials 接缝 → 只标 detect.at）

const emit = (session, event) => { for (const cb of events) cb(session, event); };
const session = { id: "session-saves" };
const sample = (tokens) => ({
  type: "assistant/chunk",
  data: { provider: "deepseek-official", turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: tokens, outputTokens: 0 } } },
});

writes.length = 0;
emit(session, sample(120));
await sleep(2600); // 越过 2s 防抖 + 冲刷
assert.equal(writes.length, 2, `首个样本应恰好保存一次（tmp 写 + rename），实际 ${writes.length}`);
assert.deepEqual(loadUsageFile(usageFile).deepseek, { [Object.keys(loadUsageFile(usageFile).deepseek)[0]]: 120 });
const afterFirst = JSON.stringify(loadUsageFile(usageFile));
const firstMtime = fs.statSync(usageFile).mtimeMs;

// ---- 高频相同样本：流式期间反复报告同一最终样本 ----
for (let i = 0; i < 300; i++) emit(session, sample(120));
await sleep(2600);
assert.equal(writes.length, 2, `相同样本重复 300 次后不得再写盘（实际新增 ${writes.length - 2} 次）`);
assert.equal(JSON.stringify(loadUsageFile(usageFile)), afterFirst, "文件内容必须逐字节不变");
assert.equal(fs.statSync(usageFile).mtimeMs, firstMtime, "文件不得被重新写入（mtime 不变）");

// ---- 真正的新增仍然保存 ----
emit(session, { type: "assistant/chunk", data: { provider: "deepseek-official", turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 30 } } } });
await sleep(2600);
assert.equal(writes.length, 4, "新 step 必须触发一次保存");
assert.equal(Object.values(loadUsageFile(usageFile).deepseek).reduce((a, b) => a + b, 0), 150, "总数 = 120 + 30");

// ---- 保留期变化：settings 热重载 → setRetention → dirty 独立生效 ----
// 走真实宿主路径：宿主热重载后回调 scope.watch，插件内部据此 setRetention(1)。
// 此时没有任何新事件，仍必须再保存一次（证明 C2 的去重没有吃掉保留期修剪）。
// 时间线：脏标记 → 每秒 tick 发现 → 2s 防抖 → 冲刷，故等待上界取 4.5s。
const beforeRetention = writes.length;
assert.equal(typeof scopeWatch, "function", "插件必须订阅 settings 热重载");
config.retentionDays = 1;
scopeWatch(scopeValue());
await sleep(4500);
assert.ok(writes.length > beforeRetention, "保留期变化必须仍然触发一次保存（setRetention 的 dirty 独立生效）");
assert.ok(Object.keys(loadUsageFile(usageFile).deepseek || {}).length >= 1, "修剪后仍保留当天数据");

dispose();
await sleep(50);
fs.writeFileSync = realWriteFileSync;
fs.renameSync = realRenameSync;
syncBuiltinESMExports();
rmSync(TEST_HOME, { recursive: true, force: true });
console.log("✓ C2：首个样本保存一次；相同样本 300 次不再写盘；新增/保留期变化仍保存");
