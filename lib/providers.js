// lib/providers.js — 数据层
// 移植自 Token-Consumption-Monitoring `refactor/unified-query-methods` 分支的
// 「统一查询方法」模式（Describe→Scan→Query），只保留纯 HTTP 方法：
//   - DeepSeek 余额      GET {baseUrl}/user/balance            (Bearer API key)
//   - OpenCode 窗口      GET {server}/zen/go/v1/usage          (Bearer API key)
//   - OpenCode allowance GET {server}/api/go/status            (Bearer OAuth + x-org-id)
//   - Command Code       GET {origin}/alpha/* (Bearer API key；origin 从 baseUrl 收敛，
//     兼容 DSH 自动填入的聊天网关路径如 https://api.commandcode.ai/provider/v1)
// Windows 专属方法（WebView2 控制台、本地 SQLite zcode）已按规格丢弃。
//
// 每个 query(cfg) 返回归一化结构：
//   { state: 'ok'|'warn'|'crit'|'err'|'off', error?: {code, message},
//     entries: [{name, kind:'win'|'bal', limit, used, remain, pct, reset, note}],
//     headline: {kind:'pct'|'amt', pct?, amt?, reset} }

const REQUEST_TIMEOUT_MS = 15_000;

// ---------- 通用工具 ----------

