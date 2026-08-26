// lib/index.js — 宿主半（Node 进程内运行）
// dsh-quota-monitor：供应商可用周期限额监控的数据与调度侧。
//   - settings 命名空间 quota-monitor（dsh-settings-file，热重载，密钥 role('secret') 自动脱敏）
//   - 每供应商轮询调度：全局默认 60s（10–3600 可配）、同供应商 in-flight 合并去重、
//     失败指数退避（429/5xx/网络 30s→1m→2m→4m→10m；401/403 → 30min），成功复位
//   - 当前供应商（Q11=C）：启用 ∩ 近期流量；无 DSH 路由的供应商恒为候选；
//     流量接缝尚未观测到任何事件时按启用清单兜底（防御性）
//   - 自动探测（票 10）：ctx.llm 注册表 + settings 配置节探测 DSH 已添加供应商，
//     命中支持路由（deepseek-official / pi-ai deepseek）→ 自动启用 + Base URL +
//     密钥引用（不复制密钥、尊重手动）；未映射路由记 detectedUnmapped 仅提示
//   - 当日消耗量：session/event 的 usage 按 provider 归并进「供应商 × 小时桶」，
//     落盘 DSH 数据目录（保留期修剪），自然日 00:00 按桶求和重置
//   - 刷新历史：每供应商最近 50 条、全局 500 条，内存保存
//   - /api/quota-monitor/{state,refresh,test,settings} 路由（loopback 同源守卫）

import z from "schemastery";
import { autoFillPatch, DSH_ROUTE_MAP, detectHarnessSuppliers, supplierForRoute } from "./detect.js";
import { PROVIDERS } from "./providers.js";
import { dayKeyOf, dshHome, hourKeyOf, loadUsageFile, pruneBuckets, saveUsageFile, usageFilePath } from "./storage.js";

const NS = "quota-monitor";
const API_PREFIX = "/api/quota-monitor";

// DSH 暴露的 LLM 路由 id → 插件供应商 id（票 04 设计点；票 10 扩展至 pi-ai 同名单路由）。
// 当前供应商的流量折叠与自动探测共用同一张表。
const ROUTE_TO_SUPPLIER = DSH_ROUTE_MAP;

const BACKOFF_STEPS = [30_000, 60_000, 120_000, 240_000, 600_000];
const BASE_URL_DEFAULTS = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, PROVIDERS[id].baseUrlDefault]));
const AUTH_BACKOFF_MS = 30 * 60_000;
const HISTORY_PER_SUPPLIER = 50;
const HISTORY_GLOBAL = 500;

// ---------- 设置 schema（Schemastery；密钥 role('secret')） ----------

const supplierSchema = (defaults) =>
  z.object({
    enabled: z.boolean().default(defaults.enabled),
    apiKey: z.string().role("secret").default(""),
    baseUrl: z.string().default(defaults.baseUrl),
    warnPct: z.number().default(80).min(1).max(99),
    critPct: z.number().default(95).min(1).max(100),
    autoSource: z.string().default(""), // 自动探测来源命名空间（如 llm-deepseek）
    autoApiKeyEnv: z.string().default(""), // 自动探测到的密钥环境变量名
  });

const Config = z.object({
  intervalSeconds: z.number().default(60).min(10).max(3600),
  trafficWindowHours: z.number().default(24).min(1).max(24 * 7),
  retentionDays: z.number().default(7).min(1).max(90), // 保留期：本地用量数据小时桶保留天数
  suppliers: z.object({
    deepseek: supplierSchema({ enabled: false, baseUrl: PROVIDERS.deepseek.baseUrlDefault }),
    opencode: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().role("secret").default(""),
      allowanceToken: z.string().role("secret").default(""),
      orgId: z.string().default(""),
      baseUrl: z.string().default(PROVIDERS.opencode.baseUrlDefault),
      warnPct: z.number().default(80).min(1).max(99),
      critPct: z.number().default(95).min(1).max(100),
      autoSource: z.string().default(""),
      autoApiKeyEnv: z.string().default(""),
    }),
    commandcode: supplierSchema({ enabled: false, baseUrl: PROVIDERS.commandcode.baseUrlDefault }),
  }),
});

// ---------- 运行时（模块级单实例：同一进程只有一个 ctx） ----------

