// test/mock-dsh.mjs — 宿主半集成冒烟（mock Cordis ctx + fetch，真实调度/路由/自动探测代码）
// 用法：node test/mock-dsh.mjs
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const NS = "quota-monitor";
// 初始：三家都未配置（模拟新装插件），等待自动探测接入
const BACKING = {
  suppliers: {
    deepseek: { enabled: false, apiKey: "", baseUrl: "https://api.deepseek.com", warnPct: 80, critPct: 95 },
    opencode: { enabled: false, apiKey: "", allowanceToken: "", baseUrl: "https://opencode.ai", warnPct: 80, critPct: 95 },
    commandcode: { enabled: false, apiKey: "", baseUrl: "https://api.commandcode.ai", warnPct: 80, critPct: 95 },
  },
  intervalSeconds: 60,
  trafficWindowHours: 24,
};
let resolved = structuredClone(BACKING);
const userLayer = { suppliers: {} };

// 模拟 Schemastery 返回的只读配置：探测补丁只能经 settings.update 持久化，
// 任何对 runtime.config 的原地修改都会在这里抛 TypeError（回归护栏）
const deepFreeze = (o) => {
  if (!o || typeof o !== "object" || Object.isFrozen(o)) return o;
  for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
};
const frozenView = () => deepFreeze(structuredClone(resolved));

// 模拟真实 DSH（~/.dsh/settings.yaml + .credentials.yaml）：
//   - llm-pi-ai.providers.opencode-go / commandcode-goat（用户添加的 OpenCode/Command Code）
//   - llm-deepseek 无 user 层，但 DEEPSEEK_API_KEY 存在 DSH 凭据库（source=file）
//   - openrouter 已添加但本插件暂不支持 → detectedUnmapped
const HARNESS = {
  "llm-deepseek": { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
  "llm-pi-ai": {
    providers: {
      "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
      "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
    },
  },
};
// DSH settings describe() 的 user 层：llm-pi-ai 是用户配置文档；llm-deepseek 没有 user 层
const harnessUser = {
  "llm-pi-ai": {
    providers: {
      "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
      "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
      openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1" },
    },
  },
};

const ctx = {
  settings: {
    register: (ns, schema, opts) => {
      assert.equal(ns, NS);
      return {
        get: () => frozenView(),
        watch: (cb) => {
          ctx._watch = cb;
          return () => {};
        },
        describe: () => ({ user: userLayer }),
      };
    },
    get: (ns) => (HARNESS[ns] ? { ...HARNESS[ns] } : undefined),
    describe: (opts = {}) => [
      { ns: NS, value: resolved, user: userLayer },
      { ns: "llm-deepseek", value: HARNESS["llm-deepseek"], user: undefined },
      { ns: "llm-pi-ai", value: HARNESS["llm-pi-ai"], user: harnessUser["llm-pi-ai"] },
    ],
    update: async (ns, patch) => {
      const merge = (dst, src) => {
        for (const [k, v] of Object.entries(src)) {
          if (v && typeof v === "object" && !Array.isArray(v)) merge(dst[k] ??= {}, v);
          else dst[k] = v;
        }
      };
      merge(resolved, patch);
      merge(userLayer, patch);
      ctx._watch?.(frozenView());
    },
  },
  get: (name) =>
    name === "credentials"
      ? { resolve: async (ref) => ({ value: "file-sk-" + ref, source: "file" }) }
      : undefined,
  webServer: { register: (route) => { ctx._routes.push(route); return () => {}; } },
  on: (name, cb) => { (ctx._events[name] ??= []).push(cb); return () => {}; },
  _routes: [],
  _events: {},
};

// Mock 供应商服务器（记录调用，供密钥回退断言）
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), auth: opts?.headers?.authorization || null });
  const u = String(url);
  if (u.includes("user/balance")) return { ok: true, status: 200, text: async () => JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "66.60" }] }) };
  if (u.includes("zen/go/v1/usage")) return { ok: false, status: 404, text: async () => "" };
  return { ok: false, status: 401, text: async () => "" };
};

