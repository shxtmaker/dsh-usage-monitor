// test/smoke.mjs — 数据层冒烟测试（Mock fetch，无网络）
// 覆盖 Token-Consumption-Monitoring docs/query-coverage.md 移植的查询方法：
// DeepSeek 多币种余额、OpenRouter Key 额度/今日费用与 Management credits、
// Moonshot 国内/国际余额、Z.ai/智谱 Coding Plan 窗口、MiniMax Token Plan 窗口、
// OpenAI/Anthropic 组织 AdminKey 用量与费用、OpenCode/Command Code 兼容来源。
// 用法：node test/smoke.mjs
import assert from "node:assert/strict";
import { PROVIDERS, resetAtMs } from "../lib/providers.js";

let fetchCount = 0;
const JSON_HEAD = { ok: true, status: 200, text: async () => "" };

// 组织统计接口只接受「最近已完成的 UTC 日」时间桶 → 夹具按当前时间生成
const orgNow = new Date();
const orgEnd = new Date(orgNow); orgEnd.setUTCHours(0, 0, 0, 0);
const orgStart = new Date(orgEnd.getTime() - 24 * 3600_000);
const orgEpoch = (d) => Math.floor(d.getTime() / 1000);
const orgOpenAi = (rows, more = false, next = null) => ({
  data: [{ start_time: orgEpoch(orgStart), end_time: orgEpoch(orgEnd), results: rows }], has_more: more, next_page: next,
});
const orgClaude = (rows) => ({
  data: [{ starting_at: orgStart.toISOString(), ending_at: orgEnd.toISOString(), results: rows }],
});

// 端点 → 响应体（URL 后缀匹配；同路径不同主机用数组形式分别命中）
const ROUTES = [
  // path, matcher(url), body
  ["/user/balance", (u) => true, { balance_infos: [
    { currency: "CNY", total_balance: "100.00", granted_balance: "20.00", topped_up_balance: "80.00" },
    { currency: "USD", total_balance: "12.50", granted_balance: "2.50", topped_up_balance: "10.00" },
  ] }],
  ["/zen/go/v1/usage", (u) => u.includes("opencode.ai"), {
    usage: {
      rolling: { status: "ok", percent: 72, resetsAt: "2025-08-26T10:00:00Z" },
      weekly: { status: "ok", percent: 85, resetsAt: "2025-08-28T00:00:00Z" },
      monthly: { status: "ok", percent: 41, resetsAt: "2025-08-31T16:00:00Z" },
    },
  }],
  ["/api/go/status", (u) => u.includes("opencode.ai"), { meters: [{ kind: "auto", resetsAt: "2025-09-01T00:00:00Z", limitMicroCents: 50_000_000, remainingMicroCents: 26_500_000 }] }],
  ["/api/v1/key", (u) => true, { data: { limit: 20, limit_remaining: 15, limit_reset: "monthly", usage: 10000, usage_daily: 2.5 } }],
  ["/api/v1/credits", (u) => true, { data: { total_credits: 100, total_usage: 30 } }],
  ["/v1/users/me/balance", (u) => u.includes("api.moonshot.cn"), { code: 0, status: true, data: { available_balance: 8.5 } }],
  ["/v1/users/me/balance", (u) => u.includes("api.moonshot.ai"), { code: 0, status: true, data: { available_balance: 42.25 } }],
  ["/api/monitor/usage/quota/limit", (u) => true, { data: { limits: [
    { type: "TOKENS_LIMIT", percentage: 25 },
    { type: "TIME_LIMIT", percentage: 10 },
    { type: "FUTURE_LIMIT", percentage: 99 },
  ] } }],
  ["/v1/token_plan/remains", (u) => true, { base_resp: { status_code: 0 }, model_remains: [
    { model_name: "general",
      current_interval_remaining_percent: 80, current_interval_usage_count: 900, current_interval_total_count: 1000,
      start_time: 1788825600000, end_time: 1788843600000,
      current_weekly_remaining_percent: 50, weekly_boost_permille: 1500,
      weekly_start_time: 1788739200000, weekly_end_time: 1789344000000 },
  ] }],
  ["/organization/usage/completions", (u) => true, orgOpenAi([
    { model: "gpt-5", input_tokens: 100, output_tokens: 32, input_cached_tokens: 85, num_model_requests: 2 },
  ])],
  ["/organization/costs", (u) => true, orgOpenAi([
    { amount: { value: 4, currency: "usd" } },
  ])],
  ["/organizations/usage_report/messages", (u) => true, orgClaude([
    { model: "claude-sonnet", uncached_input_tokens: 10, cache_read_input_tokens: 20,
      cache_creation: { ephemeral_1h_input_tokens: 30, ephemeral_5m_input_tokens: 40 }, output_tokens: 5 },
  ])],
  ["/organizations/cost_report", (u) => true, orgClaude([
    { amount: { amount: "123.78912", currency: "USD" } },
  ])],
  ["/alpha/whoami", (u) => true, { org: { id: "org_1" } }],
  ["/alpha/billing/credits", (u) => true, {
    credits: { planId: "individual-pro", monthlyCredits: 12.5 },
    // 真实样本：窗口 resetAt 为 epoch-毫秒数字（上游夹具 FromUnixTimeMilliseconds 转录）；
    // weekly 用 ISO 字符串覆盖另一容忍路径
    windowLimits: {
      fiveHour: { used: 2.0, cap: 10.0, resetAt: Date.UTC(2025, 7, 26, 5) },
      weekly: { used: 8.5, cap: 30.0, resetAt: "2025-09-01T00:00:00Z" },
    },
  }],
  ["/alpha/billing/subscriptions", (u) => true, { data: { planId: "individual-pro", status: "active", currentPeriodStart: "2025-08-01T00:00:00Z", currentPeriodEnd: "2025-09-01T00:00:00Z" } }],
  ["/alpha/usage/summary", (u) => true, { totalCost: 17.5 }],
];

