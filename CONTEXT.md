# Supplier Quota Monitor (用量监控)

A DeepSeek Harness (DSH) plugin that displays each LLM supplier's available period quota / balance / reported usage & cost. Since v0.3 the data layer tracks Token-Consumption-Monitoring `main` (v1.3.x) [docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md): supplier registry is split by **凭据类别 × 地域** (13 entries, metadata-driven), with auto-identification of every plain API key found in the DSH harness. This context covers the plugin's domain: suppliers, credentials classes, quotas, the sidebar strip's current-in-use supplier display, and the widget that shows them.

## Language

**供应商 (Supplier)**:
An LLM API provider whose quota the plugin queries (DeepSeek, OpenAI, Anthropic, OpenRouter, …).
_Avoid_: Provider, service, vendor

**周期限额 (Period Quota)**:
A supplier's allowance measured against a recurring period: 限额 limit / 已用 used / 剩余 remaining / 重置时间 reset time, whichever subset that supplier exposes.
_Avoid_: monthly limit, allowance

**可用周期限额 (Available Quota)**:
The remaining headroom of the current period — what the plugin's display shows as the headline number. Also covers balance (余额) and rate-limit headroom (速率限额余量) since suppliers disagree on what "quota" means; the display normalizes to limit/used/remaining/reset with blanks for what a supplier doesn't expose.

**限额项 (Limit Entry)**:
A supplier's individual quota line — a balance, a rolling/window limit, an allowance meter, or a credit plan. The widget's expandable sub-row and the detail page's grouped rows operate at this granularity.
_Avoid_: quota item, metric row

**余额 (Balance)**:
Remaining prepaid balance on a supplier account (e.g. DeepSeek's topped-up vs granted balance).
_Avoid_: credits (except OpenRouter's own term), wallet

**速率限额 (Rate Limit)**:
Per-window RPM/TPM or per-day request limits, usually reported via response headers rather than an endpoint.
_Avoid_: throttle, 限流 (verb)

**统一查询方法 (Unified Query Methods)**:
The abstraction inherited from the upstream repo that gives every supplier the same query interface; the plugin's data layer is built on it. The port only keeps pure-HTTP methods with strict official host/base-path validation; Windows-only methods (WebView2 console, local SQLite, local Codex CLI login) are dropped.
_Avoid_: adapter layer, provider interface

**凭据类别 (Credential Class)**:
What kind of secret a supplier page needs — 普通 API Key (chat key also queryable for the supplier's own balance/plan windows), 组织 Admin Key (OpenAI/Anthropic org usage & cost), Management Key (OpenRouter account credits). Classes never substitute for one another; the auto-detect layer maps plain DSH chat keys only to api-key-class suppliers.
_Avoid_: key type dropdown, credential kind

**各 API key 自动识别 (Auto-Identify Every API Key)**:
v0.3 auto-detect: every plain API key present in the DSH seam (`llm-deepseek` section + `llm-pi-ai.providers` dictionary, resolved via `ctx.credentials` then `process.env`) is attributed to its supplier by route name (exact/prefix) with an official-host fallback, then enabled with official Base URL + key copy. Admin/Management suppliers are never auto-filled from chat keys — the settings UI marks them "需手动填写"; OpenAI/Anthropic chat routes are detected only to surface that hint.
_Avoid_: guessing by key prefix (upstream forbids it)

**小组件 (Widget)**:
The compact, always-visible DSH GUI display showing which model supplier the harness is using right now. Since v0.2 it is embedded through the official `sidebar.footer.action` slot (list, keyed `quota-monitor`) rendered by the sidebar shell in the foot area in normal content flow — no DOM scraping, no floating/fixed panel — and switches to an icon-only rail state when the sidebar collapses. The wide strip's main display is the **在用供应商** (supplier · model of the latest real call); its Popover lists **当前供应商** quota entries.
_Avoid_: panel, card

**详情页 (Detail Page)**:
The full view opened from the widget showing every quota field per supplier in a table, plus refresh history.
_Avoid_: detail view, expanded card

**当前供应商 (Current Supplier)**:
A supplier the harness is actually using now — enabled in the DSH configuration and (when traffic data is observable) with recent LLM calls; the widget filters to these. Falls back to the enabled list when traffic isn't observable.
_Avoid_: active provider, used supplier

**在用供应商 (Active Supplier)**:
The supplier of the **most recent** real LLM call observed from `session/event`, carrying the model name of that call; this is what the wide sidebar compact strip shows by default (「在用 DeepSeek · deepseek-chat」+ relative time). Before any call it shows "暂无调用"; it is independent of the enabled/current filtering that governs the popover list.
_Avoid_: active provider, 当前路由供应商, 正在调用的 provider

**当日消耗量 (Daily Usage)**:
Token consumption attributed per supplier from DSH session events, aggregated over the current calendar day (resets at 00:00); suppliers without a DSH route show "—". Backed by the plugin's **本地用量数据** so it survives restarts.
_Avoid_: today's usage, daily token count

**本地用量数据 (Local Usage Data)**:
The plugin's token-consumption statistics persisted as supplier × hourly buckets in `$DSH_HOME/quota-monitor/usage.json` (atomic write with a 2s debounce), surviving restarts and pruned by the **保留期**. Distinct from the in-memory **刷新历史**.
_Avoid_: local cache, on-disk history, cloud stats

**保留期 (Retention Window)**:
How far back **本地用量数据** is kept (default 7 days, 1–90 configurable in the plugin settings); older hourly buckets are pruned on load and on every save.
_Avoid_: history days, data range

**刷新 (Refresh)**:
Fetching current quota data; automatic polling on an interval plus a manual refresh action.
_Avoid_: sync, update (verb)

**自动探测 (Auto-detect)**:
The feature that discovers suppliers already added in the DSH harness (via `ctx.llm` registry and `llm-deepseek`/`llm-pi-ai` settings sections) and auto-fills the plugin's settings for supported routes — enabling, Base URL (adopted only when the DSH route address passes the supplier's official host/path whitelist), and the **API key itself** (copied once from DSH's credential seam into the plugin's secret-role settings field; a user-supplied key is never overwritten; an explicitly disabled supplier is never re-enabled).
_Avoid_: auto-config, provider discovery

**官方查询覆盖 (Official Query Coverage)**:
The supplier/endpoint matrix ported from upstream docs/query-coverage.md: DeepSeek multi-currency balance, OpenRouter key quota + daily cost, Moonshot cn/intl balance, Z.ai/智谱 Coding Plan windows, MiniMax Token Plan windows (explicit remaining percent only), OpenAI/Anthropic org usage & cost for the last completed UTC day; OpenCode/Command Code remain private-compat sources. Coverage boundaries (no invented reset times/weekly windows/absolute token counts) carry over.
_Avoid_: adapters, endpoints table