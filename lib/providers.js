// lib/providers.js — 数据层（供应商注册表，元数据驱动）
//
// 移植自 Token-Consumption-Monitoring（Gitea lqy/Token-Consumption-Monitoring）main
// 「统一查询方法」架构下 docs/query-coverage.md（1.3.x）的官方查询覆盖，只保留纯 HTTP
// 方法；Windows 专属方法（WebView2 控制台、本地 SQLite、本机 Codex CLI 登录）按规格丢弃。
//
// 供应商按「凭据类别 × 地域」拆分（与上游「一个页面保存一种凭据」对应）：
//   - api-key（普通 Key，可从 DSH harness 密钥自动识别）
//       deepseek       DeepSeek 余额（多币种，严格官方地址校验）
//       moonshot-cn    Moonshot 国内余额  api.moonshot.cn（CNY）
//       moonshot-intl  Moonshot 国际余额  api.moonshot.ai（USD）
//       zai            Z.ai Coding Plan   api.z.ai（Authorization 原样）
//       zai-cn         智谱 Coding Plan   open.bigmodel.cn（CN）
//       minimax        MiniMax Token Plan www.minimax.io（国际）
//       minimax-cn     MiniMax Token Plan www.minimaxi.com（CN）
//       openrouter     OpenRouter 普通 Key：周期额度 + 今日报告费用
//   - management-key（Management Key，DSH 无此类接缝 → 手动配置）
//       openrouter-account  OpenRouter 账户 credits
//   - admin-key（Admin Key，DSH 无此类接缝 → 手动配置）
//       openai-org     OpenAI 组织用量/费用（最近完整 UTC 日，分页）
//       anthropic-org  Anthropic 组织用量/费用（x-api-key + anthropic-version）
//   - 私有兼容来源（继续支持，标记 compat；上游列为有条件/私有路径）
//       opencode        OpenCode Go 5h/周/月窗口 + allowance
//       commandcode     Command Code 5h/周窗口 + 套餐月额度
//
// 每个 query(cfg) 返回归一化结构：
//   { state: 'ok'|'warn'|'crit'|'err'|'off', error?: {code, message},
//     entries: [{name, kind:'win'|'bal'|'usage'|'cost', limit, used, remain, pct, reset, note}],
//     headline: {kind:'pct'|'amt', pct?, amt?, reset} }
//
// 安全与解析边界（对齐上游 docs/query-coverage.md「数据与安全边界」）：
//   - 官方方法只接受对应 HTTPS 主机 + 已知基础路径，拒绝端口/用户信息/查询参数/重定向；
//     地址不匹配时不发送请求。
//   - 缺字段/越界桶/重复游标/业务错误不转成零值；分页失败不发布已累计的部分总数。
//   - 无限额度/未知余额保留为未知（null），不冒充 0。

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 100;

// ---------- 通用工具 ----------

/** 规约 URL 为 https://host（忽略路径），仅用于「兼容来源」的 baseUrl 收敛。 */
function deriveServer(baseUrl, fallback) {
  try {
    const url = new URL(baseUrl);
    if (url.host) return `${url.protocol}//${url.host}`;
  } catch {
    /* 忽略 */
  }
  return fallback;
}

/** 把 fetch 错误归一化为带 code 的 Error；code ∈ auth|schema|network|http:N。 */
async function httpJson(url, { auth = "bearer", key = "", extraHeaders = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { ...extraHeaders };
  if (key && auth === "bearer") headers.authorization = `Bearer ${key}`;
  else if (key && auth === "x-api-key") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  } else if (key && auth === "raw") headers.authorization = key; // Z.ai：第一方插件 Authorization 原样不带 Bearer
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: "error", // 拒绝重定向（官方查询安全边界）
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) err.code = "auth";
      else err.code = `http:${response.status}`;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error.name === "AbortError") {
      const err = new Error("请求超时");
      err.code = "network";
      throw err;
    }
    if (error.code) throw error;
    if (error.name === "TypeError") {
      // fetch redirect:'error' 与纯网络错误都可能落到 TypeError
      const err = new Error("网络错误或重定向被拒绝");
      err.code = "network";
      throw err;
    }
    if (error instanceof SyntaxError) {
      const err = new Error("响应不是有效 JSON");
      err.code = "schema";
      throw err;
    }
    const err = new Error(error.message || "网络错误");
    err.code = "network";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 校验官方端点：https + 默认端口 + 无 userinfo/query/hash + 主机与基础路径白名单。 */