function installFetch() {
  fetchCount = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCount += 1;
    const u = String(url);
    const hit = ROUTES.find(([path, match]) => u.includes(path) && match(u));
    if (!hit) return { ok: false, status: 404, text: async () => "not found" };
    return { ...JSON_HEAD, text: async () => JSON.stringify(hit[2]) };
  };
}

const cfg = (over = {}) => ({ apiKey: "sk-test", warnPct: 80, critPct: 95, ...over });

installFetch();

// DeepSeek：多币种余额
const ds = await PROVIDERS.deepseek.query(cfg());
assert.equal(ds.state, "ok");
assert.equal(ds.entries.length, 2, "多币种保留全部币种");
assert.equal(ds.headline.amt, "¥100.00 · $12.50");
assert.match(ds.entries[0].note, /到账/);
console.log("✓ deepseek 多币种余额:", ds.headline.amt);

// OpenRouter：普通 Key 周期额度 + 今日费用
const or = await PROVIDERS.openrouter.query(cfg());
const quota = or.entries.find((e) => e.name.includes("周期额度"));
assert.equal(quota.remain, "$15.00");
assert.equal(quota.used, "$5.00");
assert.equal(quota.pct, 25);
assert.equal(or.state, "ok");
const daily = or.entries.find((e) => e.name === "今日费用");
assert.equal(daily.used, "$2.50");
console.log("✓ openrouter Key 额度 + 今日费用:", quota.remain, "/", daily.used);

// OpenRouter：Management Key 账户 credits
const orAcc = await PROVIDERS["openrouter-account"].query(cfg());
assert.equal(orAcc.entries[0].remain, "$70.00");
console.log("✓ openrouter-account credits:", orAcc.entries[0].remain);