async function httpJson(url, { key, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const err = new Error(`HTTP ${response.status}`);
        err.code = "auth";
        throw err;
      }
      const err = new Error(`HTTP ${response.status}`);
      err.code = `http:${response.status}`;
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
    const err = new Error(error.message || "网络错误");
    err.code = "network";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 规约 Base URL 为 scheme://host（忽略路径），非法时返回默认服务器。 */
function deriveServer(baseUrl, fallback) {
  try {
    const url = new URL(baseUrl);
    if (url.host) return `${url.protocol}//${url.host}`;
  } catch {
    /* 忽略 */
  }
  return fallback;
}

function parseNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseDate(value) {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 依据 pct 与阈值归并条目，得出供应商状态。 */
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

// ---------- DeepSeek：余额 ----------

async function queryDeepSeek(cfg) {
  const baseUrl = (cfg.baseUrl || "https://api.deepseek.com").trim().replace(/\/+$/, "");
  if (!cfg.apiKey) {
    return { state: "off", error: { code: "auth", message: "未配置 API Key" }, entries: [], headline: { kind: "amt", amt: "未配置" } };
  }
  try {
    const body = await httpJson(`${baseUrl}/user/balance`, { key: cfg.apiKey });
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    const entry = infos.find((i) => i && parseNumber(i.total_balance) !== null);
    if (!entry) {
      return { state: "err", error: { code: "no-data", message: "余额接口未返回数据" }, entries: [], headline: { kind: "amt", amt: "—" } };
    }
    const balance = parseNumber(entry.total_balance);
    const currency = entry.currency || "CNY";
    const granted = parseNumber(entry.granted_balance);
    const topped = parseNumber(entry.topped_up_balance);
    const note = [];
    if (topped !== null) note.push(`到账 ${formatMoney(topped, currency)}`);
    if (granted !== null) note.push(`赠送 ${formatMoney(granted, currency)}`);
    return {
      state: "ok",
      entries: [{
        name: "余额",
        kind: "bal",
        limit: "—",
        used: "—",
        remain: formatMoney(balance, currency),
        pct: null,
        reset: "—",
        note: note.join(" · "),
      }],
      headline: { kind: "amt", amt: formatMoney(balance, currency), reset: "—" },
    };
  } catch (error) {
    return { state: "err", error: { code: error.code || "network", message: error.message }, entries: [], headline: { kind: "amt", amt: "—" } };
  }
}

// ---------- OpenCode：窗口用量 + allowance ----------

async function queryOpenCode(cfg) {
  const server = deriveServer(cfg.baseUrl || "", "https://opencode.ai");
  const entries = [];
  let tightest = null;
  const warnings = [];

  // 窗口用量（Bearer API key）
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

  // allowance（OAuth + x-org-id）
  if (cfg.allowanceToken) {
    try {
      const headers = {};
      if (cfg.orgId) headers["x-org-id"] = String(cfg.orgId);
      const body = await httpJson(`${server}/api/go/status`, { key: cfg.allowanceToken, headers });
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
  return {
    state: stateFromPct(tightest, cfg.warnPct, cfg.critPct),
    entries,
    headline: makePctHeadline(tightest, entries),
  };
}

function makePctHeadline(tightest, entries) {
  if (tightest === null) {
    const bal = entries.find((e) => e.kind === "bal");
    return { kind: bal ? "amt" : "pct", amt: bal ? bal.remain : "—", reset: bal ? bal.reset : "—" };
  }
  const tight = entries.find((e) => e.pct === tightest) || entries[0];
  return { kind: "pct", pct: `${tightest}%`, amt: `余 ${tight.pct === null || tight.kind === "bal" ? tight.remain : `${100 - tightest}%`}`, reset: tight.reset };
}

// ---------- Command Code：5h/周窗口 + 月额度 ----------

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
  // DSH 自动填入的 baseURL 可能是聊天网关路径（/provider/v1 等），
  // 周期限额 API 固定挂在同源根路径 /alpha/* 下 → 收敛到 origin
  const baseUrl = deriveServer(cfg.baseUrl, "https://api.commandcode.ai");
  if (!cfg.apiKey) {
    return { state: "off", error: { code: "auth", message: "未配置 API Key" }, entries: [], headline: { kind: "amt", amt: "未配置" } };
  }
  try {
    // whoami → org id（个人账户可能是 null，请求成功即可）
    let orgId = null;
    try {
      const who = await httpJson(`${baseUrl}/alpha/whoami`, { key: cfg.apiKey });
      orgId = who?.org?.id ?? null;
    } catch (error) {
      if (error.code === "auth") throw error;
      // whoami 失败不阻塞其余端点
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

    // usage/summary 必须带计费周期起点（since），否则是全量历史消费
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
      const cap = parseNumber(w.cap);
      const used = parseNumber(w.used);
      if (cap === null || cap <= 0) continue;
      const pct = used === null ? null : Math.min(100, Math.round((used / cap) * 100));
      const remain = used === null ? null : Math.max(0, cap - used);
      entries.push({
        name: `${label} · ${planName}`,
        kind: "win",
        limit: formatMoney(cap, "USD"),
        used: used === null ? "—" : formatMoney(used, "USD"),
        remain: remain === null ? "—" : formatMoney(remain, "USD"),
        pct,
        reset: formatReset(parseDate(w.resetAt)),
        note: "",
      });
      if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
    }

    // 月额度：套餐上限（plan 表优先，缺失时用 API 的 monthlyCredits 兜底）；
    // 月剩余优先取 API（remaining），缺失时用 套餐总额 − 周期消费（标记估算）
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
        entries.push({
          name: `月额度 · ${planName}`,
          kind: "win",
          limit: formatMoney(planLimit, "USD"),
          used: formatMoney(used, "USD"),
          remain: formatMoney(remaining, "USD"),
          pct,
          reset: formatReset(parseDate(sub?.currentPeriodEnd)),
          note: estimated
            ? "月度消费估算（套餐总额 − 周期消费）"
            : sub?.status ? `订阅 ${sub.status}` : "",
        });
        if (pct !== null && (tightest === null || pct > tightest)) tightest = pct;
      }
    }

    if (!entries.length) {
      return { state: "err", error: { code: "no-data", message: "未解析到窗口/额度数据" }, entries: [], headline: { kind: "amt", amt: "—" } };
    }
    return {
      state: stateFromPct(tightest, cfg.warnPct, cfg.critPct),
      entries,
      headline: makePctHeadline(tightest, entries),
    };
  } catch (error) {
    return {
      state: "err",
      error: { code: error.code || "network", message: error.message },
      entries: [],
      headline: { kind: "amt", amt: "—" },
    };
  }
}

// ---------- 注册表（上游 QueryMethodRegistry 的对应物） ----------

export const PROVIDERS = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrlDefault: "https://api.deepseek.com",
    needs: [{ key: "apiKey", label: "API Key" }],
    query: queryDeepSeek,
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    baseUrlDefault: "https://opencode.ai",
    needs: [
      { key: "apiKey", label: "API Key（窗口用量）" },
      { key: "allowanceToken", label: "allowance Token（OAuth）" },
      { key: "orgId", label: "org id（可选）" },
    ],
    query: queryOpenCode,
  },
  commandcode: {
    id: "commandcode",
    name: "Command Code",
    baseUrlDefault: "https://api.commandcode.ai",
    needs: [{ key: "apiKey", label: "API Key" }],
    query: queryCommandCode,
  },
};