function officialEndpoint(baseUrl, { hosts, basePaths, defaultBase }) {
  const fallback = { origin: null, error: { code: "endpoint", message: `Base URL 需为官方 HTTPS 地址（${hosts.join(" / ")}）` } };
  try {
    // 未配置 baseUrl 时使用供应商官方默认地址（注册表默认）；显式配置的越界地址仍被拒绝
    const url = new URL(String((baseUrl || "").trim() || defaultBase));
    const host = url.hostname.toLowerCase();
    const isHttps = url.protocol === "https:";
    const defaultPort = !url.port || (url.protocol === "https:" && url.port === "443");
    if (!isHttps || !defaultPort) return fallback;
    if (url.username || url.password || url.search || url.hash) return fallback;
    if (!hosts.includes(host)) return fallback;
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    if (!basePaths.includes(basePath)) return fallback;
    return { origin: url.origin, error: null };
  } catch {
    return fallback;
  }
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // epoch-毫秒数字（Command Code windowLimits.resetAt 真实载荷为毫秒时间戳）
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const s = value.trim();
    const d = /^\d{12,14}$/.test(s) ? new Date(Number(s)) : new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function parseEpochMs(value) {
  const n = parseNumber(value);
  if (n === null) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 依据 pct（已用百分比）与阈值归并条目，得出供应商状态。 */
function stateFromPct(pct, warnPct, critPct) {
  if (pct === null || pct === undefined) return "ok";
  if (pct >= critPct) return "crit";
  if (pct >= warnPct) return "warn";
  return "ok";
}

/** 重置时间人话化：「约 X 小时后重置」/「M月D日 重置」。 */
export function formatReset(resetsAt) {
  if (!resetsAt) return "—";
  const target = new Date(resetsAt);
  const diffMs = target.getTime() - Date.now();
  if (diffMs > 0 && diffMs < 48 * 3600 * 1000) {
    const hours = Math.max(1, Math.round(diffMs / 3600_000));
    return `约 ${hours} 小时后重置`;
  }
  return `${target.getMonth() + 1}月${target.getDate()}日 重置`;
}

/** 金额格式化：两位小数 + 千分位。 */
export function formatMoney(value, currency = "") {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency && currency !== "USD" && currency !== "CNY"
    ? `${formatted} ${currency}`
    : `${currencySymbol(currency)}${formatted}`;
}

function currencySymbol(currency) {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return "";
}

const SYMBOLS = [
  { value: 1, symbol: "" },
  { value: 1e3, symbol: "K" },
  { value: 1e6, symbol: "M" },
  { value: 1e9, symbol: "B" },
];

/** 大数缩写（≥10 万用 K/M 缩写；级内千分位）。 */
export function formatBig(value, unit = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  let scale = SYMBOLS[0];
  for (const s of SYMBOLS) {
    if (abs >= s.value) scale = s;
  }
  if (scale.value === 1) return `${Math.round(n).toLocaleString()}${unit && ` ${unit}`}`;
  return `${(n / scale.value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${scale.symbol}${unit && ` ${unit}`}`;
}

/** Token/请求数友好文本。 */
const tokensText = (n) => (n === null || n === undefined ? "—" : `${formatBig(n)}`);

function makePctHeadline(tightest, entries) {
  if (tightest === null) {
    const bal = entries.find((e) => e.kind === "bal");
    if (bal) return { kind: "amt", amt: bal.remain, reset: bal.reset };
    const usage = entries.find((e) => e.kind === "usage" || e.kind === "cost");
    if (usage) return { kind: "amt", amt: usage.used, reset: usage.reset };
    return { kind: "pct", pct: null, amt: "—", reset: "—" };
  }
  const tight = entries.find((e) => e.pct === tightest) || entries[0];
  return { kind: "pct", pct: `${tightest}%`, amt: `余 ${tight.pct === null || tight.kind === "bal" ? tight.remain : `${100 - tightest}%`}`, reset: tight.reset };
}

function offResult(message = "未配置 API Key") {
  return { state: "off", error: { code: "auth", message }, entries: [], headline: { kind: "amt", amt: "未配置" } };
}

function errResult(code, message) {
  return { state: "err", error: { code, message }, entries: [], headline: { kind: "amt", amt: "—" } };
}

function wrapQuery(fn, missingKey = () => false) {
  return async (cfg) => {
    try {
      if (missingKey(cfg)) return offResult("未配置所需密钥");
      return await fn(cfg);
    } catch (error) {
      return errResult(error.code || "network", error.message || "网络错误");
    }
  };
}

// ---------- DeepSeek：余额（严格官方地址 + 多币种） ----------

const DEEPSEEK = { hosts: ["api.deepseek.com"], basePaths: ["", "/v1"] };

const queryDeepSeek = wrapQuery(async (cfg) => {
  const { origin, error } = officialEndpoint(cfg.baseUrl, { ...DEEPSEEK, defaultBase: "https://api.deepseek.com" });
  if (error) return errResult(error.code, error.message);
  const body = await httpJson(`${origin}/user/balance`, { auth: "bearer", key: cfg.apiKey });
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (!infos.length) return errResult("schema", "余额接口未返回数据");
  const entries = [];
  const currencyToAmount = new Map(); // 多币种并存，保留全部币种
  for (const info of infos) {
    const balance = parseNumber(info?.total_balance);
    const currency = info?.currency || "CNY";
    if (balance === null) continue;
    const note = [];
    const topped = parseNumber(info.topped_up_balance);
    const granted = parseNumber(info.granted_balance);
    if (topped !== null) note.push(`到账 ${formatMoney(topped, currency)}`);
    if (granted !== null) note.push(`赠送 ${formatMoney(granted, currency)}`);
    entries.push({
      name: `余额 · ${currency}`,
      kind: "bal",
      limit: "—",
      used: "—",
      remain: formatMoney(balance, currency),
      pct: null,
      reset: "—",
      note: note.join(" · "),
    });
    if (!currencyToAmount.has(currency)) currencyToAmount.set(currency, balance);
  }
  if (!entries.length) return errResult("schema", "余额接口未返回可用数据");
  const headlineAmt = [...currencyToAmount.entries()].map(([c, v]) => formatMoney(v, c)).join(" · ");
  return { state: "ok", entries, headline: { kind: "amt", amt: headlineAmt, reset: "—" } };
}, (cfg) => !cfg.apiKey);

// ---------- OpenRouter：普通 Key 周期额度 + 今日费用 ----------

const OPENROUTER = { hosts: ["openrouter.ai"], basePaths: ["", "/api", "/api/v1"] };

const OPENROUTER_PERIOD = { daily: "每日重置", weekly: "每周重置", monthly: "每月重置", null: "无周期重置" };

const queryOpenRouter = wrapQuery(async (cfg) => {
  const { origin, error } = officialEndpoint(cfg.baseUrl, { ...OPENROUTER, defaultBase: "https://openrouter.ai/api/v1" });
  if (error) return errResult(error.code, error.message);
  const body = await httpJson(`${origin}/api/v1/key`, { key: cfg.apiKey });
  const data = body?.data;
  if (!data || typeof data !== "object") return errResult("schema", "OpenRouter 响应缺少 data");
  const entries = [];
  let tightest = null;
  // 周期额度：无限额度（limit/remaining 均缺省）是合法状态，保留未知不冒充 0。
  const limit = parseNumber(data.limit);
  const remaining = parseNumber(data.limit_remaining);
  if (limit !== null || remaining !== null) {
    if (limit !== null && limit < 0) return errResult("schema", "OpenRouter 额度上限无效");
    const period = OPENROUTER_PERIOD[data.limit_reset] ?? "服务方定义的周期";
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null;
    const pct = limit !== null && remaining !== null && limit > 0
      ? Math.min(100, Math.round((used / limit) * 100))
      : null;
    entries.push({
      name: `周期额度 · ${period}`,
      kind: "bal",
      limit: limit === null ? "无限" : formatMoney(limit, "USD"),
      used: used === null ? "—" : formatMoney(used, "USD"),
      remain: remaining === null ? "—" : formatMoney(remaining, "USD"),
      pct,
      reset: "—",
      note: limit === null ? "公开契约允许无限额度" : "",
    });
    if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
  }
  // 今日报告费用（usage_daily）：不把终身 usage 配到月额度。
  const daily = parseNumber(data.usage_daily);
  if (daily !== null) {
    entries.push({
      name: "今日费用",
      kind: "cost",
      limit: "—",
      used: formatMoney(daily, "USD"),
      remain: "—",
      pct: null,
      reset: "—",
      note: "当前 Key · UTC 今日报告费用",
    });
  }
  if (!entries.length) return errResult("no-data", "OpenRouter 未报告额度与今日费用");
  return { state: stateFromPct(tightest, cfg.warnPct, cfg.critPct), entries, headline: makePctHeadline(tightest, entries) };
}, (cfg) => !cfg.apiKey);

// ---------- OpenRouter：Management Key 账户 credits ----------

const queryOpenRouterAccount = wrapQuery(async (cfg) => {
  const { origin, error } = officialEndpoint(cfg.baseUrl, { ...OPENROUTER, defaultBase: "https://openrouter.ai/api/v1" });
  if (error) return errResult(error.code, error.message);
  const body = await httpJson(`${origin}/api/v1/credits`, { key: cfg.apiKey });
  const data = body?.data;
  if (!data || typeof data !== "object") return errResult("schema", "OpenRouter credits 响应缺少 data");
  const credits = parseNumber(data.total_credits);
  const used = parseNumber(data.total_usage);
  if (credits === null || used === null) return errResult("schema", "OpenRouter credits 缺少数值字段");
  const remain = credits - used;
  return {
    state: "ok",
    entries: [{ name: "账户 credits", kind: "bal", limit: "—", used: "—", remain: formatMoney(remain, "USD"), pct: null, reset: "—", note: "管理密钥 · total_credits − total_usage" }],
    headline: { kind: "amt", amt: formatMoney(remain, "USD"), reset: "—" },
  };
}, (cfg) => !cfg.apiKey);

// ---------- Moonshot 国内 / 国际：余额 ----------

function moonshotQuery(host, currency) {
  return wrapQuery(async (cfg) => {
    const { origin, error } = officialEndpoint(cfg.baseUrl, { hosts: [host], basePaths: ["", "/v1"], defaultBase: `https://${host}/v1` });
    if (error) return errResult(error.code, error.message);
    const body = await httpJson(`${origin}/v1/users/me/balance`, { key: cfg.apiKey });
    if (parseNumber(body?.code) !== 0 || body?.status !== true) return errResult("schema", "Moonshot 余额业务响应未成功");
    const available = parseNumber(body?.data?.available_balance);
    if (available === null) return errResult("schema", "Moonshot 响应缺少 available_balance");
    return {
      state: "ok",
      entries: [{ name: "可用余额", kind: "bal", limit: "—", used: "—", remain: formatMoney(available, currency), pct: null, reset: "—", note: "" }],
      headline: { kind: "amt", amt: formatMoney(available, currency), reset: "—" },
    };
  }, (cfg) => !cfg.apiKey);
}

// ---------- Z.ai / 智谱：Coding Plan 窗口（Authorization 原样，无 Bearer） ----------

const ZAI_BASE_PATHS = ["", "/api/anthropic", "/api/paas/v4", "/api/coding/paas/v4"];

function zaiQuery(host) {
  return wrapQuery(async (cfg) => {
    const { origin, error } = officialEndpoint(cfg.baseUrl, { hosts: [host], basePaths: ZAI_BASE_PATHS, defaultBase: `https://${host}/api/anthropic` });
    if (error) return errResult(error.code, error.message);
    const body = await httpJson(`${origin}/api/monitor/usage/quota/limit`, {
      auth: "raw",
      key: cfg.apiKey,
      extraHeaders: { "accept-language": "en-US,en" },
    });
    const rows = body?.data?.limits;
    if (!Array.isArray(rows)) return errResult("schema", "Coding Plan 响应缺少 data.limits");
    const seen = new Set();
    const entries = [];
    let tightest = null;
    for (const row of rows) {
      const type = typeof row?.type === "string" ? row.type : "";
      if (type !== "TOKENS_LIMIT" && type !== "TIME_LIMIT") continue; // 仅展示明确窗口
      if (seen.has(type)) return errResult("schema", "配额响应包含重复的窗口类型");
      seen.add(type);
      const percent = parseNumber(row.percentage);
      if (percent === null || percent < 0 || percent > 100) return errResult("schema", "配额百分比超出已支持范围");
      const label = type === "TOKENS_LIMIT" ? "Token 用量（5 小时）" : "MCP 用量（月）";
      entries.push({ name: label, kind: "win", limit: "—", used: `${Math.round(percent)}%`, remain: `${Math.max(0, 100 - Math.round(percent))}%`, pct: Math.round(percent), reset: "—", note: "官方插件字段；不推断周窗口或重置时间" });
      if (tightest === null || percent > tightest) tightest = percent;
    }
    if (!entries.length) return errResult("no-data", "未解析到已公开的 Coding Plan 窗口");
    return { state: stateFromPct(tightest, cfg.warnPct, cfg.critPct), entries, headline: makePctHeadline(tightest, entries) };
  }, (cfg) => !cfg.apiKey);
}

// ---------- MiniMax：Token Plan 窗口（显式剩余百分比，不猜旧计数） ----------

function minimaxQuery(host) {
  return wrapQuery(async (cfg) => {
    const { origin, error } = officialEndpoint(cfg.baseUrl, { hosts: [host], basePaths: ["", "/v1"], defaultBase: `https://${host}` });
    if (error) return errResult(error.code, error.message);
    const body = await httpJson(`${origin}/v1/token_plan/remains`, { key: cfg.apiKey });
    if (parseNumber(body?.base_resp?.status_code) !== 0) return errResult("schema", "MiniMax 套餐查询业务响应未成功");
    const rows = body?.model_remains;
    if (!Array.isArray(rows)) return errResult("schema", "MiniMax 响应缺少 model_remains");
    const seen = new Set();
    const entries = [];
    let tightest = null;
    let ambiguous = false;
    const addWindow = (row, model, weekly) => {
      const prefix = weekly ? "current_weekly" : "current_interval";
      if (parseNumber(row[`${prefix}_status`]) === 3) return;
      const remaining = parseNumber(row[`${prefix}_remaining_percent`]);
      if (remaining === null) { ambiguous = true; return; }
      if (remaining < 0 || remaining > 100) throw Object.assign(new Error("MiniMax 原始剩余百分比超出已支持范围"), { code: "schema" });
      const start = parseEpochMs(row[weekly ? "weekly_start_time" : "start_time"]);
      const end = parseEpochMs(row[weekly ? "weekly_end_time" : "end_time"]);
      if (!start || !end || end.getTime() <= start.getTime()) throw Object.assign(new Error("MiniMax 返回无效的配额窗口"), { code: "schema" });
      const usedPct = Math.round(100 - remaining);
      const boost = weekly ? parseNumber(row.weekly_boost_permille) : null;
      const note = boost !== null && boost > 0 && boost !== 1000
        ? `按当前分配额度显示；周加成 ${(boost / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })}×`
        : "按当前分配额度显示";
      entries.push({
        name: `${model} · ${weekly ? "周窗口" : "当前窗口"}`,
        kind: "win",
        limit: "—",
        used: `${usedPct}%`,
        remain: `${Math.round(remaining)}%`,
        pct: usedPct,
        reset: formatReset(end),
        note,
      });
      if (tightest === null || usedPct > tightest) tightest = usedPct;
    };
    for (const row of rows) {
      const model = typeof row?.model_name === "string" && row.model_name ? row.model_name : "";
      if (!model) continue;
      if (seen.has(model)) throw Object.assign(new Error("MiniMax 返回重复的模型配额"), { code: "schema" });
      seen.add(model);
      addWindow(row, model, false);
      addWindow(row, model, true);
    }
    if (!entries.length) {
      return errResult(ambiguous ? "schema" : "no-data", ambiguous
        ? "MiniMax 未返回可确认的显式剩余百分比，未使用旧计数推算"
        : "MiniMax 未返回可展示的窗口");
    }
    return { state: stateFromPct(tightest, cfg.warnPct, cfg.critPct), entries, headline: makePctHeadline(tightest, entries) };
  }, (cfg) => !cfg.apiKey);
}

// ---------- OpenAI / Anthropic 组织：Admin Key 用量与费用（最近完整 UTC 日） ----------

/** 组织统计的通用日期：最近一个已完成的 UTC 日 [start, end)。 */
function orgDayRange(now = Date.now()) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 24 * 3600_000);
  return { start, end };
}