// Moonshot 国内/国际：币种随地域
const msCn = await PROVIDERS["moonshot-cn"].query(cfg());
assert.equal(msCn.entries[0].remain, "¥8.50");
const msIntl = await PROVIDERS["moonshot-intl"].query(cfg());
assert.equal(msIntl.entries[0].remain, "$42.25");
console.log("✓ moonshot-cn ¥8.50 / moonshot-intl $42.25");

// Z.ai / 智谱：Coding Plan 窗口（只保留 TOKENS_LIMIT / TIME_LIMIT）
const zai = await PROVIDERS.zai.query(cfg());
assert.equal(zai.entries.length, 2);
assert.deepEqual(zai.entries.map((e) => e.pct), [25, 10]);
const zaiCn = await PROVIDERS["zai-cn"].query(cfg());
assert.equal(zaiCn.state, "ok");
console.log("✓ zai/zai-cn Coding Plan 窗口:", zai.entries.map((e) => `${e.name}=${e.pct}%`).join(" | "));

// MiniMax：Token Plan 窗口（显式剩余百分比取反为已用）
const mm = await PROVIDERS.minimax.query(cfg());
assert.equal(mm.entries.length, 2);
const cur = mm.entries.find((e) => e.name.includes("当前窗口"));
assert.equal(cur.pct, 20);
const wk = mm.entries.find((e) => e.name.includes("周窗口"));
assert.equal(wk.pct, 50);
assert.match(wk.note, /1.5×/);
console.log("✓ minimax Token Plan 窗口:", mm.entries.map((e) => `${e.name}=${e.pct}%`).join(" | "));

// OpenAI 组织：用量 + 费用（同供应商合并）
const oai = await PROVIDERS["openai-org"].query(cfg());
assert.equal(oai.state, "ok");
assert.equal(oai.entries.filter((e) => e.kind === "usage").length, 2, "汇总 + 模型明细");
assert.equal(oai.entries.find((e) => e.name.includes("汇总")).used, "132");
assert.equal(oai.entries.find((e) => e.name.includes("gpt-5")).used, "132");
assert.ok(oai.entries.some((e) => e.kind === "cost" && e.used === "$4.00"));
console.log("✓ openai-org 用量(132 tokens)+费用($4.00):", oai.entries.map((e) => e.name).join(" | "));

// Anthropic 组织：缓存写入口径求和 + 美分转美元
const ant = await PROVIDERS["anthropic-org"].query(cfg());
assert.equal(ant.state, "ok");
assert.equal(ant.entries.find((e) => e.name.includes("汇总")).used, "105");
assert.equal(ant.entries.find((e) => e.kind === "cost").used, "$1.24");
console.log("✓ anthropic-org 用量(105)+费用($1.24)");

// OpenCode：3 窗口 + allowance
const oc = await PROVIDERS.opencode.query(cfg({ allowanceToken: "oatok", orgId: "org-x" }));
assert.equal(oc.entries.length, 4);
assert.equal(oc.state, "warn");
assert.equal(oc.entries.find((e) => e.name.startsWith("allowance")).remain, "$26.50");
console.log("✓ opencode 窗口 + allowance:", oc.headline.pct);

// Command Code：窗口 + 月额度（保留兼容来源；重置时间补齐：epoch-ms / ISO / 诚实缺省）
const cc = await PROVIDERS.commandcode.query(cfg());
assert.equal(cc.entries.length, 3);
assert.equal(cc.state, "ok");
const monthly = cc.entries.find((e) => e.name.startsWith("月额度"));
assert.equal(monthly.remain, "$12.50");
for (const e of cc.entries) {
  assert.notEqual(e.reset, "—", `${e.name} 应带重置时间`);
  assert.match(e.reset, /重置$/);
  assert.equal(e.note.includes("未提供重置时刻"), false);
  // 原始时刻随条目下发（客户端据此算精确倒计时 *h*m / *d*h）；文案是四舍五入过的，时刻不是
  assert.ok(Number.isFinite(e.resetAt), `${e.name} 应带 epoch-毫秒 resetAt`);
}
assert.equal(cc.entries.find((e) => e.name.includes("5h")).resetAt, Date.UTC(2025, 7, 26, 5),
  "5h 窗口的 resetAt 应是原始 epoch-毫秒（不被 formatReset 的整小时取整影响）");
