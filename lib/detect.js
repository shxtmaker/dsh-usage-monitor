// lib/detect.js — DSH 供应商自动探测（宿主半）
// 读取 DSH LLM 路由注册表（ctx.llm）与提供方设置文档（ctx.settings / ctx.credentials），
// 把 DSH 内已添加/启用的供应商映射到本插件的供应商，并生成「自动填入」设置补丁。
// 规则（票 10）：
//   - 「已添加」以 DSH 设置文档（llm-deepseek / llm-pi-ai 配置节）为事实来源，
//     ctx.llm 目录/存活路由作为补充（服务未就绪/异常时探测不受影响）
//   - 同一插件供应商命中多条 DSH 路由时按 ROUTE_PRIORITY 去重（官方路由优先）
//   - 补丁含 enabled / baseUrl / autoSource / autoApiKeyEnv / apiKey：
//     密钥本体直接拷贝进插件 settings（role('secret') 自动脱敏），满足「API Key 自动填入」；
//     autoSource/autoApiKeyEnv 同时记录来源，宿主仍保留 credentials/env 兜底解析
//   - 只填用户尚未手动设置过的字段（apiKey 已设 = 手动接管；enabled 显式 false 由调用方跳过）

/** DSH LLM 路由 id → 本插件供应商 id。
 *  deepseek-official = 官方 DeepSeek 适配器；deepseek = llm-pi-ai 目录同名单路由
 *  （同一账号，余额端点一致，故可共用取数）；
 *  opencode / opencode-go、commandcode / commandcode-goat = llm-pi-ai 里用户
 *  实际添加的 OpenCode、Command Code 路由（真实 DSH settings.yaml 形态），
 *  前缀兜底覆盖 declared 变体名。 */
export const DSH_ROUTE_MAP = {
  "deepseek-official": "deepseek",
  "deepseek": "deepseek",
  "opencode": "opencode",
  "opencode-go": "opencode",
  "commandcode": "commandcode",
  "commandcode-goat": "commandcode",
};

/** 前缀兜底：pi-ai declared 路由名带变体（commandcode-goat、opencode-xx 等）仍能命中。 */
const ROUTE_PREFIX_MAP = [
  ["commandcode", "commandcode"],
  ["opencode", "opencode"],
];

/** 路由 id → 插件供应商 id（精确表优先，其次前缀）。 */
export function supplierForRoute(route) {
  if (DSH_ROUTE_MAP[route]) return DSH_ROUTE_MAP[route];
  for (const [prefix, supplier] of ROUTE_PREFIX_MAP) {
    if (route.startsWith(prefix)) return supplier;
  }
  return null;
}

/** 同供应商多路由并存时的优先序（越小越优先；缺省 99）。 */
const ROUTE_PRIORITY = {
  "deepseek-official": 1,
  "deepseek": 2,
};

/** 无 ctx.llm 时按已知适配器家族兜底读取的命名空间。 */
const FALLBACK_NS = {
  "deepseek-official": "llm-deepseek",
  "deepseek": "llm-pi-ai",
};