function orgDateNote(label) {
  return `${label} · UTC 昨日（最近已完成的 UTC 日）`;
}

const makeOpenAiOrgQuery = (kind) => wrapQuery(async (cfg) => {
  const { origin, error } = officialEndpoint(cfg.baseUrl, { hosts: ["api.openai.com"], basePaths: ["", "/v1"], defaultBase: "https://api.openai.com" });
  if (error) return errResult(error.code, error.message);
  const { start, end } = orgDayRange();
  const base = kind === "cost"
    ? `${origin}/v1/organization/costs?start_time=${Math.floor(start.getTime() / 1000)}&end_time=${Math.floor(end.getTime() / 1000)}&bucket_width=1d&limit=1`
    : `${origin}/v1/organization/usage/completions?start_time=${Math.floor(start.getTime() / 1000)}&end_time=${Math.floor(end.getTime() / 1000)}&bucket_width=1d&limit=1&group_by%5B%5D=model`;
  const seenPages = new Set();
  let next = null;
  let hadRows = false;
  const costs = new Map(); // currency -> amount
  const models = new Map(); // model -> {tokens, input, output, requests}
  let total = 0;
  let requests = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const path = base + (next === null ? "" : `&page=${encodeURIComponent(next)}`);
    const body = await httpJson(path, { key: cfg.apiKey });
    const buckets = Array.isArray(body?.data) ? body.data : [];
    for (const bucket of buckets) {
      const bucketStart = parseNumber(bucket?.start_time);
      const bucketEnd = parseNumber(bucket?.end_time);
      if (bucketStart === null || bucketEnd === null) throw Object.assign(new Error("组织统计时间桶字段缺失"), { code: "schema" });
      if (bucketStart < Math.floor(start.getTime() / 1000) || bucketEnd > Math.floor(end.getTime() / 1000) || bucketEnd <= bucketStart) {
        throw Object.assign(new Error("组织统计返回了请求范围以外的时间桶"), { code: "schema" });
      }
      const rows = Array.isArray(bucket?.results) ? bucket.results : [];
      for (const row of rows) {
        hadRows = true;
        if (kind === "cost") {
          const amount = row?.amount || {};
          const value = parseNumber(amount.value);
          const currency = String(amount.currency || "USD").toUpperCase();
          if (value === null || !currency) throw Object.assign(new Error("组织费用字段缺失"), { code: "schema" });
          costs.set(currency, (costs.get(currency) || 0) + value);
        } else {
          const input = parseNumber(row.input_tokens);
          const output = parseNumber(row.output_tokens);
          const cached = row.input_cached_tokens !== undefined && row.input_cached_tokens !== null ? parseNumber(row.input_cached_tokens) : 0;
          const req = parseNumber(row.num_model_requests);
          if (input === null || output === null || req === null) throw Object.assign(new Error("组织用量字段缺失"), { code: "schema" });
          const tokens = input + output;
          const model = typeof row.model === "string" && row.model ? row.model : "未分模型";
          total += tokens;
          requests += req;
          const prev = models.get(model) || { tokens: 0, input: 0, output: 0, requests: 0 };
          models.set(model, { tokens: prev.tokens + tokens, input: prev.input + input, output: prev.output + output, requests: prev.requests + req });
        }
      }
    }
    if (body?.has_more !== true) break;
    next = typeof body?.next_page === "string" ? body.next_page : null;
    if (!next || seenPages.has(next)) throw Object.assign(new Error("组织统计分页游标重复，未发布部分结果"), { code: "schema" });
    seenPages.add(next);
    if (page === MAX_PAGES - 1) throw Object.assign(new Error("组织统计超过分页上限，未发布部分结果"), { code: "schema" });
  }
  if (!hadRows) return errResult("no-data", "组织统计未返回数据");
  if (kind === "cost") {
    const entries = [...costs.entries()].map(([currency, amount]) => ({
      name: `组织费用 · ${currency}`,
      kind: "cost",
      limit: "—",
      used: formatMoney(amount, currency),
      remain: "—",
      pct: null,
      reset: "—",
      note: orgDateNote("组织报告费用") + "（账单可能延迟）",
    }));
    const headlineAmt = [...costs.entries()].map(([c, v]) => formatMoney(v, c)).join(" · ");
    return { state: "ok", entries, headline: { kind: "amt", amt: headlineAmt, reset: "—" } };
  }
  const entries = [{
    name: "组织 Token 用量（汇总）",
    kind: "usage",
    limit: "—",
    used: tokensText(total),
    remain: "—",
    pct: null,
    reset: "—",
    note: `请求数 ${tokensText(requests)} · ${orgDateNote("Completions 用量接口，不覆盖全部产品计量")}`,
  }];
  for (const [model, m] of models) {
    entries.push({
      name: `模型 · ${model}`,
      kind: "usage",
      limit: "—",
      used: tokensText(m.tokens),
      remain: "—",
      pct: null,
      reset: "—",
      note: `输入 ${tokensText(m.input)} · 输出 ${tokensText(m.output)} · 请求 ${tokensText(m.requests)}`,
    });
  }
  return { state: "ok", entries, headline: { kind: "amt", amt: tokensText(total), reset: "—" } };
}, (cfg) => !cfg.apiKey);

