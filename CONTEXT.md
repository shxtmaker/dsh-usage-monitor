# Supplier Quota Monitor (用量监控)

A DeepSeek Harness (DSH) plugin that displays each LLM supplier's available period quota, adapted from the Token-Consumption-Monitoring project's `refactor/unified-query-methods` branch. This context covers the plugin's domain: suppliers, quotas, and the widget that shows them.

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
The abstraction inherited from the upstream repo that gives every supplier the same query interface; the plugin's data layer is built on it.
_Avoid_: adapter layer, provider interface

**小组件 (Widget)**:
The compact, always-visible DSH GUI display showing each supplier's available quota — the plugin's primary surface.
_Avoid_: panel, card

**详情页 (Detail Page)**:
The full view opened from the widget showing every quota field per supplier in a table, plus refresh history.
_Avoid_: detail view, expanded card

**当前供应商 (Current Supplier)**:
A supplier the harness is actually using now — enabled in the DSH configuration and (when traffic data is observable) with recent LLM calls; the widget filters to these. Falls back to the enabled list when traffic isn't observable.
_Avoid_: active provider, used supplier

**当日消耗量 (Daily Usage)**:
Token consumption attributed per supplier from DSH session events, aggregated over the current calendar day (resets at 00:00); suppliers without a DSH route show "—".
_Avoid_: today's usage, daily token count

**刷新 (Refresh)**:
Fetching current quota data; automatic polling on an interval plus a manual refresh action.
_Avoid_: sync, update (verb)

**自动探测 (Auto-detect)**:
The feature that discovers suppliers already added in the DSH harness (via `ctx.llm` registry and `llm-deepseek`/`llm-pi-ai` settings sections) and auto-fills the plugin's settings for supported routes — enabling, Base URL, and the **API key itself** (copied once from DSH's credential seam into the plugin's secret-role settings field; a user-supplied key is never overwritten).
_Avoid_: auto-config, provider discovery