const runtime = {
  config: {},
  suppliers: {},
  history: [], // 全局环形 [{t, supplier, ok, error, summary}]
  routeSeen: {}, // routeId -> { lastSeenAt, lastModel }
  usageBuckets: {}, // supplierId -> { "YYYYMMDDHH": tokens }（本地用量数据，落盘）
  usageFile: null, // <DSH_HOME>/quota-monitor/usage.json
  channelAlive: null, // null=未知(兜底启用清单) true=已观测到事件 false=不可用
  harness: {}, // supplierId -> { route, baseUrl, apiKeyEnv, apiKey, keySource }（探测结果，密钥仅宿主内存）
  unmapped: [], // 探测到但无插件供应商的路由（仅提示，不含密钥）
  detect: {
    error: null,
    at: null,
    llmPresent: false,
    credentialsPresent: false,
    directoryEntries: 0,
    liveRoutes: [],
    candidates: [],
    included: [],
    found: [],
    unmapped: [],
  }, // 探测诊断（仅非密钥字段）
};

for (const id of Object.keys(PROVIDERS)) {
  runtime.suppliers[id] = { last: null, lastSuccessAt: null, backoff: { level: 0, nextAt: 0 }, inFlight: false, jitter: 0 };
}

// 解析供应商配置；apiKey 为空时若命中自动探测（autoSource），回退使用宿主内存解析的 DSH 密钥
const supplierCfg = (id) => {
  const c = runtime.config.suppliers?.[id] || {};
  let apiKey = c.apiKey || "";
  if (!apiKey && c.autoSource) {
    apiKey = runtime.harness[id]?.apiKey || "";
  }
  return { ...c, apiKey, warnPct: c.warnPct ?? 80, critPct: c.critPct ?? 95 };
};

/** DSH settings 全局描述里，某命名空间 user 层在 path 处是否有值（= 用户真正配置过）。 */
function settingsUserHas(ctx, ns, path) {
  if (!ns || !ctx.settings?.describe) return false;
  try {
    const desc = ctx.settings.describe({ redactSecrets: true }).find((d) => d.ns === ns);
    const user = desc?.user;
    if (!user || typeof user !== "object") return false;
    if (!path || path.length === 0) return Object.keys(user).length > 0;
    let cur = user;
    for (const key of path) {
      if (cur === null || typeof cur !== "object" || !(key in cur)) return false;
      cur = cur[key];
    }
    return true;
  } catch {
    return false;
  }
}

function pushHistory(record) {
  runtime.history.push(record);
  const count = runtime.history.filter((h) => h.supplier === record.supplier).length;
  if (count > HISTORY_PER_SUPPLIER) {
    const first = runtime.history.findIndex((h) => h.supplier === record.supplier);
    if (first >= 0) runtime.history.splice(first, 1);
  }
  if (runtime.history.length > HISTORY_GLOBAL) {
    runtime.history.splice(0, runtime.history.length - HISTORY_GLOBAL);
  }
}

// ---------- 取数调度 ----------

async function runQuery(id, { force = false } = {}) {
  const slot = runtime.suppliers[id];
  if (slot.inFlight) return; // 同供应商合并去重（至多一个 in-flight）
  const now = Date.now();
  if (!force && slot.backoff.nextAt > now) return;
  slot.inFlight = true;
  const startedAt = new Date();
  try {
    const result = await PROVIDERS[id].query(supplierCfg(id));
    slot.last = { ...result, fetchedAt: startedAt.toLocaleTimeString() };
    slot.lastSuccessAt = now;
    slot.backoff = { level: 0, nextAt: 0 };
    pushHistory({
      t: startedAt.toLocaleTimeString(),
      supplier: id,
      ok: true,
      error: null,
      summary: result.headline?.amt || result.headline?.pct || "ok",
    });
    return slot.last;
  } catch (error) {
    const code = error?.code || "network";
    const auth = code === "auth";
    slot.backoff.level = auth ? Infinity : Math.min(slot.backoff.level + 1, BACKOFF_STEPS.length - 1);
    slot.backoff.nextAt = now + (auth ? AUTH_BACKOFF_MS : BACKOFF_STEPS[slot.backoff.level]);
    if (slot.last) {
      // 失败行保留旧值（Q9=A）：状态置 err，旧数据不动
      slot.last = { ...slot.last, state: "err", error: { code, message: error.message }, fetchedAt: `${startedAt.toLocaleTimeString()}（失败）` };
    }
    pushHistory({
      t: startedAt.toLocaleTimeString(),
      supplier: id,
      ok: false,
      error: `${code}: ${error.message}`,
      summary: slot.last?.headline?.amt || slot.last?.headline?.pct || "—",
    });
    return slot.last;
  } finally {
    slot.inFlight = false;
  }
}