/** OpenAI 组织用量与组织费用共用一把 Admin Key，分别实现两个注册项。 */
const queryOpenAiUsage = makeOpenAiOrgQuery("usage");
const queryOpenAiCost = makeOpenAiOrgQuery("cost");

const makeAnthropicOrgQuery = (kind) => wrapQuery(async (cfg) => {
  const { origin, error } = officialEndpoint(cfg.baseUrl, { hosts: ["api.anthropic.com"], basePaths: ["", "/v1"], defaultBase: "https://api.anthropic.com" });
  if (error) return errResult(error.code, error.message);
  const { start, end } = orgDayRange();
  const iso = (d) => d.toISOString();
  const path = kind === "cost"
    ? `${origin}/v1/organizations/cost_report?starting_at=${encodeURIComponent(iso(start))}&ending_at=${encodeURIComponent(iso(end))}&bucket_width=1d&limit=1`
    : `${origin}/v1/organizations/usage_report/messages?starting_at=${encodeURIComponent(iso(start))}&ending_at=${encodeURIComponent(iso(end))}&bucket_width=1d&limit=1`;
  const body = await httpJson(path, { auth: "x-api-key", key: cfg.apiKey });
  if (body?.has_more === true) return errResult("schema", "组织统计尚有后续分页，未发布部分结果");
  const buckets = Array.isArray(body?.data) ? body.data : [];
  const seenStart = new Set();
  let hadRows = false;
  const costs = new Map();
  const models = new Map();
  let total = 0;
  for (const bucket of buckets) {
    const bucketStart = new Date(String(bucket?.starting_at || ""));
    const bucketEnd = new Date(String(bucket?.ending_at || ""));
    if (Number.isNaN(bucketStart.getTime()) || Number.isNaN(bucketEnd.getTime())) throw Object.assign(new Error("组织统计时间桶字段缺失"), { code: "schema" });
    if (bucketStart < start || bucketEnd > end || bucketEnd <= bucketStart) throw Object.assign(new Error("组织统计返回了请求范围以外的时间桶"), { code: "schema" });
    if (seenStart.has(bucketStart.toISOString())) throw Object.assign(new Error("组织统计返回重复时间桶"), { code: "schema" });
    seenStart.add(bucketStart.toISOString());
    const rows = Array.isArray(bucket?.results) ? bucket.results : [];
    for (const row of rows) {
      hadRows = true;
      if (kind === "cost") {
        const amount = row?.amount || {};
        const cents = parseNumber(amount.amount);
        const currency = String(amount.currency || "USD").toUpperCase();
        if (cents === null || !currency) throw Object.assign(new Error("组织费用字段缺失"), { code: "schema" });
        costs.set(currency, (costs.get(currency) || 0) + cents / 100); // 美元美分 → USD
      } else {
        const uncached = parseNumber(row.uncached_input_tokens);
        const cachedRead = parseNumber(row.cache_read_input_tokens);
        const output = parseNumber(row.output_tokens);
        const creation = row?.cache_creation || {};
        const eph1h = parseNumber(creation.ephemeral_1h_input_tokens);
        const eph5m = parseNumber(creation.ephemeral_5m_input_tokens);
        if (uncached === null || cachedRead === null || output === null || eph1h === null || eph5m === null) {
          throw Object.assign(new Error("组织用量字段缺失"), { code: "schema" });
        }
        const input = uncached + cachedRead + eph1h + eph5m;
        const tokens = input + output;
        const model = typeof row.model === "string" && row.model ? row.model : "未分模型";
        total += tokens;
        const prev = models.get(model) || { tokens: 0, input: 0, output: 0 };
        models.set(model, { tokens: prev.tokens + tokens, input: prev.input + input, output: prev.output + output });
      }
    }
  }
  if (!hadRows) return errResult("no-data", "组织统计未返回数据");
  if (kind === "cost") {
    const entries = [...costs.entries()].map(([currency, amount]) => ({
      name: `组织费用 · ${currency}`,
      kind: "cost",
      limit: "—",
      used: formatMoney(amount, currency),
      remain: "—",
      pct: null,
      reset: "—",
      note: orgDateNote("组织报告费用") + "（报告美分按 1/100 转为美元）",
    }));
    const headlineAmt = [...costs.entries()].map(([c, v]) => formatMoney(v, c)).join(" · ");
    return { state: "ok", entries, headline: { kind: "amt", amt: headlineAmt, reset: "—" } };
  }
  const entries = [{
    name: "组织 Messages 用量（汇总）",
    kind: "usage",
    limit: "—",
    used: tokensText(total),
    remain: "—",
    pct: null,
    reset: "—",
    note: orgDateNote("Messages 用量；未报告请求数保留未知"),
  }];
  for (const [model, m] of models) {
    entries.push({
      name: `模型 · ${model}`,
      kind: "usage",
      limit: "—",
      used: tokensText(m.tokens),
      remain: "—",
      pct: null,
      reset: "—",
      note: `输入 ${tokensText(m.input)} · 输出 ${tokensText(m.output)}`,
    });
  }
  return { state: "ok", entries, headline: { kind: "amt", amt: tokensText(total), reset: "—" } };
}, (cfg) => !cfg.apiKey);