assert.ok(Number.isFinite(cc.headline.resetAt), "headline 也应镜像最紧条目的 resetAt");
assert.match(monthly.note, /订阅 active/);
console.log("✓ commandcode:", cc.entries.map((e) => `${e.name}:${e.pct}% (${e.reset})`).join(" | "));

// 窗口缺 resetAt 的真实缺省路径：如实标注「未提供重置时刻」，不伪造时刻
const ccRoute = ROUTES.find(([p]) => p === "/alpha/billing/credits");
ccRoute[2].windowLimits = { fiveHour: { used: 2.0, cap: 10.0 }, weekly: { used: 8.5, cap: 30.0 } };
const ccNoReset = await PROVIDERS.commandcode.query(cfg());
for (const e of ccNoReset.entries.filter((x) => x.kind === "win" && !x.name.startsWith("月额度"))) {
  assert.equal(e.reset, "—");
  assert.equal(e.note, "未提供重置时刻");
  assert.equal(e.resetAt, null, "没有时刻就是 null——不能伪造，客户端据此回落宿主文案");
}
console.log("✓ commandcode 缺 resetAt → 诚实标注:", ccNoReset.entries.filter((e) => e.name.startsWith("5h")).map((e) => `${e.name}:${e.note}`).join(" | "));

// 端点校验：非官方主机/非默认端口/路径越界 → 不发请求
for (const [id, badBase] of [
  ["deepseek", "https://api.deepseek.com.evil.invalid"],
  ["deepseek", "https://api.deepseek.com:8443"],
  ["moonshot-cn", "https://evil.invalid/v1"],
  ["openrouter", "https://openrouter.ai?secret=x"],
  ["zai", "https://api.z.ai/not-allowed"],
]) {
  const before = fetchCount;
  const bad = await PROVIDERS[id].query(cfg({ baseUrl: badBase }));
  assert.equal(bad.state, "err");
  assert.equal(bad.error.code, "endpoint", `${id} ${badBase} 应报 endpoint`);
  assert.equal(fetchCount, before, `${id} 地址越界时不得发起网络请求`);
}
console.log("✓ 官方主机/路径/端口/查询串校验（无网络请求）");

// 失败路径：401 → err/auth；未配置 Key → off
installFetch();
globalThis.fetch = async (url) => ({ ok: false, status: 401, text: async () => "" });
const dsBad = await PROVIDERS.deepseek.query(cfg());
assert.equal(dsBad.state, "err");
assert.equal(dsBad.error.code, "auth");
const dsOff = await PROVIDERS.deepseek.query({ apiKey: "" });
assert.equal(dsOff.state, "off");
console.log("✓ 401 → err/auth；无 Key → off");

// 格式化
import { formatBig, formatMoney } from "../lib/providers.js";
assert.equal(formatBig(1_234_567), "1.2M");
assert.equal(formatBig(999), "999");
assert.equal(formatMoney(12.5, "USD"), "$12.50");
assert.equal(formatMoney(88.4, "CNY"), "¥88.40");
console.log("✓ 格式化：1.2M / 999 / $12.50 / ¥88.40");

console.log("\n数据层冒烟测试全部通过 ✔");

// 占位时刻（上游用 0 表示「无重置时刻」）必须等价于「没给」，不能被当成 1970 年的合法时刻
assert.equal(resetAtMs(new Date(0)), null, "epoch 0 是占位，不是时刻");
assert.equal(resetAtMs(0), null);
assert.equal(resetAtMs(-1), null);
assert.equal(resetAtMs(Date.UTC(2025, 7, 26, 5)), Date.UTC(2025, 7, 26, 5));
console.log("✓ resetAtMs：占位/秒级值判为无时刻，真时刻原样通过");