function tickSuppliers(now) {
  const interval = (runtime.config.intervalSeconds || 60) * 1000;
  for (const id of Object.keys(PROVIDERS)) {
    const s = runtime.suppliers[id];
    const c = supplierCfg(id);
    if (!c.enabled) continue;
    if (s.inFlight) continue;
    if (s.backoff.nextAt > now) continue;
    if (!s.last || !s.lastSuccessAt) {
      if (!s.last) runQuery(id).catch(() => {});
      continue;
    }
    if (now - s.lastSuccessAt >= interval + s.jitter) runQuery(id).catch(() => {});
  }
}

// ---------- 当前供应商（Q11=C）与当日消耗量 ----------

// 某供应商在当前观测里命中的 DSH 路由 id（真实事件优先，精确表兜底）；无 → null
const routeForSupplier = (id) =>
  Object.keys(runtime.routeSeen).find((r) => supplierForRoute(r) === id) ||
  Object.keys(ROUTE_TO_SUPPLIER).find((r) => ROUTE_TO_SUPPLIER[r] === id) ||
  null;

function collectTraffic() {
  const enabledIds = Object.keys(PROVIDERS).filter((id) => supplierCfg(id).enabled);
  let currentIds = enabledIds.filter((id) => {
    // 优先用真实观测到的路由 id（pi-ai declared 变体也能命中前缀映射），再退化到精确表
    const routeId = routeForSupplier(id);
    if (!routeId) return true; // 无 DSH 路由 → 恒候选
    if (runtime.channelAlive === null) return true; // 接缝未知 → 启用清单兜底
    const seen = runtime.routeSeen[routeId];
    if (!seen) return false;
    return Date.now() - seen.lastSeenAt <= (runtime.config.trafficWindowHours || 24) * 3600_000;
  });
  // 兜底（用户报告「小组件信息消失」后确认）：没有任何供应商有近期流量时，
  // 小组件按启用清单显示，避免数据健康却渲染成空态；有任一近期流量则维持过滤。
  const trafficStale = enabledIds.length > 0 && currentIds.length === 0;
  if (trafficStale) currentIds = enabledIds;
  const todayOf = (id) => {
    const day = dayKeyOf();
    const hours = runtime.usageBuckets[id];
    if (!hours) return null;
    let sum = 0;
    for (const [key, value] of Object.entries(hours)) {
      if (key.startsWith(day)) sum += Number(value) || 0;
    }
    return sum > 0 ? sum : null;
  };
  return { currentIds, todayOf, trafficStale };
}

// ---------- HTTP ----------