const queryAnthropicUsage = makeAnthropicOrgQuery("usage");
const queryAnthropicCost = makeAnthropicOrgQuery("cost");

// ---------- OpenCode：窗口用量 + allowance（私有兼容来源，保留） ----------

async function queryOpenCode(cfg) {
  const server = deriveServer(cfg.baseUrl || "", "https://opencode.ai");
  const entries = [];
  let tightest = null;
  const warnings = [];

  if (cfg.apiKey) {
    try {
      const body = await httpJson(`${server}/zen/go/v1/usage`, { key: cfg.apiKey });
      const usage = body?.usage;
      if (usage && typeof usage === "object") {
        for (const [key, label] of [["rolling", "5h 滚动"], ["weekly", "周用量"], ["monthly", "月用量"]]) {
          const w = usage[key];
          if (!w || typeof w !== "object") continue;
          const pct = parseNumber(w.percent);
          entries.push({
            name: label,
            kind: "win",
            limit: "—",
            used: pct === null ? "—" : `${pct}%`,
            remain: pct === null ? "—" : `${Math.max(0, 100 - pct)}%`,
            pct,
            reset: formatReset(parseDate(w.resetsAt)),
            note: w.status || "",
          });
          if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
        }
      }
    } catch (error) {
      warnings.push(`窗口用量：${error.code}:${error.message}`);
    }
  }

  if (cfg.allowanceToken) {
    try {
      const headers = {};
      if (cfg.orgId) headers["x-org-id"] = String(cfg.orgId);
      const body = await httpJson(`${server}/api/go/status`, { key: cfg.allowanceToken, extraHeaders: headers });
      const meters = Array.isArray(body?.meters) ? body.meters : [];
      for (const m of meters) {
        const limitUsd = parseNumber(m.limitMicroCents) !== null ? parseNumber(m.limitMicroCents) / 1_000_000 : null;
        const remainUsd = parseNumber(m.remainingMicroCents) !== null ? parseNumber(m.remainingMicroCents) / 1_000_000 : null;
        const usedUsd = limitUsd !== null && remainUsd !== null ? Math.max(0, limitUsd - remainUsd) : null;
        const pct = limitUsd > 0 && remainUsd !== null ? Math.round(((limitUsd - remainUsd) / limitUsd) * 100) : null;
        entries.push({
          name: `allowance${m.kind ? ` · ${m.kind}` : ""}`,
          kind: "bal",
          limit: formatMoney(limitUsd, "USD"),
          used: usedUsd === null ? "—" : formatMoney(usedUsd, "USD"),
          remain: formatMoney(remainUsd, "USD"),
          pct,
          reset: formatReset(parseDate(m.resetsAt)),
          note: "",
        });
        if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
      }
    } catch (error) {
      warnings.push(`allowance：${error.code}:${error.message}`);
    }
  }

  if (!cfg.apiKey && !cfg.allowanceToken) {
    return { state: "off", error: { code: "auth", message: "未配置 API Key / allowance Token" }, entries: [], headline: { kind: "pct", pct: null, amt: "未配置" } };
  }
  if (warnings.length) {
    return {
      state: "err",
      error: { code: "partial", message: warnings.join("；") },
      entries,
      headline: makePctHeadline(tightest, entries),
    };
  }
  return { state: stateFromPct(tightest, cfg.warnPct, cfg.critPct), entries, headline: makePctHeadline(tightest, entries) };
}

