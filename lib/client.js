// lib/client.js — 客户端半（浏览器，经 /plugins/quota-monitor/client.js 加载）
// dsh-quota-monitor UI：C 式状态点小组件（sidebar）+ B 式供应商分栏详情页 + 设置面板。
// 纯 React.createElement（无构建步骤）；样式注入 DSW 主题变量。
(function () {
  window.__ModuleLoader__.load({
    id: "dsh-quota-monitor",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const { createRoot } = require("react-dom/client");
      const h = React.createElement;

      const NS = "quota-monitor";
      const API = "/api/quota-monitor";
      const POLL_MS = 30_000;

      // ---------- 工具 ----------
      const fmtBig = (n) => {
        if (n === null || n === undefined) return "—";
        const v = Number(n);
        if (!Number.isFinite(v)) return "—";
        if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
        if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3)}K`;
        return String(v);
      };
      const stateClass = (s) => s?.state || "off";
      const stateLabel = (s) => {
        if (!s) return "—";
        if (s.state === "err") return "取数失败";
        if (s.state === "off") return "未配置";
        const e = (s.entries || []).find((x) => x.pct !== null && x.pct !== undefined);
        if (!e) return "正常";
        return e.pct >= (s.critPct ?? 95) ? "临界" : e.pct >= (s.warnPct ?? 80) ? "警告" : "正常";
      };

      // ---------- 样式 ----------
      const CSS = `
[data-dsh-qm-widget]{box-sizing:border-box;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;
  border-top:1px solid var(--dsw-alias-border-l1,#262d3d);padding:8px 10px;
  background:var(--dsw-alias-bg-layer-1,#151922);}
[data-dsh-qm-widget] .qm-head{display:flex;align-items:center;justify-content:space-between;
  color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:6px;}
[data-dsh-qm-widget] .qm-head b{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;}
[data-dsh-qm-widget] .qm-btn{background:none;border:none;color:var(--dsw-alias-state-business-primary,#4f8cff);
  cursor:pointer;font-size:11px;padding:0 4px;}
[data-dsh-qm-widget] .qm-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;}
[data-dsh-qm-widget] .qm-row:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
[data-dsh-qm-widget] .qm-dot{width:9px;height:9px;border-radius:50%;flex:none;}
[data-dsh-qm-widget] .qm-dot.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
[data-dsh-qm-widget] .qm-dot.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
[data-dsh-qm-widget] .qm-dot.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
[data-dsh-qm-widget] .qm-dot.err{background:var(--dsw-alias-label-tertiary,#6b7280);}
[data-dsh-qm-widget] .qm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dsh-qm-widget] .qm-pct{font-weight:700;}
[data-dsh-qm-widget] .qm-pct.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
[data-dsh-qm-widget] .qm-pct.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
[data-dsh-qm-widget] .qm-pct.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
[data-dsh-qm-widget] .qm-pct.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
[data-dsh-qm-widget] .qm-today{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;flex:none;}
[data-dsh-qm-widget] .qm-today-total{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;margin-right:6px;}
[data-dsh-qm-widget] .qm-empty{color:var(--dsw-alias-label-tertiary,#8b94a8);padding:8px 4px;}
[data-dsh-qm-widget] .qm-empty button{display:block;margin-top:6px;}
[data-dsh-qm-widget] .qm-empty .qm-btn{font-size:12px;}
[data-dsh-qm-widget] .qm-stale{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;margin:2px 2px 4px;}
.qm-pop{position:fixed;z-index:1200;min-width:280px;max-width:340px;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:10px;padding:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.5));
  color:var(--dsw-alias-label-primary,#dbe2ee);font-size:12px;font-family:var(--dsw-font-family),sans-serif;}
.qm-pop h4{margin:0 0 8px;font-size:13px;}
.qm-pop .prow{display:flex;justify-content:space-between;gap:10px;padding:2px 0;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-pop .prow b{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;text-align:right;}
.qm-pop .pnote{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:11px;}
.qm-pop .perr{color:var(--dsw-alias-state-error-primary,#f87171);margin-top:6px;font-size:11px;}
.qm-pop .pmain{display:flex;gap:8px;margin-top:10px;}
.qm-pop .pmain button{flex:1;border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:5px 0;cursor:pointer;font-size:12px;}
.qm-pop .pmain button:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-overlay{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}
.qm-overlay .qm-card{width:min(880px,94vw);max-height:86vh;overflow:auto;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:14px;padding:16px;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),sans-serif;}
.qm-overlay .qm-card h3{margin:0 0 4px;font-size:15px;}
.qm-overlay .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
.qm-overlay .qm-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.qm-overlay .qm-toolbar button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:12px;}
.qm-overlay .qm-toolbar button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-cols{display:flex;gap:12px;overflow-x:auto;padding-bottom:6px;}
.qm-col{flex:1;min-width:210px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);overflow:hidden;}
.qm-col h5{margin:0;padding:8px 10px;font-size:12px;display:flex;justify-content:space-between;align-items:center;
  border-bottom:1px solid var(--dsw-alias-border-l1,#262d3d);}
.qm-col .qm-cur{color:var(--dsw-alias-label-tertiary,#8b94a8);font-weight:400;font-size:10px;}
.qm-card-item{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#1d2330);}
.qm-card-item:last-child{border-bottom:none;}
.qm-card-item .ci-name{color:var(--dsw-alias-label-secondary,#8b94a8);font-size:11px;display:flex;justify-content:space-between;}
.qm-card-item .ci-big{font-weight:700;font-size:14px;margin:2px 0;}
.qm-card-item .ci-big.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-card-item .ci-big.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-card-item .ci-big.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-card-item .ci-big.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-card-item .ci-row{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-card-item .ci-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:11px;margin-top:4px;}
.qm-pill{display:inline-block;padding:0 8px;border-radius:9px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-pill.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);border-color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-pill.crit{color:var(--dsw-alias-state-error-primary,#f87171);border-color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-pill.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-pill.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-history{margin-top:14px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-history summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);list-style:none;}
.qm-history table{width:100%;border-collapse:collapse;font-size:11px;}
.qm-history td,.qm-history th{padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1,#1d2330);text-align:left;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-history .h-ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-history .h-bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings input[type=text],.qm-settings input[type=password],.qm-settings input[type=number]{
  width:100%;box-sizing:border-box;background:var(--dsw-specific-input-major,#1c2230);
  border:1px solid var(--dsw-alias-border-l2,#262d3d);border-radius:8px;color:var(--dsw-alias-label-primary,#dbe2ee);
  padding:6px 8px;font-size:12px;font-family:inherit;margin-top:2px;}
.qm-settings input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:1px;}
.qm-settings label{display:block;margin-bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-settings .s-group{border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:10px 12px;margin-bottom:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-settings .s-group h5{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:center;}
.qm-settings .s-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;}
.qm-settings .s-row{display:flex;gap:8px;align-items:center;margin-bottom:6px;}
.qm-settings .s-row input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test{margin-left:8px;border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:6px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:2px 10px;font-size:11px;}
.qm-settings .s-test-res{font-size:11px;margin-left:8px;}
.qm-settings .s-test-res.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .s-test-res.bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .s-actions{display:flex;gap:8px;justify-content:flex-end;}
.qm-settings .s-actions button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:5px 14px;font-size:12px;}
.qm-settings .s-actions button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-settings .s-saved{color:var(--dsw-alias-state-success-primary,#34d399);font-size:11px;align-self:center;}
      `;

      // ---------- API ----------
      const getState = () => fetch(`${API}/state`, { cache: "no-store" }).then((r) => r.json());
      const post = (path, body) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then((r) => r.json());

      // ---------- 组件 ----------
      function Dot({ state }) {
        return h("span", { className: `qm-dot ${stateClass(state)}` });
      }

      function Widget({ data, onOpenPopup, onOpenDetail, onOpenSettings, onRefresh }) {
        const currents = (data?.suppliers || []).filter((s) => s.current);
        const totalToday = currents.reduce(
          (sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0),
          0,
        );
        const rows =
          currents.length === 0
            ? h("div", { className: "qm-empty" }, "暂无当前供应商",
                h("button", { className: "qm-btn", onClick: onOpenSettings }, "打开设置"))
            : currents.map((s) =>
                h("div", { key: s.id, className: "qm-row", onClick: () => onOpenPopup(s) },
                  h(Dot, { state: s }),
                  h("span", { className: "qm-name" }, s.name),
                  s.headline?.kind === "pct"
                    ? h("span", { className: `qm-pct ${stateClass(s)}` }, s.headline.pct || "—")
                    : h("span", { className: `qm-pct ${stateClass(s)}` }, s.headline?.amt || "—"),
                  s.todayTokens !== null && s.todayTokens !== undefined
                    ? h("span", { className: "qm-today" }, `今日 ${fmtBig(s.todayTokens)}`)
                    : null,
                ),
              );
        return h("div", { "data-dsh-qm-widget": "" },
          h("div", { className: "qm-head" },
            h("b", null, "用量"),
            h("span", null,
              totalToday > 0 ? h("span", { className: "qm-today-total" }, `今日 ${fmtBig(totalToday)}`) : null,
              `每 ${data?.poll?.intervalSeconds ?? 60}s`,
              h("button", { className: "qm-btn", onClick: onRefresh }, "⟳ 刷新"),
              h("button", { className: "qm-btn", onClick: onOpenDetail }, "详情"),
            ),
          ),
          data?.trafficStale && currents.length > 0
            ? h("div", { className: "qm-stale" },
                `近 ${data?.poll?.trafficWindowHours ?? 24}h 无流量 · 按启用清单显示`)
            : null,
          rows,
        );
      }

      function Popover({ s, anchor, onClose, onOpenDetail }) {
        const entries = s.entries || [];
        return h("div", { className: "qm-pop", style: anchor },
          h("h4", null, s.name, s.todayTokens !== null && s.todayTokens !== undefined ? ` · 今日 ${fmtBig(s.todayTokens)}` : ""),
          entries.map((e) =>
            h("div", { key: e.name },
              h("div", { className: "prow" }, h("span", null, e.name), h("b", null, e.pct !== null && e.pct !== undefined ? `${e.pct}%` : e.remain)),
              h("div", { className: "prow" },
                h("span", null, `${e.limit !== "—" ? `限额 ${e.limit} · ` : ""}已用 ${e.used}`),
                h("span", null, e.reset),
              ),
              e.note ? h("div", { className: "pnote" }, e.note) : null,
            ),
          ),
          s.error ? h("div", { className: "perr" }, `⚠ ${s.error.message || s.error.code}`) : null,
          h("div", { className: "prow" }, h("span", null, "上次刷新"), h("span", null, s.fetchedAt || "—")),
          h("div", { className: "pmain" },
            h("button", { onClick: () => onOpenDetail() }, "详情"),
            h("button", { onClick: onClose }, "关闭"),
          ),
        );
      }

      function EntryCard({ e }) {
        const pct = e.pct !== null && e.pct !== undefined ? `${e.pct}%` : e.remain || "—";
        const cls = pct === "—" ? "err" : Number.parseFloat(e.pct) >= 95 ? "crit" : Number.parseFloat(e.pct) >= 80 ? "warn" : "ok";
        return h("div", { className: "qm-card-item" },
          h("div", { className: "ci-name" }, h("span", null, e.name), h("span", null, e.reset)),
          h("div", { className: `ci-big ${cls}` }, pct),
          h("div", { className: "ci-row" }, h("span", null, `限额 ${e.limit}`), h("span", null, `已用 ${e.used}`)),
          e.note ? h("div", { className: "ci-row" }, h("span", null, e.note)) : null,
          e.pct === null && e.kind === "bal" ? h("div", { className: "ci-err" }, "无限额概念（余额）") : null,
        );
      }

      function Detail({ data, onClose, onRefresh, onOpenSettings }) {
        const cols = (data?.suppliers || []).map((s) => {
          const face = s.entries?.length ? s.entries : [{ name: s.error?.message || "无数据", limit: "—", used: "—", remain: "—", pct: null, reset: "—", note: "", err: true }];
          return h("div", { key: s.id, className: "qm-col" },
            h("h5", null,
              h("span", null, s.name, s.current ? h("span", { className: "qm-cur" }, " · 当前") : null),
              h("span", { className: `qm-pill ${stateClass(s)}` }, stateLabel(s)),
            ),
            face.map((e, i) => (e.err ? h("div", { key: i, className: "qm-card-item" }, h("div", { className: "ci-err" }, e.name)) : h(EntryCard, { key: i, e }))),
          );
        });
        const hist = data?.history || [];
        return h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() },
          h("div", { className: "qm-card" },
            h("h3", null, "供应商限额明细"),
            h("div", { className: "qm-sub" },
              `全部已配置供应商（共 ${(data?.suppliers || []).length}）· 最近刷新 ${data?.now || "—"} · 轮询 ${data?.poll?.intervalSeconds ?? 60}s`,
            ),
            h("div", { className: "qm-toolbar" },
              h("button", { className: "qm-pri", onClick: onRefresh }, "⟳ 刷新全部"),
              h("button", { onClick: onOpenSettings }, "设置"),
              h("button", { onClick: onClose }, "关闭"),
            ),
            h("div", { className: "qm-cols" }, cols),
            h("details", { className: "qm-history" },
              h("summary", null, `刷新历史（最近 ${Math.min(hist.length, 50)} 条）`),
              h("table", null,
                h("thead", null, h("tr", null, h("th", null, "时间"), h("th", null, "供应商"), h("th", null, "结果"), h("th", null, "主指标"), h("th", null, "备注"))),
                h("tbody", null, hist.map((r, i) =>
                  h("tr", { key: i },
                    h("td", null, r.t), h("td", null, r.supplier),
                    h("td", { className: r.ok ? "h-ok" : "h-bad" }, r.ok ? "成功" : "失败"),
                    h("td", null, r.summary), h("td", null, r.error || ""),
                  ),
                )),
              ),
            ),
          ),
        );
      }

      function Settings({ data, onClose, onSave, onTest }) {
        const supps = data?.suppliers || [];
        const [form, setForm] = React.useState(() => {
          const init = {
            intervalSeconds: data?.poll?.intervalSeconds ?? 60,
            retentionDays: data?.poll?.retentionDays ?? 7,
            suppliers: {},
          };
          for (const s of supps) {
            init.suppliers[s.id] = {
              enabled: s.enabled,
              apiKey: "",
              allowanceToken: "",
              orgId: s.orgId || "",
              baseUrl: s.baseUrl || "",
              warnPct: s.warnPct ?? 80,
              critPct: s.critPct ?? 95,
            };
          }
          return init;
        });
        const [testState, setTestState] = React.useState({});
        const [saved, setSaved] = React.useState(false);
        const set = (id, key, value) => setForm((f) => ({ ...f, suppliers: { ...f.suppliers, [id]: { ...f.suppliers[id], [key]: value } } }));

        const groups = supps.map((s) =>
          h("div", { key: s.id, className: "s-group" },
            h("h5", null,
              h("span", null, s.name),
              h("span", { className: "s-row" },
                h("input", { type: "checkbox", checked: form.suppliers[s.id].enabled, onChange: (e) => set(s.id, "enabled", e.target.checked) }),
                h("span", null, "启用"),
                h("button", { className: "s-test", onClick: () => { setTestState({ ...testState, [s.id]: "测试中…" }); onTest(s.id).then((r) => setTestState((t) => ({ ...t, [s.id]: r }))); } }, "测试连接"),
                testState[s.id] && typeof testState[s.id] === "string" ? h("span", { className: "s-test-res bad" }, testState[s.id]) : null,
                testState[s.id] && typeof testState[s.id] === "object" ? h("span", { className: `s-test-res ${testState[s.id].ok ? "ok" : "bad"}` }, testState[s.id].ok ? "连接正常" : (testState[s.id].error || "失败")) : null,
              ),
            ),
            s.autoDetected ? h("div", { className: "pnote", style: { marginBottom: 8 } },
              s.enabled
                ? `已自动探测 DSH 的 ${s.autoSource} 配置：已启用、Base URL 自动填入、API Key 已自动填入（来源 ${s.autoEnvName || (s.autoKeySource === "env" ? "环境变量" : "DSH 凭据库")}，留空即可使用）`
                : `已自动探测 DSH 的 ${s.autoSource} 配置：Base URL 与密钥引用已填入，但密钥暂不可解析，未自动启用`) : null,
            h("label", null, "API Key",
              h("input", { type: "password", placeholder: s.keySet ? "已设置（留空保持不变）" : s.autoDetected && s.envKeySet ? `自动读取 ${s.autoEnvName || "DSH 密钥"}` : "未设置", value: form.suppliers[s.id].apiKey, onChange: (e) => set(s.id, "apiKey", e.target.value) }),
            ),
            s.id === "opencode" ? h("label", null, "allowance Token（OAuth）",
              h("input", { type: "password", placeholder: s.allowanceTokenSet ? "已设置（留空保持不变）" : "未设置", value: form.suppliers[s.id].allowanceToken, onChange: (e) => set(s.id, "allowanceToken", e.target.value) }),
            ) : null,
            s.id === "opencode" ? h("label", null, "org id（可选）",
              h("input", { type: "text", value: form.suppliers[s.id].orgId, onChange: (e) => set(s.id, "orgId", e.target.value) }),
            ) : null,
            h("div", { className: "s-grid" },
              h("label", null, "Base URL",
                h("input", { type: "text", value: form.suppliers[s.id].baseUrl, onChange: (e) => set(s.id, "baseUrl", e.target.value) }),
              ),
              h("label", null, "警告阈值 %",
                h("input", { type: "number", min: 1, max: 99, value: form.suppliers[s.id].warnPct, onChange: (e) => set(s.id, "warnPct", Number(e.target.value)) }),
              ),
              h("label", null, "临界阈值 %",
                h("input", { type: "number", min: 1, max: 100, value: form.suppliers[s.id].critPct, onChange: (e) => set(s.id, "critPct", Number(e.target.value)) }),
              ),
            ),
          ),
        );

        const save = () => {
          const patch = { intervalSeconds: form.intervalSeconds, retentionDays: form.retentionDays, suppliers: {} };
          for (const s of supps) {
            const f = form.suppliers[s.id];
            const p = {
              enabled: f.enabled,
              baseUrl: f.baseUrl,
              warnPct: f.warnPct,
              critPct: f.critPct,
            };
            if (s.id === "opencode") p.orgId = f.orgId;
            if (f.apiKey.trim()) p.apiKey = f.apiKey.trim();
            if (s.id === "opencode" && f.allowanceToken.trim()) p.allowanceToken = f.allowanceToken.trim();
            patch.suppliers[s.id] = p;
          }
          onSave(patch).then(() => { setSaved(true); setTimeout(() => onClose(), 600); });
        };

        return h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() },
          h("div", { className: "qm-card qm-settings" },
            h("h3", null, "用量监控设置"),
            h("div", { className: "qm-sub" }, "密钥保存在 DSH settings（settings.yaml），此处只回显掩码；留空 = 保持原值"),
            h("div", { className: "s-grid" },
              h("label", null, "轮询间隔（秒，10–3600）",
                h("input", { type: "number", min: 10, max: 3600, value: form.intervalSeconds, onChange: (e) => setForm((f) => ({ ...f, intervalSeconds: Number(e.target.value) })) }),
              ),
              h("label", null, "用量保留期（天，1–90）",
                h("input", { type: "number", min: 1, max: 90, value: form.retentionDays, onChange: (e) => setForm((f) => ({ ...f, retentionDays: Number(e.target.value) })) }),
              ),
            ),
            groups,
            data && data.detectedUnmapped && data.detectedUnmapped.length ? h("div", { className: "pnote" }, `另探测到 DSH 内已添加但本插件暂不支持的供应商：${data.detectedUnmapped.map((u) => u.displayName || u.route).join("、")}`) : null,
            h("div", { className: "s-actions" },
              saved ? h("span", { className: "s-saved" }, "已保存 ✓") : null,
              h("button", { onClick: onClose }, "取消"),
              h("button", { className: "qm-pri", onClick: save }, "保存"),
            ),
          ),
        );
      }

      // ---------- 应用 ----------
      const inject = ["slots", "connection", "settingsScope", "locale"];

      function apply(ctx) {
        let root = null;
        let popRoot = null;
        let overlayRoot = null;
        let timer = null;
        let layoutDispose = null;
        let state = null;
        let popup = null; // {s, anchor}
        let view = null; // 'detail' | 'settings' | null

        const renderAll = () => {
          if (!root) return;
          const data = state;
          root.render(
            h(Widget, {
              data,
              onOpenPopup: (s) => { popup = { s, anchor: { left: 12, top: Math.max(12, window.innerHeight - 320) } }; renderAll(); },
              onOpenDetail: () => { view = "detail"; renderAll(); },
              onOpenSettings: () => { view = "settings"; renderAll(); },
              onRefresh: refreshAll,
            }),
          );
          if (popRoot) {
            if (popup) popRoot.render(h(Popover, { s: popup.s, anchor: popup.anchor, onClose: () => { popup = null; renderAll(); }, onOpenDetail: () => { popup = null; view = "detail"; renderAll(); } }));
            else popRoot.render(null);
          }
          if (overlayRoot) {
            if (view === "detail") overlayRoot.render(h(Detail, { data, onClose: () => { view = null; renderAll(); }, onRefresh: refreshAll, onOpenSettings: () => { view = "settings"; renderAll(); } }));
            else if (view === "settings") overlayRoot.render(h(Settings, { data, onClose: () => { view = null; renderAll(); }, onSave: saveSettings, onTest: testSupplier }));
            else overlayRoot.render(null);
          }
        };

        const load = async () => {
          try {
            state = await getState();
            renderAll();
          } catch (error) {
            console.error("[quota-monitor] state fetch failed", error);
          }
        };

        const refreshAll = async () => {
          try {
            const next = await post(`${API}/refresh`);
            if (next?.ok !== false) { state = next; renderAll(); }
          } catch (error) {
            console.error("[quota-monitor] refresh failed", error);
          }
        };

        const saveSettings = (patch) => post(`${API}/settings`, patch);
        const testSupplier = async (id) => {
          try {
            return await post(`${API}/test`, { supplier: id });
          } catch (error) {
            return { ok: false, error: error.message };
          }
        };

        // 挂载：等待 sidebar 就绪（MutationObserver + 轮询兜底）
        // 位置契约（票 09）：小组件插入侧栏「底部按钮区之前」走内容流（flex），
        // 下边缘永不与侧栏底部按钮重叠；尺寸自动适配，内容超高时内部滚动。
        const GAP = 8;
        const hasBox = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 || r.height > 0; };
        const findBottomArea = (column) => {
          // 1) 优先按真实侧栏的底部按钮容器定位（DSH 侧栏如 .hHd-Xa_footArea）
          const named = Array.from(column.querySelectorAll("*")).filter((n) => {
            const cls = typeof n.className === "string" ? n.className : (n.className?.baseVal || "");
            return (/foot/i.test(cls) || /footer/i.test(cls)) && hasBox(n);
          }).sort((a, b) => b.getElementsByTagName("*").length - a.getElementsByTagName("*").length);
          if (named.length) return named[0];
          // 2) 兜底：找贴列底的交互元素，取其容器的最近公共祖先
          const colRect = column.getBoundingClientRect();
          if (colRect.height <= 0) return null;
          const buttons = Array.from(column.querySelectorAll("button,[role=button],a[href]")).filter(hasBox);
          const bottomish = buttons.filter((b) => b.getBoundingClientRect().bottom >= colRect.bottom - 8);
          if (!bottomish.length) return null;
          const paths = bottomish.map((b) => { const p = []; let n = b; while (n && n !== column) { p.unshift(n); n = n.parentElement; } return p; });
          const minLen = Math.min(...paths.map((p) => p.length));
          let lca = column;
          for (let i = 0; i < minLen; i++) {
            const cur = paths[0][i];
            if (paths.every((p) => p[i] === cur)) lca = cur; else break;
          }
          if (lca === column) return null;
          // 向上收起纯包装层（唯一可见子元素），直到底部区真实容器
          let anchor = lca;
          while (anchor && anchor !== column) {
            const parent = anchor.parentElement;
            if (!parent || parent === column || getComputedStyle(parent).display === "contents") break;
            const visible = Array.from(parent.children).filter((c) => c !== anchor && hasBox(c));
            if (visible.length > 0) break;
            anchor = parent;
          }
          return anchor;
        };
        const mount = () => {
          const findSidebar = () => document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
          const mountInto = (column, fallback = false) => {
            if (root) return;
            const el = document.createElement("div");
            el.setAttribute("data-dsh-quota-widget-root", "");
            let anchor = null;
            if (fallback) {
              // 侧栏始终未出现：浮动小组件兜底（左下角浮层），随视口自适应
              el.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:1200;width:280px;box-shadow:0 8px 24px rgba(0,0,0,.5);border-radius:10px;overflow-y:auto;";
              document.body.appendChild(el);
            } else {
              // 内容流贴底：插在底部按钮区之前（无按钮区则退回列尾）。
              // 不用 sticky——小组件紧贴按钮区上方，任何滚动状态下都不会压住按钮。
              el.style.cssText = "flex:0 0 auto;z-index:40;margin:8px 8px 8px;border-radius:10px;overflow-y:auto;";
              column.appendChild(el);
              anchor = findBottomArea(column);
              if (anchor) anchor.insertAdjacentElement("beforebegin", el);
            }
            const applyLayout = () => {
              if (fallback) {
                if (!el.isConnected) document.body.appendChild(el);
                el.style.maxHeight = Math.max(80, window.innerHeight - 24) + "px";
                return;
              }
              // 自愈：侧栏 React 重建摘除小组件后重新挂回（按钮区之前 / 列尾）
              if (!el.isConnected) {
                const found = findSidebar();
                if (!found) return; // 侧栏暂时消失：body MO / 心跳会再次触发
                const next = findBottomArea(found);
                if (next) next.insertAdjacentElement("beforebegin", el);
                else found.appendChild(el);
              }
              const col = el.closest('[data-pane="sidebar"], [class*="sidebarCol"]') || column;
              const colRect = col.getBoundingClientRect();
              // 侧栏收成 rail（窄栏）：隐藏小组件，展开时自动恢复
              const collapsed = colRect.width > 0 && colRect.width < 120;
              el.style.display = collapsed ? "none" : "";
              if (collapsed) return;
              // 侧栏 React 重建/折叠切换后重新定位到按钮区上方
              const next = findBottomArea(col);
              if (next && next !== anchor) {
                anchor = next;
                next.insertAdjacentElement("beforebegin", el);
              } else if (!next && anchor) {
                anchor = null;
                col.appendChild(el);
              }
              // 可用高度 = 列顶到按钮区上缘的净空间（≥64px 保底）；内容超高内部滚动
              const bound = next ? next.getBoundingClientRect().top : colRect.bottom;
              el.style.maxHeight = Math.max(64, bound - colRect.top - GAP) + "px";
            };
            // 观察：el 尺寸 + 全 DOM 结构变化（rAF 合并）+ resize + 2s 心跳兜底
            let rafId = 0;
            const scheduleLayout = () => {
              if (rafId) return;
              rafId = requestAnimationFrame(() => { rafId = 0; applyLayout(); });
            };
            const ro = new ResizeObserver(applyLayout);
            ro.observe(el);
            if (column && column.isConnected) ro.observe(column);
            window.addEventListener("resize", scheduleLayout);
            const moBody = new MutationObserver(scheduleLayout);
            moBody.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
            const reinsertTimer = setInterval(() => {
              if (!fallback && !el.isConnected) {
                const found = findSidebar();
                if (found) {
                  const next = findBottomArea(found);
                  if (next) next.insertAdjacentElement("beforebegin", el);
                  else found.appendChild(el);
                }
              }
            }, 2000);
            layoutDispose = () => {
              ro.disconnect();
              moBody.disconnect();
              clearInterval(reinsertTimer);
              if (rafId) cancelAnimationFrame(rafId);
              window.removeEventListener("resize", scheduleLayout);
            };
            applyLayout();
            root = createRoot(el);
            const popEl = document.createElement("div");
            document.body.appendChild(popEl);
            popRoot = createRoot(popEl);
            const overlayEl = document.createElement("div");
            document.body.appendChild(overlayEl);
            overlayRoot = createRoot(overlayEl);
            const style = document.createElement("style");
            style.textContent = CSS;
            document.head.appendChild(style);
            load();
            timer = setInterval(load, POLL_MS);
          };
          let attempts = 0;
          const tryMount = () => {
            const column = findSidebar();
            if (column) mountInto(column);
            else if (attempts++ < 240) setTimeout(tryMount, 500); // 最多等 2 分钟
            else mountInto(null, true);
          };
          const observer = new MutationObserver(() => {
            const column = findSidebar();
            if (column && !root) {
              observer.disconnect();
              mountInto(column);
            }
          });
          const rootNode = document.body || document.documentElement;
          observer.observe(rootNode, { childList: true, subtree: true });
          tryMount();
        };

        // 原生设置页卡片（尽力而为：settings.plugin.item 槽位，keyed 槽位需 options.key）
        try {
          if (ctx.slots?.register) {
            ctx.slots.register({ name: "settings.plugin.item", key: NS, entryKey: NS }, () =>
              h("button", {
                className: "qm-btn",
                style: { padding: "8px 12px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, cursor: "pointer", background: "none", color: "var(--dsw-alias-label-primary)" },
                onClick: () => openSettingsPanel(),
              }, "用量监控设置"),
            );
          }
        } catch (error) {
          console.warn("[quota-monitor] settings card slot unavailable", error);
        }

        function openSettingsPanel() {
          if (!state) {
            load().then(() => { if (state) { view = "settings"; renderAll(); } });
            return;
          }
          view = "settings";
          renderAll();
        }

        mount();
        return () => {
          if (timer) clearInterval(timer);
          layoutDispose?.();
          root?.unmount();
          popRoot?.unmount();
          overlayRoot?.unmount();
        };
      }

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();