function sameOriginGuard(req, res) {
  const origin = req.headers.origin || "";
  if (!origin) return true; // 非浏览器客户端（curl 等）放行——本机开发姿态
  try {
    const host = new URL(origin).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  } catch {
    /* 解析失败即拒绝 */
  }
  writeJson(res, 403, { ok: false, error: "forbidden" });
  return false;
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function buildStatePayload() {
  const { currentIds, todayOf, trafficStale } = collectTraffic();
  // 流量诊断（供排查「近 24h 无流量」误报；scheme=2 标记新事件折叠代码已生效）
  const winMs = (runtime.config.trafficWindowHours || 24) * 3600_000;
  const windowHours = runtime.config.trafficWindowHours || 24;
  const trafficDiag = {
    scheme: 2,
    channelAlive: runtime.channelAlive,
    windowHours,
    usageFile: runtime.usageFile,
    routes: Object.keys(runtime.routeSeen).map((route) => {
      const seen = runtime.routeSeen[route];
      return {
        route,
        supplier: supplierForRoute(route),
        lastSeenAt: new Date(seen.lastSeenAt).toLocaleTimeString(),
        lastModel: seen.lastModel || null,
      };
    }),
    suppliers: Object.keys(PROVIDERS)
      .filter((id) => supplierCfg(id).enabled)
      .map((id) => {
        const routeId = routeForSupplier(id);
        const seen = routeId ? runtime.routeSeen[routeId] : undefined;
        return {
          id,
          routeId,
          seen: !!seen,
          lastSeenAt: seen ? new Date(seen.lastSeenAt).toLocaleTimeString() : null,
          fresh: !!seen && Date.now() - seen.lastSeenAt <= winMs,
        };
      }),
  };
  return {
    ok: true,
    trafficStale: !!trafficStale,
    traffic: trafficDiag,
    now: new Date().toLocaleTimeString(),
    poll: {
      intervalSeconds: runtime.config.intervalSeconds,
      trafficWindowHours: runtime.config.trafficWindowHours,
      retentionDays: runtime.config.retentionDays || 7,
    },
    suppliers: Object.keys(PROVIDERS).map((id) => {
      const s = runtime.suppliers[id];
      const c = supplierCfg(id);
      const rawC = runtime.config.suppliers?.[id] || {}; // 原始存储（不含环境密钥回退）
      return {
        id,
        name: PROVIDERS[id].name,
        enabled: !!c.enabled,
        current: currentIds.includes(id),
        todayTokens: todayOf(id),
        keySet: !!rawC.apiKey,
        allowanceTokenSet: !!rawC.allowanceToken,
        autoDetected: !!c.autoSource,
        autoSource: c.autoSource || null,
        autoEnvName: c.autoApiKeyEnv || null,
        autoKeySource: c.autoSource ? runtime.harness[id]?.keySource || null : null,
        envKeySet: !!(c.autoSource && runtime.harness[id]?.apiKey),
        warnPct: c.warnPct,
        critPct: c.critPct,
        baseUrl: c.baseUrl,
        orgId: c.orgId || "",
        ...(s.last
          ? s.last
          : { state: "off", error: { code: "no-run", message: "尚未取数" }, headline: { kind: "amt", amt: "—" } }),
      };
    }),
    history: runtime.history.slice(-50),
    detectedUnmapped: runtime.unmapped.map((u) => ({ route: u.route, displayName: u.displayName, ns: u.ns })).slice(0, 20),
    detect: runtime.detect,
  };
}

// ---------- 主入口 ----------

export const inject = ["settings", "webServer"];

export function apply(ctx) {
  const scope = ctx.settings.register(NS, Config, { base: {} });
  runtime.config = scope.get() || {};
  const disposers = [];
  // 本地用量数据：启动时从 DSH 数据目录载入（小时桶），按保留期修剪
  runtime.usageFile = usageFilePath(dshHome());
  runtime.usageBuckets = pruneBuckets(loadUsageFile(runtime.usageFile), runtime.config.retentionDays || 7);

  // ---- 自动探测：DSH harness 里已添加的供应商，自动填入（票 10） ----
  // 探测数据源：ctx.llm 目录/存活路由 + settings 配置节（llm-deepseek / llm-pi-ai）；
  // 「已添加」收紧为 DSH 用户配置文档 user 层有该 profile，或 pi-ai 路由已激活
  // （pi-ai 只为已配置 profile 注册路由；deepseek-official 适配器恒注册，故必须看 user 层）。
  // 填入：不复制密钥——settings 只存 autoSource/autoApiKeyEnv 引用，取数读宿主内存解析结果。
  let tick = 0;
  const syncHarness = async () => {
    const stamp = () => new Date().toLocaleTimeString();
    try {
      const detected = await detectHarnessSuppliers(ctx, {
        debug: true,
        include: (rec) => {
          // deepseek-official 官方适配器恒注册（live 无信息量）：user 层有配置，
          // 或已在 DSH 凭据库（credentials/文件）存过密钥，才认作「已添加」；
          // 纯环境变量直读（env）且无 user 层不算，避免误启用。
          if (rec.route === "deepseek-official") {
            return settingsUserHas(ctx, rec.ns, rec.path) || rec.keySource === "file" || rec.keySource === "credentials";
          }
          // pi-ai 路由只为已配置 profile 注册：已激活/已配置即已添加（配置文档为事实来源）
          return rec.active || rec.configured || settingsUserHas(ctx, rec.ns, rec.path);
        },
      });
      const meta = detected.meta || {};
      runtime.detect = {
        at: stamp(),
        error: null,
        llmPresent: meta.llmPresent,
        credentialsPresent: meta.credentialsPresent,
        directoryEntries: meta.directoryEntries,
        liveRoutes: meta.liveRoutes || [],
        candidates: meta.candidates || [],
        included: detected.map((d) => ({ route: d.route, supplier: d.supplier })),
        found: detected.filter((d) => d.supplier).map((d) => d.supplier),
        unmapped: detected.filter((d) => !d.supplier).map((d) => d.route),
      };
      const harness = {};
      const unmapped = [];
      for (const d of detected) {
        if (d.supplier) {
          harness[d.supplier] = {
            route: d.route,
            baseUrl: d.baseURL,
            apiKeyEnv: d.apiKeyEnv,
            apiKey: d.key,
            keySource: d.keySource,
          };
        } else {
          unmapped.push({ route: d.route, displayName: d.displayName, ns: d.ns });
        }
      }
      runtime.harness = harness;
      runtime.unmapped = unmapped;

      let ownUser = {};
      try {
        ownUser = scope.describe({ redactSecrets: true }).user || {};
      } catch {
        ownUser = {};
      }
      const patch = autoFillPatch(
        detected,
        (id) => runtime.config.suppliers?.[id] || {},
        BASE_URL_DEFAULTS,
        { skipSupplier: (id) => ownUser?.suppliers?.[id]?.enabled === false },
      ).patch;
      if (Object.keys(patch.suppliers || {}).length) {
        // scope.get() 返回的配置是只读对象，绝不能原地改：先持久化，再从 scope 整体换新
        try {
          await ctx.settings.update(NS, patch); // 持久化并触发 watch（runtime.config 随后刷新）
        } catch (error) {
          ctx.logger?.warn?.("[quota-monitor] 自动填入写入失败: %s", error?.message || error);
        }
        try {
          runtime.config = scope.get() || runtime.config; // 采用已提交配置（整体替换，不复制密钥）
        } catch {
          /* 由 scope.watch 接管刷新 */
        }
      }
    } catch (error) {
      runtime.detect = {
        ...runtime.detect,
        at: stamp(),
        error: (error?.stack || String(error)).slice(0, 2000),
      };
      ctx.logger?.warn?.("[quota-monitor] 自动探测失败: %s", error?.message || error);
    }
  };
  syncHarness();
  // llm/settings 服务可能晚于插件 apply 就绪：2s 后再探一次（30s 轮询与拓扑事件继续兜底）
  const bootRetry = setTimeout(() => syncHarness(), 2000);
  disposers.push(() => clearTimeout(bootRetry));

  let ticker = null;
  const startTicker = () => {
    if (ticker) clearInterval(ticker);
    for (const id of Object.keys(PROVIDERS)) {
      if (!runtime.suppliers[id].jitter) runtime.suppliers[id].jitter = Math.floor(Math.random() * 5000); // ±0–5s 起步错峰
    }
    ticker = setInterval(() => {
      tickSuppliers(Date.now());
      // 每 30s 复查 harness 配置（settings 热重载）
      if (++tick % 30 === 0) syncHarness();
    }, 1000);
    disposers.push(() => clearInterval(ticker));
    tickSuppliers(Date.now());
  };
  startTicker();

  disposers.push(
    scope.watch((next) => {
      runtime.config = next || {};
      startTicker();
      syncHarness();
    }),
  );

  // ---- 本地用量数据落盘（防抖 2s；dispose 时同步冲刷） ----
  let saveTimer = null;
  const flushUsage = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!runtime.usageFile) return true;
    const result = saveUsageFile(runtime.usageFile, runtime.usageBuckets, runtime.config.retentionDays || 7);
    if (!result.ok) ctx.logger?.warn?.("[quota-monitor] 用量落盘失败: %s", result.error || result);
    return result.ok;
  };
  const scheduleUsageSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushUsage();
    }, 2000);
    saveTimer.unref?.();
  };

  // ---- 当前供应商与当日消耗量：session/event 折叠（票 04 方案） ----
  // DSH 真实事件载荷（对齐 dsh-session / dsh-token-meter）：
  //   request/header   -> data.header.config.provider（请求发起即流量信号，usage 在后续完成事件）
  //   request/context  -> data.provider
  //   assistant/chunk  -> usage 在 data.chunk.usage（chunk.type==='usage'）；chunk 本身不含
  //                       provider，用会话最近路由兜底（request/header 已先置位）
  //   assistant/message-> provider 在 data.message.source.provider，usage 在 data.usage
  //   usage 字段：inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
  // 同一 (turn, step) 的早期 usage 样本与最终 assistant/message usage 是替换关系
  // （与 dsh-token-meter 的 addReplacing 语义一致），按会话×step 记账避免重复累加。
  const sessionSeen = new WeakMap(); // session -> { provider, lastUsage: {dayKey,turn,step,tokens} }
  ctx.on("session/event", (session, event) => {
    runtime.channelAlive = true;
    try {
      const type = event?.type || "";
      const data = event?.data || {};
      const st = sessionSeen.get(session) || { provider: null, lastUsage: null };
      let provider = null;
      let usage = null;
      let turn = null;
      let step = null;
      if (type === "assistant/message") {
        provider = data?.message?.source?.provider || data?.source?.provider || null;
        usage = data?.usage || null;
        turn = data?.turn ?? null;
        step = data?.step ?? null;
      } else if (type === "assistant/chunk") {
        if (data?.chunk?.type === "usage") usage = data.chunk.usage || null;
        else if (data?.usage) usage = data.usage || null;
        turn = data?.turn ?? null;
        step = data?.step ?? null;
        provider = data?.provider || data?.source?.provider || st.provider || null;
      } else if (type === "request/header") {
        provider = data?.header?.config?.provider || data?.config?.provider || st.provider || null;
      } else if (type === "request/context") {
        provider = data?.provider || st.provider || null;
      } else {
        provider = data?.provider || data?.source?.provider || st.provider || null;
      }
      const route = typeof provider === "string" && provider ? provider : st.provider;
      if (route) {
        const seen = runtime.routeSeen[route] || { lastSeenAt: 0, lastModel: null };
        seen.lastSeenAt = Date.now();
        const model =
          data?.config?.model || data?.model || data?.source?.model ||
          data?.message?.source?.model || data?.header?.config?.model || null;
        if (model) seen.lastModel = model;
        runtime.routeSeen[route] = seen;
        st.provider = route;
      }
      const supplierId = supplierForRoute(route);
      if (supplierId && usage && typeof usage === "object") {
        const tokens =
          (Number(usage.inputTokens ?? usage.uncachedInputTokens) || 0) +
          (Number(usage.outputTokens) || 0) +
          (Number(usage.cacheReadTokens) || 0) +
          (Number(usage.cacheWriteTokens) || 0);
        const hour = hourKeyOf();
        const day = dayKeyOf();
        const hours = runtime.usageBuckets[supplierId] || (runtime.usageBuckets[supplierId] = {});
        const current = Number(hours[hour]) || 0;
        const last = st.lastUsage;
        const sameStep =
          turn !== null && step !== null && !!last && last.hourKey === hour &&
          last.turn === turn && last.step === step;
        const next = Math.max(0, sameStep ? current - last.tokens + tokens : current + tokens);
        if (next > 0) hours[hour] = next;
        else delete hours[hour];
        if (turn !== null && step !== null) st.lastUsage = { hourKey: hour, day, turn, step, tokens };
        scheduleUsageSave();
      }
      sessionSeen.set(session, st);
    } catch {
      /* 事件折叠失败不影响主流程 */
    }
  });

  try {
    ctx.on("llm/adapters-updated", () => {
      // 拓扑变更 → 重探测；但这不是流量观测信号：channelAlive 只能由真实
      // session/event 置位，冷启动（尚未有任何调用）时小组件按启用清单兜底显示，
      // 避免「详情页有数据、小组件却显示暂无供应商」
      syncHarness();
    });
  } catch {
    /* 事件名未注册时忽略 */
  }

  try {
    ctx.on("credentials/reference-updated", () => {
      syncHarness(); // DSH 侧密钥变更 → 重解析（不重启插件）
    });
  } catch {
    /* 事件名未注册时忽略 */
  }

  // ---- HTTP 路由 ----
  const routes = [
    {
      kind: "exact",
      path: `${API_PREFIX}/state`,
      handler: (req, res) => {
        if (!sameOriginGuard(req, res)) return;
        writeJson(res, 200, buildStatePayload());
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/refresh`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res)) return;
        const ids = Object.keys(PROVIDERS).filter((id) => supplierCfg(id).enabled);
        await Promise.allSettled(ids.map((id) => runQuery(id, { force: true })));
        writeJson(res, 200, buildStatePayload());
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/test`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res)) return;
        try {
          const body = await readJson(req);
          const id = body?.supplier;
          if (!id || !PROVIDERS[id]) {
            writeJson(res, 400, { ok: false, error: `未知供应商: ${id}` });
            return;
          }
          const result = await PROVIDERS[id].query(supplierCfg(id));
          writeJson(res, 200, { ok: result.state !== "err" && result.state !== "off", error: result.error?.message, result });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error.message, result: null });
        }
      },
    },
    {
      kind: "exact",
      path: `${API_PREFIX}/settings`,
      handler: async (req, res) => {
        if (!sameOriginGuard(req, res)) return;
        try {
          const patch = await readJson(req);
          await ctx.settings.update(NS, patch); // 深合并；patch 只含 JSON 数据
          writeJson(res, 200, { ok: true });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error.message });
        }
      },
    },
  ];
  for (const route of routes) disposers.push(ctx.webServer.register(route));
  disposers.push(() => flushUsage()); // 退出时同步冲刷本地用量数据

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}