// ---------- Command Code：5h/周窗口 + 月额度（私有兼容来源，保留） ----------

const PLAN_MONTHLY_CREDITS = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

const PLAN_NAMES = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};

async function queryCommandCode(cfg) {
  const baseUrl = deriveServer(cfg.baseUrl || "", "https://api.commandcode.ai");
  if (!cfg.apiKey) {
    return { state: "off", error: { code: "auth", message: "未配置 API Key" }, entries: [], headline: { kind: "amt", amt: "未配置" } };
  }
  try {
    let orgId = null;
    try {
      const who = await httpJson(`${baseUrl}/alpha/whoami`, { key: cfg.apiKey });
      orgId = who?.org?.id ?? null;
    } catch (error) {
      if (error.code === "auth") throw error;
    }
    const org = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [creditsBody, subsBody] = await Promise.all([
      httpJson(`${baseUrl}/alpha/billing/credits${org}`, { key: cfg.apiKey }),
      httpJson(`${baseUrl}/alpha/billing/subscriptions${org}`, { key: cfg.apiKey }),
    ]);

    const credits = creditsBody?.credits;
    const sub = subsBody?.data;
    const planId = credits?.planId ?? sub?.planId ?? null;
    const planName = PLAN_NAMES[planId] || planId || "套餐";

    const periodStart = parseDate(sub?.currentPeriodStart);
    let totalCost = null;
    if (periodStart && !Number.isNaN(periodStart.getTime())) {
      try {
        const summary = await httpJson(
          `${baseUrl}/alpha/usage/summary${org ? `${org}&` : "?"}since=${encodeURIComponent(periodStart.toISOString())}`,
          { key: cfg.apiKey },
        );
        totalCost = parseNumber(summary?.totalCost);
      } catch {
        /* 周期消费取不到时不伪造月剩余 */
      }
    }

    const entries = [];
    let tightest = null;

    const windowLimits = creditsBody?.windowLimits;
    for (const [key, label] of [["fiveHour", "5h 窗口"], ["weekly", "周窗口"]]) {
      const w = windowLimits?.[key];
      if (!w || typeof w !== "object") continue;
      // 上游契约别名容忍：limit??cap、used??(cap−remaining)、reset??resetAt
      // （真实载荷 resetAt 为 epoch-毫秒数字，parseDate 已按 ISO/毫秒/毫秒数字串宽容解析）
      const cap = parseNumber(w.cap ?? w.limit);
      let used = parseNumber(w.used);
      if (used === null && cap !== null) {
        const remaining = parseNumber(w.remaining);
        if (remaining !== null) used = Math.max(0, cap - remaining);
      }
      if (cap === null || cap <= 0) continue;
      const pct = used === null ? null : Math.min(100, Math.round((used / cap) * 100));
      const remain = used === null ? null : Math.max(0, cap - used);
      const resetDate = parseDate(w.resetAt ?? w.reset);
      entries.push({
        name: `${label} · ${planName}`,
        kind: "win",
        limit: formatMoney(cap, "USD"),
        used: used === null ? "—" : formatMoney(used, "USD"),
        remain: remain === null ? "—" : formatMoney(remain, "USD"),
        pct,
        reset: formatReset(resetDate),
        note: resetDate ? "" : "未提供重置时刻",
      });
      if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
    }

    const planLimit = PLAN_MONTHLY_CREDITS[planId] ?? parseNumber(credits?.monthlyCredits);
    if (planLimit !== null && planLimit > 0) {
      let remaining = parseNumber(credits?.monthlyCredits);
      let estimated = false;
      if (remaining === null && totalCost !== null) {
        remaining = Math.max(0, planLimit - totalCost);
        estimated = true;
      }
      if (remaining !== null) {
        const used = Math.max(0, planLimit - remaining);
        const pct = Math.min(100, Math.round((used / planLimit) * 100));
        // 月重置时刻只认订阅周期结束 currentPeriodEnd；currentPeriodStart 是计费周期起点
        // （usage/summary 的 since 锚点），绝不当作重置时间展示
        const periodEnd = parseDate(sub?.currentPeriodEnd);
        const noteParts = [];
        if (estimated) noteParts.push("月度消费估算（套餐总额 − 周期消费）");
        if (sub?.status) noteParts.push(`订阅 ${sub.status}`);
        if (sub && !periodEnd) noteParts.push("周期结束未公布");
        entries.push({
          name: `月额度 · ${planName}`,
          kind: "win",
          limit: formatMoney(planLimit, "USD"),
          used: formatMoney(used, "USD"),
          remain: formatMoney(remaining, "USD"),
          pct,
          reset: formatReset(periodEnd),
          note: noteParts.join("；"),
        });
        if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
      }
    }

    if (!entries.length) {
      return errResult("no-data", "未解析到窗口/额度数据");
    }
    return { state: stateFromPct(tightest, cfg.warnPct, cfg.critPct), entries, headline: makePctHeadline(tightest, entries) };
  } catch (error) {
    return errResult(error.code || "network", error.message || "网络错误");
  }
}

