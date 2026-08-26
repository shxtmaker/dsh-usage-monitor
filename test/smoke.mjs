// test/smoke.mjs — 数据层冒烟测试（Mock fetch，无网络）
// 用法：node test/smoke.mjs
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

const FIXTURES = {
  "user/balance": { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "100.00", granted_balance: "20.00", topped_up_balance: "80.00" }] },
  "zen/go/v1/usage": {
    usage: {
      rolling: { status: "ok", percent: 72, resetsAt: "2025-08-26T10:00:00Z" },
      weekly: { status: "ok", percent: 85, resetsAt: "2025-08-28T00:00:00Z" },
      monthly: { status: "ok", percent: 41, resetsAt: "2025-08-31T16:00:00Z" },
    },
  },
  "api/go/status": { meters: [{ kind: "auto", resetsAt: "2025-09-01T00:00:00Z", limitMicroCents: 50_000_000, remainingMicroCents: 26_500_000 }] },
  "alpha/whoami": { org: { id: "org_1" } },
  "alpha/billing/credits": {
    credits: { planId: "individual-pro", monthlyCredits: 12.5, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: { limited: true, fiveHour: { used: 2.0, cap: 10.0, resetAt: "2025-08-26T05:00:00Z" }, weekly: { used: 8.5, cap: 30.0, resetAt: "2025-09-01T00:00:00Z" } },
  },
  "alpha/billing/subscriptions": { data: { planId: "individual-pro", status: "active", currentPeriodStart: "2025-08-01T00:00:00Z", currentPeriodEnd: "2025-09-01T00:00:00Z" } },
  "alpha/usage/summary": { totalCost: 17.5 },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const key = Object.keys(FIXTURES).find((k) => u.includes(k));
  if (!key) return { ok: false, status: 404, text: async () => "not found" };
  return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURES[key]) };
};

const cfg = (over = {}) => ({ apiKey: "sk-test", warnPct: 80, critPct: 95, ...over });

// DeepSeek：余额展示
const ds = await PROVIDERS.deepseek.query(cfg());
assert.equal(ds.state, "ok");
assert.equal(ds.headline.amt, "¥100.00");
assert.equal(ds.entries.length, 1);
assert.equal(ds.entries[0].pct, null);
assert.match(ds.entries[0].note, /到账/);
console.log("✓ deepseek 余额:", ds.headline.amt, "| note:", ds.entries[0].note);

// OpenCode：3 窗口 + allowance，最紧 85% → warn
const oc = await PROVIDERS.opencode.query(cfg({ allowanceToken: "oatok", orgId: "org-x" }));
assert.equal(oc.entries.length, 4);
assert.equal(oc.state, "warn");
assert.equal(oc.headline.pct, "85%");
const allowance = oc.entries.find((e) => e.name.startsWith("allowance"));
assert.equal(allowance.remain, "$26.50");
console.log("✓ opencode 窗口 + allowance:", oc.headline.pct, "| allowance 剩", allowance.remain);

// Command Code：5h/weekly 窗口 + 月额度（API 月剩余优先）
const cc = await PROVIDERS.commandcode.query(cfg());
assert.equal(cc.entries.length, 3);
assert.equal(cc.state, "ok");
const monthly = cc.entries.find((e) => e.name.startsWith("月额度"));
assert.equal(monthly.remain, "$12.50");
assert.equal(monthly.pct, 58);
assert.equal(monthly.note, "订阅 active");
console.log("✓ commandcode:", cc.entries.map((e) => e.name + ":" + e.pct + "%").join(" | "));

// DSH 自动填入的聊天网关 baseURL（带路径）→ 应收敛到同源根路径 /alpha/*
const ccGw = await PROVIDERS.commandcode.query(cfg({ baseUrl: "https://api.commandcode.ai/provider/v1" }));
assert.equal(ccGw.state, "ok");
assert.equal(ccGw.entries.length, 3);
assert.ok(ccGw.entries[0].name.startsWith("5h 窗口"));
console.log("✓ commandcode DSH 网关 baseURL（/provider/v1）→ 收敛 origin 取数成功");

// 失败路径：401 → err/auth
globalThis.fetch = async (url) => {
  if (String(url).includes("user/balance")) return { ok: false, status: 401, text: async () => "" };
  return { ok: false, status: 404, text: async () => "" };
};
const dsBad = await PROVIDERS.deepseek.query(cfg());
assert.equal(dsBad.state, "err");
assert.equal(dsBad.error.code, "auth");
console.log("✓ deepseek 401 →", dsBad.error.code, dsBad.error.message);

// 未配置 Key → off
const dsOff = await PROVIDERS.deepseek.query({ apiKey: "" });
assert.equal(dsOff.state, "off");
console.log("✓ 无 Key → off");

// 格式化
import { formatBig, formatMoney } from "../lib/providers.js";
assert.equal(formatBig(1_234_567), "1.2M");
assert.equal(formatBig(999), "999");
assert.equal(formatMoney(12.5, "USD"), "$12.50");
assert.equal(formatMoney(88.4, "CNY"), "¥88.40");
console.log("✓ 格式化：1.2M / 999 / $12.50 / ¥88.40");