/** 按 settingsPath 下钻：[] → 整个 section，['providers','x'] → 逐个取键。 */
function dig(obj, path) {
  let cur = obj;
  for (const key of path || []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** 提取 provider profile 的凭据引用与端点（apiKeyEnv/baseURL 为 DSH 适配器统一拼写）。 */
function profileFields(profile) {
  if (!profile || typeof profile !== "object") return { apiKeyEnv: null, baseURL: null, configured: false };
  const apiKeyEnv =
    typeof profile.apiKeyEnv === "string" && profile.apiKeyEnv.trim() ? profile.apiKeyEnv.trim() : null;
  const baseURL =
    typeof profile.baseURL === "string" && profile.baseURL.trim() ? profile.baseURL.trim() : null;
  return { apiKeyEnv, baseURL, configured: !!(apiKeyEnv || baseURL) };
}

/**
 * 探测 DSH 内已添加/启用的供应商。
 * - 数据源（设置文档优先，llm 目录补充）：
 *     1) listConfigurableProviders()/listProviders()（ctx.llm，异常不影响）；
 *     2) ctx.settings.get('llm-deepseek') 整节、ctx.settings.get('llm-pi-ai').providers 字典。
 * - 密钥值通过 ctx.credentials.resolve(ref) 解析（失败时退回 process.env 直读）；
 *   返回记录含 key（仅供宿主侧自动填入使用，严禁经路由/状态暴露给浏览器）。
 * - include(rec) 可由调用方过滤（如只认 DSH user 层已配置的路由）。
 * - debug=true 时结果数组挂 meta（llmPresent / liveRoutes / directoryEntries / candidates），
 *   供运行诊断；candidates 只含非密钥字段。
 * @param ctx  Cordis ctx（llm/credentials 为可选服务，用 ctx.get 获取）
 */
export async function detectHarnessSuppliers(ctx, { include = () => true, debug = false } = {}) {
  const get = typeof ctx?.get === "function" ? ctx.get.bind(ctx) : () => undefined;
  const llm = get("llm") || ctx?.llm;
  const credentials = get("credentials") || ctx?.credentials;
  const meta = {
    llmPresent: !!llm,
    credentialsPresent: !!credentials,
    directoryEntries: 0,
    liveRoutes: [],
    candidates: [],
  };

  const live = new Set();
  try {
    for (const p of llm?.listProviders?.() ?? []) {
      if (p && p.id) live.add(p.id);
    }
  } catch { /* llm 异常 → 按设置文档兜底 */ }
  meta.liveRoutes = [...live];

  const entries = new Map();
  try {
    for (const entry of llm?.listConfigurableProviders?.() ?? []) {
      if (entry && entry.provider) entries.set(entry.provider, entry);
    }
  } catch { /* llm 异常 → 按设置文档兜底 */ }

  // 设置文档兜底：无论 ctx.llm 是否可用/就绪，配置节里已添加的供应商都纳入候选
  try {
    const ds = ctx?.settings?.get?.("llm-deepseek");
    if (profileFields(ds).configured) {
      entries.set("deepseek-official", {
        provider: "deepseek-official",
        displayName: "DeepSeek",
        settingsNs: "llm-deepseek",
        settingsPath: [],
      });
    }
  } catch { /* 忽略 */ }
  try {
    const pi = ctx?.settings?.get?.("llm-pi-ai");
    for (const [provider, profile] of Object.entries(pi?.providers || {})) {
      if (profile && typeof profile === "object") {
        entries.set(provider, {
          provider,
          displayName: profile.displayName || provider,
          settingsNs: "llm-pi-ai",
          settingsPath: ["providers", provider],
          declared: true,
        });
      }
    }
  } catch { /* 忽略 */ }

  meta.directoryEntries = entries.size;
  const routes = [...entries.keys()].sort(
    (a, b) => (ROUTE_PRIORITY[a] ?? 99) - (ROUTE_PRIORITY[b] ?? 99) || a.localeCompare(b),
  );

  const raw = [];
  for (const route of routes) {
    const entry = entries.get(route) || {};
    const ns = entry.settingsNs || FALLBACK_NS[route];
    const path = entry.settingsPath || [];
    let profile;
    if (ns && ctx?.settings?.get) {
      try {
        profile = dig(ctx.settings.get(ns), path);
      } catch {
        profile = undefined;
      }
    } else if (FALLBACK_NS[route]) {
      try {
        profile = ctx?.settings?.get?.(FALLBACK_NS[route]);
      } catch {
        profile = undefined;
      }
    }

    const { apiKeyEnv, baseURL, configured } = profileFields(profile);
    const active = live.has(route);
    if (!active && !configured) continue; // 未添加也未启用 → 不算「已添加」

    const rec = {
      route,
      supplier: supplierForRoute(route),
      displayName: entry.displayName || route,
      ns: ns || null,
      path: [...(entry.settingsPath || [])],
      active,
      configured,
      declared: entry.declared || null,
      apiKeyEnv,
      keyPresent: false,
      keySource: null, // 'credentials' | 'file' | 'env' | null
      key: null,
      baseURL,
    };

    if (apiKeyEnv) {
      let value;
      let source;
      if (credentials?.resolve) {
        try {
          const hit = await credentials.resolve(apiKeyEnv);
          if (hit && typeof hit === "object" && hit.value) {
            value = hit.value;
            source = hit.source || "credentials";
          }
        } catch {
          /* 解析失败 → 环境变量兜底 */
        }
      }
      if (!value) {
        try {
          const envValue = typeof process !== "undefined" ? process.env?.[apiKeyEnv] : undefined;
          if (envValue) {
            value = envValue;
            source = "env";
          }
        } catch {
          /* 忽略 */
        }
      }
      rec.keyPresent = !!value;
      rec.key = value || null;
      rec.keySource = source || null;
    }

    if (debug) {
      meta.candidates.push({
        route: rec.route,
        supplier: rec.supplier,
        displayName: rec.displayName,
        active: rec.active,
        configured: rec.configured,
        ns: rec.ns,
        apiKeyEnv: rec.apiKeyEnv,
        baseURL: rec.baseURL,
        keyPresent: rec.keyPresent,
        keySource: rec.keySource,
      });
    }
    if (!include(rec)) continue;
    raw.push(rec);
  }

  // 同供应商多路由去重：官方路由优先（routes 已按 ROUTE_PRIORITY 排序）
  const picked = new Map();
  const rest = [];
  for (const rec of raw) {
    if (rec.supplier && picked.has(rec.supplier)) continue;
    if (rec.supplier) picked.set(rec.supplier, rec);
    else rest.push(rec); // 未映射路由全部保留（供 UI 提示）
  }
  const result = [...picked.values(), ...rest];
  if (debug) result.meta = meta;
  return result;
}

/**
 * 由探测结果生成设置补丁（不复制密钥）。
 * @param detected        detectHarnessSuppliers(ctx) 的结果
 * @param getCurrent      (supplierId) => 当前插件设置（enabled/apiKey/baseUrl…）
 * @param baseUrlDefaults { supplierId: 插件默认 baseUrl }
 * @param opts.skipSupplier (supplierId) => boolean  用户显式关闭等情形跳过自动填入
 * @returns { patch, applied, unfilled }
 *   patch.suppliers[id] 含 enabled/baseUrl/autoSource/autoApiKeyEnv/apiKey（密钥为探测解析值）；
 *   applied: [{ supplier, fields }]；
 *   unfilled: [{ supplier 或 route, reason: 'no-key' | 'unsupported' }]
 */
export function autoFillPatch(detected, getCurrent, baseUrlDefaults, { skipSupplier = () => false } = {}) {
  const patch = { suppliers: {} };
  const applied = [];
  const unfilled = [];
  for (const d of detected) {
    if (!d.supplier) {
      unfilled.push({ route: d.route, displayName: d.displayName, reason: "unsupported" });
      continue;
    }
    if (skipSupplier(d.supplier)) continue;
    const cur = getCurrent(d.supplier) || {};
    if (cur.apiKey) continue; // 已手动设置密钥 → 手动接管，不动
    const fields = [];
    const p = {};
    const defaultBase = baseUrlDefaults[d.supplier];
    const currentBase = String(cur.baseUrl || "");
    if ((!currentBase || currentBase === defaultBase) && d.baseURL && d.baseURL !== currentBase) {
      p.baseUrl = d.baseURL;
      fields.push("Base URL");
    }
    if (d.ns && (cur.autoSource || "") !== d.ns) {
      p.autoSource = d.ns;
      fields.push("来源");
    }
    if ((cur.autoApiKeyEnv || "") !== (d.apiKeyEnv || "")) {
      p.autoApiKeyEnv = d.apiKeyEnv || "";
      fields.push("密钥引用");
    }
    const keyOk = d.keyPresent && !!d.key;
    if (keyOk && !cur.apiKey) {
      // API Key 自动填入：拷贝探测解析出的 DSH 密钥本体（role('secret') 脱敏保存）
      p.apiKey = d.key;
      fields.push("API Key");
    }
    if (keyOk && !cur.enabled) {
      p.enabled = true;
      fields.push("启用");
    } else if (!keyOk) {
      unfilled.push({ supplier: d.supplier, route: d.route, reason: "no-key" });
    }
    if (fields.length) {
      patch.suppliers[d.supplier] = p;
      applied.push({ supplier: d.supplier, fields });
    }
  }
  return { patch, applied, unfilled };
}