// ---------- 注册表 ----------

function supplierMeta(meta) {
  return meta;
}

const supplier = (meta) => supplierMeta(meta);

export const PROVIDERS = {
  deepseek: supplier({
    id: "deepseek",
    name: "DeepSeek",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    baseUrlDefault: "https://api.deepseek.com",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
    query: queryDeepSeek,
  }),
  "moonshot-cn": supplier({
    id: "moonshot-cn",
    name: "Moonshot 国内",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    region: "cn",
    baseUrlDefault: "https://api.moonshot.cn/v1",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
    query: moonshotQuery("api.moonshot.cn", "CNY"),
  }),
  "moonshot-intl": supplier({
    id: "moonshot-intl",
    name: "Moonshot 国际",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    region: "intl",
    baseUrlDefault: "https://api.moonshot.ai/v1",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
    query: moonshotQuery("api.moonshot.ai", "USD"),
  }),
  zai: supplier({
    id: "zai",
    name: "Z.ai",
    credentialClass: "api-key",
    credentialKey: "codingPlanKey",
    credentialLabel: "Coding Plan Key",
    region: "intl",
    baseUrlDefault: "https://api.z.ai/api/anthropic",
    official: "官方插件字段",
    needs: [{ key: "apiKey", label: "Coding Plan Key", secret: true }],
    query: zaiQuery("api.z.ai"),
  }),
  "zai-cn": supplier({
    id: "zai-cn",
    name: "智谱 Coding Plan",
    credentialClass: "api-key",
    credentialKey: "codingPlanKey",
    credentialLabel: "Coding Plan Key",
    region: "cn",
    baseUrlDefault: "https://open.bigmodel.cn/api/anthropic",
    official: "官方插件字段",
    needs: [{ key: "apiKey", label: "Coding Plan Key", secret: true }],
    query: zaiQuery("open.bigmodel.cn"),
  }),
  minimax: supplier({
    id: "minimax",
    name: "MiniMax 国际",
    credentialClass: "api-key",
    credentialKey: "tokenPlanKey",
    credentialLabel: "Token Plan Key",
    region: "intl",
    baseUrlDefault: "https://www.minimax.io",
    official: "官方（第一方类型已核验）",
    needs: [{ key: "apiKey", label: "Token Plan Key", secret: true }],
    query: minimaxQuery("www.minimax.io"),
  }),
  "minimax-cn": supplier({
    id: "minimax-cn",
    name: "MiniMax 国内",
    credentialClass: "api-key",
    credentialKey: "tokenPlanKey",
    credentialLabel: "Token Plan Key",
    region: "cn",
    baseUrlDefault: "https://www.minimaxi.com",
    official: "官方（第一方类型已核验）",
    needs: [{ key: "apiKey", label: "Token Plan Key", secret: true }],
    query: minimaxQuery("www.minimaxi.com"),
  }),
  openrouter: supplier({
    id: "openrouter",
    name: "OpenRouter",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    official: "官方稳定",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
    query: queryOpenRouter,
  }),
  "openrouter-account": supplier({
    id: "openrouter-account",
    name: "OpenRouter 账户 credits",
    credentialClass: "management-key",
    credentialKey: "managementKey",
    credentialLabel: "Management Key",
    baseUrlDefault: "https://openrouter.ai/api/v1",
    official: "官方条件（需 Management Key）",
    needs: [{ key: "apiKey", label: "Management Key", secret: true }],
    query: queryOpenRouterAccount,
  }),
  "openai-org": supplier({
    id: "openai-org",
    name: "OpenAI 组织",
    credentialClass: "admin-key",
    credentialKey: "adminKey",
    credentialLabel: "组织 Admin Key",
    baseUrlDefault: "https://api.openai.com",
    official: "官方条件（需组织 Admin Key）",
    needs: [{ key: "apiKey", label: "Admin Key", secret: true }],
    query: async (cfg) => {
      const [usage, cost] = await Promise.all([queryOpenAiUsage(cfg), queryOpenAiCost(cfg)]);
      return mergeOrgResults(usage, cost);
    },
  }),
  "anthropic-org": supplier({
    id: "anthropic-org",
    name: "Anthropic 组织",
    credentialClass: "admin-key",
    credentialKey: "adminKey",
    credentialLabel: "组织 Admin Key",
    baseUrlDefault: "https://api.anthropic.com",
    official: "官方条件（需组织 Admin Key）",
    needs: [{ key: "apiKey", label: "Admin Key", secret: true }],
    query: async (cfg) => {
      const [usage, cost] = await Promise.all([queryAnthropicUsage(cfg), queryAnthropicCost(cfg)]);
      return mergeOrgResults(usage, cost);
    },
  }),
  opencode: supplier({
    id: "opencode",
    name: "OpenCode",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key / OAuth",
    compat: "私有兼容来源",
    baseUrlDefault: "https://opencode.ai",
    needs: [
      { key: "apiKey", label: "API Key（窗口用量）", secret: true },
      { key: "allowanceToken", label: "allowance Token（OAuth）", secret: true },
      { key: "orgId", label: "org id（可选）", secret: false },
    ],
    query: queryOpenCode,
  }),
  commandcode: supplier({
    id: "commandcode",
    name: "Command Code",
    credentialClass: "api-key",
    credentialKey: "apiKey",
    credentialLabel: "API Key",
    compat: "私有兼容来源",
    baseUrlDefault: "https://api.commandcode.ai",
    needs: [{ key: "apiKey", label: "API Key", secret: true }],
    query: queryCommandCode,
  }),
};