const dispose = apply(ctx);
await new Promise((r) => setTimeout(r, 400)); // 首轮 tick + 自动探测填入

// 模拟真实 DSH 启动时派发 llm/adapters-updated（拓扑变更；不是流量观测信号）
for (const cb of ctx._events["llm/adapters-updated"] ?? []) cb();

// ---- 自动探测：harness 里已添加的三家供应商都被自动填入 ----
assert.equal(resolved.suppliers.deepseek.enabled, true, "凭据库有 DEEPSEEK_API_KEY → 自动启用 deepseek");
assert.equal(resolved.suppliers.deepseek.autoSource, "llm-deepseek");
assert.equal(resolved.suppliers.opencode.enabled, true, "pi-ai opencode-go → 自动启用 opencode");
assert.equal(resolved.suppliers.opencode.autoSource, "llm-pi-ai");
assert.equal(resolved.suppliers.opencode.autoApiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal(resolved.suppliers.commandcode.enabled, true, "pi-ai commandcode-goat → 自动启用 commandcode");
assert.equal(resolved.suppliers.commandcode.autoSource, "llm-pi-ai");
assert.equal(resolved.suppliers.commandcode.autoApiKeyEnv, "COMMANDCODE_GOAT_API_KEY");
assert.equal(resolved.suppliers.commandcode.baseUrl, "https://api.commandcode.ai/provider/v1", "Base URL 跟随 DSH");
assert.equal(resolved.suppliers.deepseek.apiKey, "file-sk-DEEPSEEK_API_KEY", "API Key 本体自动填入插件 settings");
assert.equal(resolved.suppliers.opencode.apiKey, "file-sk-OPENCODE_GO_API_KEY");
assert.equal(resolved.suppliers.commandcode.apiKey, "file-sk-COMMANDCODE_GOAT_API_KEY");
const dsCall = calls.find((c) => c.url.includes("user/balance"));
assert.ok(dsCall, "自动填入后应发起余额查询");
assert.equal(dsCall.auth, "Bearer file-sk-DEEPSEEK_API_KEY", "取数使用的是自动填入的密钥（与 DSH 凭据库一致）");
console.log("✓ 自动探测：deepseek/opencode/commandcode 全部自动启用 + baseUrl + API Key 自动填入");

// ---- 路由表 ----
const paths = ctx._routes.map((r) => r.path);
assert.deepEqual(paths, ["/api/quota-monitor/state", "/api/quota-monitor/refresh", "/api/quota-monitor/test", "/api/quota-monitor/settings"]);

const call = async (path, body) => {
  const route = ctx._routes.find((r) => r.path === path);
  let status = 0;
  let payload = null;
  const res = { writeHead: (s) => { status = s; }, end: (d) => { payload = JSON.parse(d); } };
  const req = { headers: { origin: "" }, on: (ev, cb) => { if (ev === "data") { if (body) cb(JSON.stringify(body)); } if (ev === "end") cb(); } };
  await route.handler(req, res);
  return { status, payload };
};

// ---- state ----
const s1 = await call("/api/quota-monitor/state");
assert.equal(s1.status, 200);
const ds = s1.payload.suppliers.find((s) => s.id === "deepseek");
assert.equal(ds.state, "ok");
assert.equal(ds.headline.amt, "¥66.60");
// 只有真实 session/event 才置位 channelAlive：adapters-updated 之后仍按启用清单兜底
assert.equal(ds.current, true, "冷启动未调用时小组件应兜底显示启用供应商");
assert.equal(ds.keySet, true, "API Key 已自动填入插件 settings");
assert.equal(ds.envKeySet, true);
assert.equal(ds.autoDetected, true);
assert.equal(ds.autoKeySource, "file");
const oc = s1.payload.suppliers.find((s) => s.id === "opencode");
assert.equal(oc.autoDetected, true);
assert.equal(oc.keySet, true);
assert.equal(oc.envKeySet, true);
assert.equal(oc.state, "err");
const cc = s1.payload.suppliers.find((s) => s.id === "commandcode");
assert.equal(cc.autoDetected, true);
assert.equal(cc.keySet, true);
assert.equal(cc.autoEnvName, "COMMANDCODE_GOAT_API_KEY");
assert.equal(cc.state, "err");
assert.deepEqual(s1.payload.detectedUnmapped.map((u) => u.route), ["openrouter"], "pi-ai 已添加但未支持的路由应进入 detectedUnmapped");
const det = s1.payload.detect;
assert.equal(det.error, null, "探测无异常");
assert.deepEqual([...det.found].sort(), ["commandcode", "deepseek", "opencode"], "探测命中三家供应商");
assert.ok(det.candidates.some((c) => c.route === "opencode-go" && c.keySource === "file"));
assert.equal(det.credentialsPresent, true);
console.log("✓ state：deepseek ok（autoKeySource=file）、opencode/commandcode 自动接入、detectedUnmapped=[openrouter]、detect 诊断正常");

// ---- 流量兜底（用户报告「小组件信息消失」）：有事件但无任何可用近期流量 → 按启用清单显示 ----
const emit = (e) => { for (const cb of ctx._events["session/event"]) cb(null, e); };
emit({ type: "assistant/message", data: { source: { provider: "unknown-route-xyz", model: "m" }, usage: { uncachedInputTokens: 1, outputTokens: 1 } } });
const sX = await call("/api/quota-monitor/state");
assert.equal(sX.payload.trafficStale, true, "无近期可用流量时应标记 trafficStale");
for (const id of ["deepseek", "opencode", "commandcode"]) {
  assert.equal(sX.payload.suppliers.find((s) => s.id === id).current, true, id + " 应兜底按启用清单显示");
}
console.log("✓ 流量兜底：无近期可用流量时小组件按启用清单显示（trafficStale=true）");
emit({ type: "assistant/message", data: { source: { provider: "deepseek-official", model: "deepseek-v3" }, usage: { uncachedInputTokens: 1000, outputTokens: 500 } } });
const s2 = await call("/api/quota-monitor/state");
assert.equal(s2.payload.suppliers.find((s) => s.id === "deepseek").todayTokens, 1500);
assert.equal(s2.payload.suppliers.find((s) => s.id === "deepseek").current, true);
console.log("✓ session/event 折叠：当日 1500 tokens");

// ---- 用户显式关闭后不被自动探测再次启用（用自动接入的 opencode 验证） ----
await call("/api/quota-monitor/settings", { suppliers: { opencode: { enabled: false } } });
await new Promise((r) => setTimeout(r, 3500)); // 等自动探测周期复查
assert.equal(resolved.suppliers.opencode.enabled, false, "用户显式关闭后自动探测不得重新启用");
console.log("✓ 用户显式关闭 → 自动探测尊重关闭");

// ---- settings 热更新 ----
await call("/api/quota-monitor/settings", { intervalSeconds: 30, suppliers: { commandcode: { enabled: true, apiKey: "sk-cc" }, deepseek: { enabled: true, apiKey: "" } } });
assert.equal(resolved.intervalSeconds, 30);
assert.equal(resolved.suppliers.commandcode.enabled, true);
const s3 = await call("/api/quota-monitor/state");
assert.equal(s3.payload.poll.intervalSeconds, 30);
console.log("✓ settings 路由深合并生效（interval=30，commandcode 启用）");

// ---- test 路由：401 → ok:false auth ----
const t = await call("/api/quota-monitor/test", { supplier: "commandcode" });
assert.equal(t.payload.ok, false);
assert.match(t.payload.error || "", /401/);
console.log("✓ test 路由：commandcode 401 →", t.payload.error);

// ---- refresh 路由（deepseek 强制刷新成功）----
const r = await call("/api/quota-monitor/refresh");
assert.equal(r.payload.suppliers.find((s) => s.id === "deepseek").state, "ok");
assert.equal(r.payload.history.filter((h) => h.supplier === "deepseek").length >= 1, true);
console.log("✓ refresh 路由 + 刷新历史记录");

dispose();
console.log("\n宿主半集成测试全部通过 ✔");

