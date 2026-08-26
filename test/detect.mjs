// test/detect.mjs — 自动探测单元测试（真实 detect.js 逻辑，Mock llm/settings/credentials）
// 用法：node test/detect.mjs
import assert from "node:assert/strict";
import { autoFillPatch, detectHarnessSuppliers } from "../lib/detect.js";

const BASE_URL_DEFAULTS = { deepseek: "https://api.deepseek.com", opencode: "https://opencode.ai", commandcode: "https://api.commandcode.ai" };

// ---- 场景 1：ctx.llm 目录 + 存活路由 + credentials.resolve（凭据库 source=file） ----
const settings1 = {
  get: (ns) => ({
    "llm-deepseek": { baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
    "llm-pi-ai": {
      providers: {
        deepseek: { baseURL: "https://api.deepseek.com/pi", apiKeyEnv: "DEEPSEEK_API_KEY" },
        "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" }, // 无 baseURL → 保留插件默认
        "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
        "commandcode-v2": { apiKeyEnv: "COMMANDCODE_V2_API_KEY" }, // 前缀变体，应命中 commandcode
        openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
        moonshotai: { displayName: "Moonshot" }, // 只有名字，未配置端点 → 不算已添加
      },
    },
  }[ns]),
};
const ctx1 = {
  get: (name) => (name === "llm" ? llm1 : name === "credentials" ? credentials1 : undefined),
  settings: settings1,
};
const llm1 = {
  listProviders: () => [
    { id: "deepseek-official" }, { id: "deepseek" }, { id: "opencode-go" },
    { id: "commandcode-goat" }, { id: "commandcode-v2" }, { id: "openrouter" },
  ],
  listConfigurableProviders: () => [
    { provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
    { provider: "deepseek", displayName: "DeepSeek (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "deepseek"] },
    { provider: "opencode-go", displayName: "OpenCode (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "opencode-go"] },
    { provider: "commandcode-goat", displayName: "Command Code (pi)", settingsNs: "llm-pi-ai", settingsPath: ["providers", "commandcode-goat"] },
    { provider: "commandcode-v2", displayName: "Command Code v2", settingsNs: "llm-pi-ai", settingsPath: ["providers", "commandcode-v2"] },
    { provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"] },
    { provider: "moonshotai", displayName: "Moonshot", settingsNs: "llm-pi-ai", settingsPath: ["providers", "moonshotai"] },
  ],
};
const credentials1 = {
  resolve: async (ref) => ({ value: "sk-" + ref, source: "file" }),
};

const detected1 = await detectHarnessSuppliers(ctx1, { debug: true });
assert.equal(detected1.meta.llmPresent, true, "debug meta 报告 llm 服务在位");
assert.equal(detected1.meta.credentialsPresent, true);
assert.ok(detected1.meta.liveRoutes.includes("opencode-go") && detected1.meta.liveRoutes.includes("commandcode-goat"));
assert.ok(detected1.meta.candidates.some((c) => c.route === "commandcode-goat" && c.keySource === "file"));
const bySupplier = new Map(detected1.filter((d) => d.supplier).map((d) => [d.supplier, d]));
assert.deepEqual([...bySupplier.keys()].sort(), ["commandcode", "deepseek", "opencode"], "三种供应商都应被探测到");
const ds = bySupplier.get("deepseek");
assert.equal(ds.route, "deepseek-official", "DeepSeek 官方路由优先");
assert.equal(ds.keySource, "file");
assert.equal(ds.key, "sk-DEEPSEEK_API_KEY");
const oc = bySupplier.get("opencode");
assert.equal(oc.route, "opencode-go");
assert.equal(oc.apiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal(oc.baseURL, null);
const cc = bySupplier.get("commandcode");
assert.equal(cc.route, "commandcode-goat", "精确名优先；commandcode-v2 被前缀去重");
assert.equal(cc.apiKeyEnv, "COMMANDCODE_GOAT_API_KEY");
assert.equal(cc.baseURL, "https://api.commandcode.ai/provider/v1");
const or = detected1.find((d) => d.route === "openrouter");
assert.equal(or.supplier, null, "未映射路由 supplier=null");
assert.equal(detected1.some((d) => d.route === "moonshotai"), false, "未配置端点的目录条目不算已添加");

const r1 = autoFillPatch(detected1, () => ({}), BASE_URL_DEFAULTS);
const p1 = r1.patch.suppliers;
assert.equal(p1.deepseek.enabled, true);
assert.equal(p1.deepseek.baseUrl, "https://api.deepseek.com/v1", "非默认 Base URL 跟随 DSH");
assert.equal(p1.deepseek.autoSource, "llm-deepseek");
assert.equal(p1.deepseek.apiKey, "sk-DEEPSEEK_API_KEY", "API Key 自动填入（拷贝 DSH 密钥本体）");
assert.equal(p1.opencode.enabled, true);
assert.equal(p1.opencode.autoSource, "llm-pi-ai");
assert.equal(p1.opencode.autoApiKeyEnv, "OPENCODE_GO_API_KEY");
assert.equal(p1.opencode.apiKey, "sk-OPENCODE_GO_API_KEY");
assert.equal("baseUrl" in p1.opencode, false, "DSH 侧无 baseURL 时保留插件默认");
assert.equal(p1.commandcode.enabled, true);
assert.equal(p1.commandcode.baseUrl, "https://api.commandcode.ai/provider/v1");
assert.equal(p1.commandcode.autoApiKeyEnv, "COMMANDCODE_GOAT_API_KEY");
assert.equal(p1.commandcode.apiKey, "sk-COMMANDCODE_GOAT_API_KEY");
assert.equal(r1.unfilled.find((u) => u.route === "openrouter").reason, "unsupported");

// 手动接管：已有 apiKey → 不动
const rManual = autoFillPatch(detected1, () => ({ apiKey: "sk-manual" }), BASE_URL_DEFAULTS);
assert.deepEqual(rManual.patch.suppliers, {});
// 用户显式关闭 → skipSupplier（只跳过 deepseek，其余照常自动填）
const rSkip = autoFillPatch(detected1, () => ({}), BASE_URL_DEFAULTS, { skipSupplier: (id) => id === "deepseek" });
assert.equal("deepseek" in rSkip.patch.suppliers, false, "显式关闭的供应商不得再被自动启用");
assert.ok(rSkip.patch.suppliers.opencode && rSkip.patch.suppliers.commandcode, "其余未关闭供应商照常自动填");
console.log("✓ detect：目录+凭据解析、官方优先去重、opencode/commandcode 变体路由映射、API Key 自动填入");

// ---- 场景 2：无 ctx.llm（配置文档兜底）+ 环境变量密钥 ----
process.env.DEEPSEEK_API_KEY = "env-sk-ds";
process.env.OPENCODE_GO_API_KEY = "env-sk-oc";
process.env.COMMANDCODE_GOAT_API_KEY = "env-sk-cc";
const ctx2 = {
  settings: {
    get: (ns) => ({
      "llm-deepseek": { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" },
      "llm-pi-ai": {
        providers: {
          "opencode-go": { apiKeyEnv: "OPENCODE_GO_API_KEY" },
          "commandcode-goat": { apiKeyEnv: "COMMANDCODE_GOAT_API_KEY", baseURL: "https://api.commandcode.ai/provider/v1" },
          openrouter: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
        },
      },
    }[ns]),
  },
};
const detected2 = await detectHarnessSuppliers(ctx2);
const sup2 = new Map(detected2.filter((d) => d.supplier).map((d) => [d.supplier, d]));
assert.deepEqual([...sup2.keys()].sort(), ["commandcode", "deepseek", "opencode"]);
assert.equal(sup2.get("deepseek").keySource, "env");
assert.equal(sup2.get("opencode").key, "env-sk-oc");
assert.equal(sup2.get("commandcode").key, "env-sk-cc");
assert.equal(detected2.find((d) => d.route === "openrouter").supplier, null);
console.log("✓ detect 兜底：无 llm 服务时按 llm-deepseek/llm-pi-ai 配置节枚举，多供应商映射+环境密钥");

// ---- 场景 3：无密钥的已配置路由 → 不自动启用但填入引用 ----
const noKey = [{ ...sup2.get("deepseek"), route: "deepseek", ns: "llm-pi-ai", path: ["providers", "deepseek"], key: null, keyPresent: false, keySource: null }];
const r3 = autoFillPatch(noKey, () => ({}), BASE_URL_DEFAULTS);
assert.equal(r3.patch.suppliers.deepseek.enabled, undefined, "无密钥不自动启用");
assert.equal("apiKey" in r3.patch.suppliers.deepseek, false, "无密钥不复制");
assert.equal(r3.patch.suppliers.deepseek.autoSource, "llm-pi-ai");
assert.equal(r3.unfilled[0].reason, "no-key");
console.log("✓ autoFillPatch：无密钥 → 只填引用、不启用，记 unfilled.no-key");

console.log("\n自动探测单元测试全部通过 ✔");