/** Admin 供应商：用量与费用两把独立查询合并为一次供应商取数。 */
function mergeOrgResults(usage, cost) {
  if (usage.state === "off" && cost.state === "off") return usage;
  const entries = [...(usage.entries || []), ...(cost.entries || [])];
  const errors = [];
  for (const [label, r] of [["用量", usage], ["费用", cost]]) {
    if (r.state === "err" || r.state === "off") errors.push(`${label}：${r.error?.message || r.error?.code}`);
  }
  const headline = usage.headline && usage.state !== "err" && usage.state !== "off"
    ? usage.headline
    : (cost.headline && cost.state !== "err" && cost.state !== "off"
        ? cost.headline
        : { kind: "amt", amt: "—" });
  if (errors.length) {
    return { state: "err", error: { code: [usage, cost].some((r) => r.error?.code === "auth") ? "auth" : "partial", message: errors.join("；") }, entries, headline };
  }
  return { state: stateFromPct(null, 80, 95), entries, headline };
}


/** 各官方供应商允许的主机与基础路径（与各 query 内校验一致；无该键 = 私有兼容来源）。 */
export const OFFICIAL_ENDPOINTS = {
  deepseek: { hosts: DEEPSEEK.hosts, basePaths: DEEPSEEK.basePaths },
  "moonshot-cn": { hosts: ["api.moonshot.cn"], basePaths: ["", "/v1"] },
  "moonshot-intl": { hosts: ["api.moonshot.ai"], basePaths: ["", "/v1"] },
  zai: { hosts: ["api.z.ai"], basePaths: ZAI_BASE_PATHS },
  "zai-cn": { hosts: ["open.bigmodel.cn"], basePaths: ZAI_BASE_PATHS },
  minimax: { hosts: ["www.minimax.io"], basePaths: ["", "/v1"] },
  "minimax-cn": { hosts: ["www.minimaxi.com"], basePaths: ["", "/v1"] },
  openrouter: { hosts: OPENROUTER.hosts, basePaths: OPENROUTER.basePaths },
  "openrouter-account": { hosts: OPENROUTER.hosts, basePaths: OPENROUTER.basePaths },
  "openai-org": { hosts: ["api.openai.com"], basePaths: ["", "/v1"] },
  "anthropic-org": { hosts: ["api.anthropic.com"], basePaths: ["", "/v1"] },
};

/** DSH 路由带进来的 baseURL 是否可直接作为该供应商的官方查询地址。 */
export function isOfficialBaseUrl(supplierId, baseUrl) {
  const spec = OFFICIAL_ENDPOINTS[supplierId];
  if (!spec) return false;
  const { error } = officialEndpoint(baseUrl, spec);
  return !error;
}

/** 各官方供应商允许的主机（无该键 = 私有兼容来源，不做官方地址约束）。 */
export const OFFICIAL_HOSTS = Object.fromEntries(
  Object.entries(OFFICIAL_ENDPOINTS).map(([id, spec]) => [id, spec.hosts]),
);

export const SUPPLIER_IDS = Object.keys(PROVIDERS);
