// lib/client.js — DSH Web 客户端半（浏览器，经 /plugins/dsh-quota-monitor/client.js 加载）
//
// 渲染契约（v0.2 彻底重构版）：
//   1. 小组件不再扫描/劫持侧边栏 DOM，而是注册进 DSH 官方侧边栏底槽
//      `sidebar.footer.action`（list，keyed id=quota-monitor）—— 由侧边栏外壳（
//      @deepseek-ai/dsh-client-ui-sidebar）在脚部区 footArea 内以正常内容流渲染，
//      与其他 footer action（remote-web-ui、cordis-panel 等）并排，永不重叠；
//      侧栏收起为 rail 时外壳会传入 wide=false，小组件自动切换为图标态并保持可用。
//   2. 供应商明细 Popover 与详情/设置弹层用 createPortal 挂到 document.body
//      （与官方 dsh-client-ui-cordis / dsh-remote-web-ui 同款），Popover 以
//      「bottom 对齐锚点上方」的官方定位方式展开，带视口钳制 —— 不做 fixed 悬浮
//      小组件、不做 z-index 夸张的贴边浮动层。
//   3. 设置卡片走官方 `settings.plugin.item` 槽位（DSH 设置页插件清单内）。
//
// 纯 React.createElement（无构建步骤），样式注入 DSW 主题变量。
(function () {
  window.__ModuleLoader__.load({
    id: "dsh-quota-monitor",
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const { createPortal } = require("react-dom");
      const h = React.createElement;

      const NS = "quota-monitor";
      const API = "/api/quota-monitor";
      const POLL_MS = 30_000; // 客户端自身状态拉取节奏（宿主另有 10–3600s 取数轮询）

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
      // 状态优先级：正常 < 警告 < 临界 < 失败（未配置最低）
      const STATE_RANK = { off: 0, ok: 1, warn: 2, crit: 3, err: 4 };
      const worstSupplier = (suppliers) =>
        (suppliers || []).reduce((a, b) => (STATE_RANK[stateClass(b)] > STATE_RANK[stateClass(a)] ? b : a), null);
      const stateToken = (s) => {
        if (!s) return "stateOff";
        if (s.state === "err") return "stateErr";
        if (s.state === "off") return "stateOff";
        const e = (s.entries || []).find((x) => x.pct !== null && x.pct !== undefined);
        if (!e) return "stateOk";
        return e.pct >= (s.critPct ?? 95) ? "stateCrit" : e.pct >= (s.warnPct ?? 80) ? "stateWarn" : "stateOk";
      };
      // 百分比文本：宿主 headline.pct 自带 "%"（如 "35%"），条目 pct 为数字——统一补 % 且不重复
      const pctText = (v) => {
        if (v === null || v === undefined) return "—";
        const s = String(v);
        return s.includes("%") ? s : `${s}%`;
      };
      const headlineOf = (s) => {
        if (!s?.headline) return "—";
        return s.headline.kind === "pct" && s.headline.pct !== null && s.headline.pct !== undefined
          ? pctText(s.headline.pct)
          : s.headline.amt || "—";
      };

      // ---------- API ----------
      const getState = () => fetch(`${API}/state`, { cache: "no-store" }).then((r) => r.json());
      const post = (path, body) =>
        fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then((r) => r.json());

      // ---------- 数据 hook（每个槽位实例独立拉取，互不干扰） ----------
      function useQuotaState() {
        const [state, setState] = React.useState(null);
        const load = React.useCallback(async () => {
          try {
            setState(await getState());
          } catch (error) {
            console.error("[quota-monitor] state fetch failed", error);
          }
        }, []);
        React.useEffect(() => {
          load();
          const timer = setInterval(load, POLL_MS);
          return () => clearInterval(timer);
        }, [load]);
        const refresh = React.useCallback(async () => {
          try {
            const next = await post(`${API}/refresh`);
            if (next?.ok !== false) setState(next);
          } catch (error) {
            console.error("[quota-monitor] refresh failed", error);
          }
        }, []);
        return { state, refresh };
      }

      // ---------- 小组件：侧边栏脚部槽位（sidebar.footer.action） ----------
      // wide=true：与设置行同区的紧凑条（状态点 + 概览 + 今日消耗），点击展开 Popover；
      // wide=false（rail 窄栏）：图标态按钮，点击打开详情弹层 —— 全部走内容流，
      // 不做任何 fixed/absolute 常驻定位，因此与其他脚部按钮不可能重叠。
      function FooterWidget({ wide, t }) {
        const [popover, setPopover] = React.useState(false);
        const [view, setView] = React.useState(null); // 'detail' | 'settings' | null
        const stripRef = React.useRef(null);
        const { state, refresh } = useQuotaState();
        const suppliers = (state?.suppliers || []).filter((s) => s.current);
        const totalToday = suppliers.reduce(
          (sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0),
          0,
        );
        const worst = worstSupplier(suppliers);
        const onOpenDetail = React.useCallback(() => { setPopover(false); setView("detail"); }, []);
        const onOpenSettings = React.useCallback(() => { setPopover(false); setView("settings"); }, []);

        // rail：56px 窄栏，只保留一个可点图标（打开详情）
        if (!wide) {
          return h("button", {
            type: "button",
            "data-qm-entry": "",
            className: "qm-rail",
            "aria-label": t("title"),
            title: t("title"),
            onClick: () => setView("detail"),
          }, h("span", { className: `qm-dot ${stateClass(worst || { state: "off" })}` }));
        }

        const summary = worst
          ? `${worst.name} ${headlineOf(worst)}`
          : t("noSuppliers");
        const meta = [
          totalToday > 0 ? t("today", { n: fmtBig(totalToday) }) : null,
          suppliers.length > 1 ? t("countBadge", { n: suppliers.length }) : null,
        ].filter(Boolean).join(" · ");

        return h(React.Fragment, null,
          h("div", { "data-qm-linerow": "" },
            h("button", {
              type: "button",
              ref: stripRef,
              "data-qm-entry": "",
              className: "qm-strip",
              "aria-expanded": popover,
              "aria-haspopup": "dialog",
              onClick: () => setPopover((v) => !v),
            },
              h("span", { className: `qm-dot ${stateClass(worst || { state: "off" })}` }),
              h("span", { className: "qm-strip-title" }, t("title")),
              h("span", { className: "qm-strip-summary" }, summary),
              meta ? h("span", { className: "qm-strip-meta" }, meta) : null,
            ),
          ),
          popover
            ? createPortal(h(Popover, {
                anchorRef: stripRef,
                state,
                t,
                onClose: () => setPopover(false),
                onRefresh: refresh,
                onOpenDetail,
                onOpenSettings,
              }), document.body)
            : null,
          view === "detail"
            ? createPortal(h(DetailModal, { state, t, onClose: () => setView(null), onRefresh: refresh, onOpenSettings }), document.body)
            : null,
          view === "settings"
            ? createPortal(h(SettingsModal, { t, onClose: () => setView(null) }), document.body)
            : null,
        );
      }

      // ---------- Popover：供应商限额汇总（锚定脚部条上方，视口钳制） ----------
      function Popover({ anchorRef, state, t, onClose, onRefresh, onOpenDetail, onOpenSettings }) {
        const cardRef = React.useRef(null);
        const [style, setStyle] = React.useState({});
        React.useLayoutEffect(() => {
          const place = () => {
            const el = anchorRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 16);
            const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
            const bottom = window.innerHeight - rect.top + 8; // 官方贴底展开：下缘对齐锚点上沿
            setStyle({ left, bottom, width, maxHeight: Math.max(160, rect.top - 24) });
          };
          place();
          window.addEventListener("resize", place);
          window.addEventListener("scroll", place, true);
          return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
          };
        }, [anchorRef]);

        const dismiss = React.useCallback((ev) => {
          if (cardRef.current && !cardRef.current.contains(ev.target)) onClose();
        }, [onClose]);
        React.useEffect(() => {
          document.addEventListener("pointerdown", dismiss, true);
          const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
          document.addEventListener("keydown", onKey);
          return () => {
            document.removeEventListener("pointerdown", dismiss, true);
            document.removeEventListener("keydown", onKey);
          };
        }, [dismiss, onClose]);

        const suppliers = (state?.suppliers || []).filter((s) => s.current);
        const totalToday = suppliers.reduce(
          (sum, s) => sum + (typeof s.todayTokens === "number" ? s.todayTokens : 0),
          0,
        );
        const rows = suppliers.map((s) => {
          const entries = (s.entries || []).slice(0, 3);
          const more = (s.entries || []).length - entries.length;
          return h("div", { key: s.id, className: "qm-srow" },
            h("div", { className: "qm-srow-main" },
              h("span", { className: `qm-dot ${stateClass(s)}` }),
              h("span", { className: "qm-srow-name" }, s.name),
              h("span", { className: `qm-srow-head ${stateClass(s)}` }, headlineOf(s)),
              s.todayTokens !== null && s.todayTokens !== undefined
                ? h("span", { className: "qm-srow-today" }, t("today", { n: fmtBig(s.todayTokens) }))
                : null,
            ),
            entries.map((e) =>
              h("div", { key: e.name, className: "qm-srow-entry" },
                h("span", null, e.name),
                h("span", null,
                  e.pct !== null && e.pct !== undefined ? pctText(e.pct) : e.remain,
                  e.reset && e.reset !== "—" ? ` · ${e.reset}` : "",
                ),
              ),
            ),
            more > 0 ? h("div", { className: "qm-srow-more" }, `+${more}`) : null,
            s.error ? h("div", { className: "qm-srow-err" }, `⚠ ${s.error.message || s.error.code}`) : null,
          );
        });

        return h("div", { ref: cardRef, className: "qm-pop", role: "dialog", style },
          h("div", { className: "qm-pop-head" },
            h("b", null, t("title")),
            h("span", null,
              totalToday > 0 ? h("span", { className: "qm-pop-today" }, t("today", { n: fmtBig(totalToday) })) : null,
              state?.poll?.intervalSeconds ? t("poll", { n: state.poll.intervalSeconds }) : null,
              h("button", { type: "button", className: "qm-btn", onClick: onRefresh }, `⟳ ${t("refresh")}`),
            ),
          ),
          state?.trafficStale && suppliers.length > 0
            ? h("div", { className: "qm-stale" }, t("stale", { n: state?.poll?.trafficWindowHours ?? 24 }))
            : null,
          suppliers.length === 0
            ? h("div", { className: "qm-empty" },
                t("noSuppliers"),
                h("button", { type: "button", className: "qm-btn", onClick: onOpenSettings }, t("openSettings")),
              )
            : h("div", { className: "qm-srows" }, rows),
          h("div", { className: "qm-pop-foot" },
            h("span", { className: "qm-pop-time" }, `${t("lastRefresh")} ${state?.now || "—"}`),
            h("span", { className: "qm-pop-actions" },
              h("button", { type: "button", className: "qm-btn", onClick: onOpenDetail }, t("detail")),
              h("button", { type: "button", className: "qm-btn", onClick: onOpenSettings }, t("settings")),
              h("button", { type: "button", className: "qm-btn", onClick: onClose }, t("close")),
            ),
          ),
        );
      }

      // ---------- 详情弹层 ----------
      function EntryCard({ e, t }) {
        // bal 以「剩余」为主值；usage/cost/win 无百分比时以「已用」为主值
        const fallbackValue = (e.kind === "bal" || !e.used || e.used === "—") ? e.remain || "—" : e.used || "—";
        const pct = e.pct !== null && e.pct !== undefined ? pctText(e.pct) : fallbackValue;
        const cls = pct === "—" ? "err" : Number.parseFloat(e.pct) >= 95 ? "crit" : Number.parseFloat(e.pct) >= 80 ? "warn" : "ok";
        return h("div", { className: "qm-card-item" },
          h("div", { className: "ci-name" }, h("span", null, e.name), h("span", null, e.reset)),
          h("div", { className: `ci-big ${cls}` }, pct),
          h("div", { className: "ci-row" }, h("span", null, `${t("quota")} ${e.limit}`), h("span", null, `${t("usedShort")} ${e.used}`)),
          e.note ? h("div", { className: "ci-row" }, h("span", null, e.note)) : null,
          e.pct === null && e.kind === "bal" ? h("div", { className: "ci-err" }, t("noQuotaConcept")) : null,
        );
      }

      function DetailModal({ state, t, onClose, onRefresh, onOpenSettings }) {
        const cols = (state?.suppliers || []).map((s) => {
          const face = s.entries?.length
            ? s.entries
            : [{ name: s.error?.message || t("noData"), limit: "—", used: "—", remain: "—", pct: null, reset: "—", note: "", err: true }];
          return h("div", { key: s.id, className: "qm-col" },
            h("h5", null,
              h("span", null, s.name, s.current ? h("span", { className: "qm-cur" }, " · 当前") : null),
              h("span", { className: `qm-pill ${stateClass(s)}` }, t(stateToken(s))),
            ),
            face.map((e, i) => (e.err ? h("div", { key: i, className: "qm-card-item" }, h("div", { className: "ci-err" }, e.name)) : h(EntryCard, { key: i, e, t }))),
          );
        });
        const hist = state?.history || [];
        useEscape(onClose);
        return h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() },
          h("div", { className: "qm-card" },
            h("h3", null, t("detailTitle")),
            h("div", { className: "qm-sub" },
              `${t("allConfigured", { n: (state?.suppliers || []).length })} · ${t("recentRefresh")} ${state?.now || "—"} · ${t("poll", { n: state?.poll?.intervalSeconds ?? 60 })}`,
            ),
            h("div", { className: "qm-toolbar" },
              h("button", { type: "button", className: "qm-pri", onClick: onRefresh }, `⟳ ${t("refresh")}`),
              h("button", { type: "button", onClick: onOpenSettings }, t("settings")),
              h("button", { type: "button", onClick: onClose }, t("close")),
            ),
            h("div", { className: "qm-cols" }, cols),
            h("details", { className: "qm-history" },
              h("summary", null, t("historySummary", { n: Math.min(hist.length, 50) })),
              h("table", null,
                h("thead", null, h("tr", null,
                  h("th", null, t("colTime")), h("th", null, t("colSupplier")),
                  h("th", null, t("colResult")), h("th", null, t("colMain")), h("th", null, t("colNote")),
                )),
                h("tbody", null, hist.map((r, i) =>
                  h("tr", { key: i },
                    h("td", null, r.t), h("td", null, r.supplier),
                    h("td", { className: r.ok ? "h-ok" : "h-bad" }, r.ok ? t("colOk") : t("colFail")),
                    h("td", null, r.summary), h("td", null, r.error || ""),
                  ),
                )),
              ),
            ),
          ),
        );
      }

      // ---------- 设置弹层（自取状态，可从脚部小组件或设置卡片打开） ----------
      function SettingsModal({ t, onClose }) {
        const [state, setState] = React.useState(null);
        const [view, setView] = React.useState({ name: "main" }); // main | supplier
        const [globalForm, setGlobalForm] = React.useState(null);
        const [editor, setEditor] = React.useState(null); // { supplierId, form }
        const [testState, setTestState] = React.useState({});
        const [saved, setSaved] = React.useState(null); // 'global' | supplierId
        useEscape(onClose);

        const reload = React.useCallback(async () => {
          try {
            const next = await getState();
            setState(next);
            setGlobalForm((g) => g || {
              intervalSeconds: next?.poll?.intervalSeconds ?? 60,
              retentionDays: next?.poll?.retentionDays ?? 7,
            });
          } catch (error) {
            console.error("[quota-monitor] state fetch failed", error);
          }
        }, []);
        React.useEffect(() => { reload(); }, [reload]);

        // 每个供应商一个独立配置页（参考 Token-Consumption-Monitoring 的页面模型）
        const openSupplier = (id) => {
          const sup = (state?.suppliers || []).find((s) => s.id === id);
          if (!sup) return;
          const form = {
            enabled: !!sup.enabled,
            baseUrl: sup.baseUrl || sup.baseUrlDefault || "",
            warnPct: sup.warnPct ?? 80,
            critPct: sup.critPct ?? 95,
          };
          for (const need of sup.meta?.needs || []) form[need.key] = "";
          setEditor({ supplierId: id, form });
          setView({ name: "supplier", id });
          setTestState({});
          setSaved(null);
        };
        const setEditorField = (key, value) =>
          setEditor((e) => (e ? { ...e, form: { ...e.form, [key]: value } } : e));

        const saveGlobal = async () => {
          if (!globalForm) return;
          try {
            await post(`${API}/settings`, {
              intervalSeconds: Number(globalForm.intervalSeconds),
              retentionDays: Number(globalForm.retentionDays),
            });
            setSaved("global");
            await reload();
          } catch (error) {
            console.error("[quota-monitor] global settings save failed", error);
          }
        };
        const saveSupplier = async () => {
          if (!editor) return;
          const sup = (state?.suppliers || []).find((s) => s.id === editor.supplierId);
          if (!sup) return;
          try {
            const p = {
              enabled: !!editor.form.enabled,
              baseUrl: String(editor.form.baseUrl || ""),
              warnPct: Number(editor.form.warnPct),
              critPct: Number(editor.form.critPct),
            };
            for (const need of sup.meta?.needs || []) {
              const v = editor.form[need.key];
              if (need.key === "apiKey" || need.secret) {
                // secret：留空 = 保持不变（清除需直接编辑 settings.yaml）
                if (v && String(v).trim()) p[need.key] = String(v).trim();
              } else {
                p[need.key] = v || "";
              }
            }
            await post(`${API}/settings`, { suppliers: { [editor.supplierId]: p } });
            setSaved(editor.supplierId);
            await reload();
            setView({ name: "main" });
            setEditor(null);
          } catch (error) {
            console.error("[quota-monitor] supplier settings save failed", error);
          }
        };
        const toggleEnabled = async (sup) => {
          try {
            await post(`${API}/settings`, { suppliers: { [sup.id]: { enabled: !sup.enabled } } });
            await reload();
          } catch (error) {
            console.error("[quota-monitor] enable toggle failed", error);
          }
        };
        const runTest = (id) => {
          setTestState((x) => ({ ...x, [id]: t("testing") }));
          post(`${API}/test`, { supplier: id })
            .then((r) => setTestState((x) => ({ ...x, [id]: r })))
            .catch((error) => setTestState((x) => ({ ...x, [id]: { ok: false, error: error.message } })));
        };

        // 字段标签/占位（按供应商 needs 元数据）
        const needsLabel = (sup, need) => {
          if (need.key === "apiKey") return t(sup.meta?.credentialLabelKey || "apiKey");
          if (need.key === "allowanceToken") return t("allowanceToken");
          if (need.key === "orgId") return t("orgId");
          return need.label || need.key;
        };
        const secretPlaceholder = (sup, need) => {
          if (sup[`${need.key}Set`]) return t("keySet");
          if (need.key === "apiKey" && sup.autoDetected && sup.envKeySet) {
            return t("keyAuto", { env: sup.autoEnvName || t("dshKey") });
          }
          return t("keyEmpty");
        };

        if (!state) {
          return h("div", { className: "qm-overlay" },
            h("div", { className: "qm-card qm-settings" }, h("h3", null, t("settingsTitle")), h("div", { className: "qm-sub" }, "…")),
          );
        }

        const sorted = [...(state.suppliers || [])].sort((a, b) =>
          (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
          || ((b.keySet ? 1 : 0) - (a.keySet ? 1 : 0))
          || a.name.localeCompare(b.name),
        );
        const testResult = (id) => {
          const r = testState[id];
          if (!r) return null;
          if (typeof r === "string") return h("span", { className: "s-test-res bad" }, r);
          return h("span", { className: `s-test-res ${r.ok ? "ok" : "bad"}` }, r.ok ? t("testOk") : (r.error || t("testFail")));
        };
        const savedBanner = saved
          ? h("div", { className: "s-saved", style: { marginBottom: 8 } }, t("saved"))
          : null;

        // ---- 主视图：全局设置 + 供应商页目录（每页进入独立配置） ----
        const renderMain = () => h(React.Fragment, null,
          h("div", { className: "s-group" },
            h("h5", null, h("span", null, t("global"))),
            h("div", { className: "s-grid" },
              h("label", null, t("interval"),
                h("input", { type: "number", min: 10, max: 3600,
                  value: globalForm?.intervalSeconds ?? 60,
                  onChange: (e) => setGlobalForm((g) => ({ ...g, intervalSeconds: e.target.value })) }),
              ),
              h("label", null, t("retention"),
                h("input", { type: "number", min: 1, max: 90,
                  value: globalForm?.retentionDays ?? 7,
                  onChange: (e) => setGlobalForm((g) => ({ ...g, retentionDays: e.target.value })) }),
              ),
            ),
            h("div", { className: "s-row", style: { justifyContent: "flex-end" } },
              h("button", { type: "button", className: "qm-pri", onClick: saveGlobal }, t("save")),
            ),
          ),
          h("div", { className: "qm-pages-title" },
            h("b", null, t("supplierPages")),
            h("span", null, t("supplierPagesSub")),
          ),
          h("div", { className: "qm-page-list" },
            sorted.map((sup) =>
              h("div", { key: sup.id, className: "qm-page-row" },
                h("div", { className: "qm-page-main", role: "button", title: t("openPage"), onClick: () => openSupplier(sup.id) },
                  h("span", { className: `qm-dot ${stateClass(sup)}` }),
                  h("span", { className: "qm-page-name" }, sup.name),
                  h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
                  sup.meta?.compat
                    ? h("span", { className: "qm-page-pill ghost" }, t("compatSource"))
                    : null,
                  sup.autoDetected
                    ? h("span", { className: "qm-page-auto" }, sup.enabled ? t("autoDetectedShort") : t("autoSourceShort"))
                    : null,
                ),
                h("div", { className: "qm-page-actions" },
                  h("label", { className: "qm-page-toggle" },
                    h("input", { type: "checkbox", checked: !!sup.enabled, onChange: () => toggleEnabled(sup) }),
                    h("span", null, t("enable")),
                  ),
                  h("button", { type: "button", className: "s-test", onClick: () => runTest(sup.id) }, t("test")),
                  testResult(sup.id),
                  h("button", { type: "button", className: "s-test qm-pri-soft", onClick: () => openSupplier(sup.id) }, t("openPage")),
                ),
              ),
            ),
          ),
          state.detectedUnmapped && state.detectedUnmapped.length
            ? h("div", { className: "pnote", style: { marginTop: 8, whiteSpace: "pre-wrap" } },
                `${t("unmapped")}：${state.detectedUnmapped.map((u) => `${u.displayName || u.route}${u.detail ? t("unmappedDetail", { detail: u.detail }) : ""}`).join("、")}`)
            : null,
        );

        // ---- 供应商独立配置页（参考项目的单页表单模型） ----
        const renderSupplierPage = () => {
          const sup = (state?.suppliers || []).find((s) => s.id === view.id);
          if (!sup || !editor) return h("div", { className: "qm-sub" }, "…");
          const f = editor.form;
          const needsInputs = (sup.meta?.needs || []).map((need) =>
            h("label", { key: need.key }, needsLabel(sup, need),
              h("input", {
                type: need.secret ? "password" : "text",
                placeholder: need.secret ? secretPlaceholder(sup, need) : t("keyEmpty"),
                value: f[need.key] || "",
                onChange: (e) => setEditorField(need.key, e.target.value),
              }),
            ),
          );
          return h(React.Fragment, null,
            h("div", { className: "qm-page-head" },
              h("button", { type: "button", className: "s-test", onClick: () => { setView({ name: "main" }); setEditor(null); } }, `← ${t("back")}`),
              h("b", null, sup.name),
              h("span", { className: `qm-pill ${stateClass(sup)}` }, t(stateToken(sup))),
              h("span", { className: "qm-page-pill" }, t(sup.meta?.credentialLabelKey || "apiKey")),
            ),
            sup.autoDetected ? h("div", { className: "pnote", style: { margin: "6px 0" } },
              sup.enabled
                ? t("autoDetectedOn", { source: sup.autoSource || "", env: sup.autoEnvName || (sup.autoKeySource === "env" ? t("env") : t("credentialStore")) })
                : t("autoDetectedOff", { source: sup.autoSource || "" })) : null,
            (sup.meta?.credentialClass && sup.meta.credentialClass !== "api-key")
              ? h("div", { className: "pnote", style: { margin: "6px 0" } },
                  t("manualCredential", { label: t(sup.meta.credentialLabelKey || "apiKey") }))
              : null,
            h("div", { className: "s-group" },
              h("h5", null, h("span", null, t("credentials"))),
              needsInputs,
              h("label", { className: "qm-inline-toggle" },
                h("input", { type: "checkbox", checked: !!f.enabled, onChange: (e) => setEditorField("enabled", e.target.checked) }),
                h("span", null, t("enable")),
              ),
            ),
            h("div", { className: "s-group" },
              h("h5", null, h("span", null, t("endpoint"))),
              h("label", null, t("baseUrl"),
                h("input", { type: "text", value: f.baseUrl || "", onChange: (e) => setEditorField("baseUrl", e.target.value) }),
              ),
              h("div", { className: "s-grid" },
                h("label", null, t("warnPct"),
                  h("input", { type: "number", min: 1, max: 99, value: f.warnPct, onChange: (e) => setEditorField("warnPct", e.target.value) }),
                ),
                h("label", null, t("critPct"),
                  h("input", { type: "number", min: 1, max: 100, value: f.critPct, onChange: (e) => setEditorField("critPct", e.target.value) }),
                ),
              ),
            ),
            h("div", { className: "s-row" },
              h("button", { type: "button", className: "s-test", onClick: () => runTest(sup.id) }, `⟳ ${t("test")}`),
              testResult(sup.id),
            ),
            h("div", { className: "s-actions" },
              saved === sup.id ? h("span", { className: "s-saved" }, t("saved")) : null,
              h("button", { type: "button", onClick: () => { setView({ name: "main" }); setEditor(null); } }, t("cancel")),
              h("button", { type: "button", className: "qm-pri", onClick: saveSupplier }, t("save")),
            ),
          );
        };

        return h("div", { className: "qm-overlay", onClick: (ev) => ev.target === ev.currentTarget && onClose() },
          h("div", { className: "qm-card qm-settings" },
            h("h3", null, t("settingsTitle")),
            h("div", { className: "qm-sub" },
              view.name === "supplier"
                ? `${t("settingsSub")} · ${t("supplierPagesSub")}`
                : t("settingsSub"),
            ),
            savedBanner,
            view.name === "supplier" ? renderSupplierPage() : renderMain(),
          ),
        );
      }
      // ---------- 设置卡片（settings.plugin.item 槽位；点击打开同一设置弹层） ----------
      function SettingsCard({ t }) {
        const [open, setOpen] = React.useState(false);
        return h(React.Fragment, null,
          h("button", {
            type: "button",
            className: "qm-card-btn",
            onClick: () => setOpen(true),
          }, t("settings")),
          open ? createPortal(h(SettingsModal, { t, onClose: () => setOpen(false) }), document.body) : null,
        );
      }

      // ---------- 通用小 hook ----------
      function useEscape(onClose) {
        React.useEffect(() => {
          const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
          document.addEventListener("keydown", onKey);
          return () => document.removeEventListener("keydown", onKey);
        }, [onClose]);
      }

      // ---------- 本地化 ----------
      const LOCALES = {
        zh: {
          title: "用量",
          today: "今日 {n}",
          countBadge: "×{n}",
          refresh: "刷新",
          detail: "详情",
          settings: "设置",
          close: "关闭",
          cancel: "取消",
          save: "保存",
          saved: "已保存 ✓",
          lastRefresh: "上次刷新",
          poll: "每 {n}s",
          noSuppliers: "暂无当前供应商",
          openSettings: "打开设置",
          stale: "近 {n}h 无流量 · 按启用清单显示",
          stateOk: "正常",
          stateWarn: "警告",
          stateCrit: "临界",
          stateErr: "取数失败",
          stateOff: "未配置",
          noData: "无数据",
          quota: "限额",
          usedShort: "已用",
          noQuotaConcept: "无限额概念（余额）",
          detailTitle: "供应商限额明细",
          allConfigured: "全部已配置供应商（共 {n}）",
          recentRefresh: "最近刷新",
          historySummary: "刷新历史（最近 {n} 条）",
          colTime: "时间",
          colSupplier: "供应商",
          colResult: "结果",
          colOk: "成功",
          colFail: "失败",
          colMain: "主指标",
          colNote: "备注",
          settingsTitle: "用量监控设置",
          settingsSub: "密钥保存在 DSH settings（settings.yaml），此处只回显掩码；留空 = 保持原值",
          global: "全局设置",
          supplierPages: "供应商页",
          supplierPagesSub: "每个供应商一页、一种凭据（对应参考项目页面模型）",
          openPage: "打开配置",
          back: "返回",
          credentials: "凭据",
          endpoint: "连接与阈值",
          compatSource: "兼容来源",
          autoDetectedShort: "已自动接入",
          autoSourceShort: "自动探测到",

          enable: "启用",
          test: "测试连接",
          testing: "测试中…",
          testOk: "连接正常",
          testFail: "失败",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          manualCredential: "需手动填写 {label}（DSH harness 不持有该凭据类别；普通 Key 不会套用）",
          unmappedDetail: "（{detail}）",
          keySet: "已设置（留空保持不变）",
          keyEmpty: "未设置",
          keyAuto: "自动读取 {env}",
          dshKey: "DSH 密钥",
          env: "环境变量",
          credentialStore: "DSH 凭据库",
          allowanceToken: "allowance Token（OAuth）",
          orgId: "org id（可选）",
          baseUrl: "Base URL",
          warnPct: "警告阈值 %",
          critPct: "临界阈值 %",
          interval: "轮询间隔（秒，10–3600）",
          retention: "用量保留期（天，1–90）",
          unmapped: "另探测到 DSH 内已添加但本插件暂不支持的供应商",
          autoDetectedOn: "已自动探测 DSH 的 {source} 配置：已启用、Base URL 与密钥已自动填入（来源 {env}，留空即可使用）",
          autoDetectedOff: "已自动探测 DSH 的 {source} 配置：Base URL 与密钥引用已填入，但密钥暂不可解析，未自动启用",
        },
        en: {
          title: "Usage",
          today: "Today {n}",
          countBadge: "×{n}",
          refresh: "Refresh",
          detail: "Details",
          settings: "Settings",
          close: "Close",
          cancel: "Cancel",
          save: "Save",
          saved: "Saved ✓",
          lastRefresh: "Last refresh",
          poll: "every {n}s",
          noSuppliers: "No current suppliers",
          openSettings: "Open settings",
          stale: "No traffic in {n}h · showing enabled list",
          stateOk: "OK",
          stateWarn: "Warning",
          stateCrit: "Critical",
          stateErr: "Fetch failed",
          stateOff: "Not configured",
          noData: "No data",
          quota: "Limit",
          usedShort: "Used",
          noQuotaConcept: "Balance has no quota concept",
          detailTitle: "Supplier quota details",
          allConfigured: "All configured suppliers ({n})",
          recentRefresh: "Last refresh",
          historySummary: "Refresh history (latest {n})",
          colTime: "Time",
          colSupplier: "Supplier",
          colResult: "Result",
          colOk: "OK",
          colFail: "Failed",
          colMain: "Headline",
          colNote: "Note",
          settingsTitle: "Quota monitor settings",
          settingsSub: "Secrets live in DSH settings.yaml; only masked state is echoed here. Leave blank to keep current.",
          global: "Global settings",
          supplierPages: "Supplier pages",
          supplierPagesSub: "One page per supplier and credential (mirrors the reference page model)",
          openPage: "Configure",
          back: "Back",
          credentials: "Credentials",
          endpoint: "Endpoint & thresholds",
          compatSource: "compat",
          autoDetectedShort: "auto-connected",
          autoSourceShort: "detected",

          enable: "Enable",
          test: "Test connection",
          testing: "Testing…",
          testOk: "Connected",
          testFail: "Failed",
          apiKey: "API Key",
          managementKey: "Management Key",
          adminKey: "Admin Key",
          codingPlanKey: "Coding Plan Key",
          tokenPlanKey: "Token Plan Key",
          manualCredential: "Enter {label} manually (DSH harness holds no such credential class; plain keys are never reused)",
          unmappedDetail: "({detail})",
          keySet: "Set (blank keeps current)",
          keyEmpty: "Not set",
          keyAuto: "Auto-read {env}",
          dshKey: "DSH key",
          env: "environment",
          credentialStore: "DSH credential store",
          allowanceToken: "allowance Token (OAuth)",
          orgId: "org id (optional)",
          baseUrl: "Base URL",
          warnPct: "Warn threshold %",
          critPct: "Critical threshold %",
          interval: "Poll interval (s, 10–3600)",
          retention: "Usage retention (days, 1–90)",
          unmapped: "Detected DSH suppliers this plugin does not support yet",
          autoDetectedOn: "Auto-detected DSH {source}: enabled, Base URL and key filled (from {env}; leave blank to use)",
          autoDetectedOff: "Auto-detected DSH {source}: Base URL and key reference filled, but the key is not resolvable yet — not enabled",
        },
      };

      // ---------- 样式（一次性注入，作用域化） ----------
      const CSS = `
[data-qm-entry]{box-sizing:border-box;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;}
[data-qm-entry] button{font-family:inherit;}
/* 小组件独占一行：宽栏时使 footer.action 所在容器换行，本条目全宽置顶，其它条目自动落下一行 */
div:has(> div[data-slot="sidebar.footer.action"] > [data-qm-linerow]){flex-wrap:wrap;}
[data-qm-linerow]{display:flex;flex:1 1 100%;min-width:100%;box-sizing:border-box;order:-1;margin:2px 0 0;}
[data-qm-linerow] .qm-strip{margin:0;width:100%;}
.qm-strip{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;height:28px;margin:2px;
  padding:0 8px;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;text-align:left;}
.qm-strip:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-strip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4f8cff);outline-offset:-2px;}
.qm-strip .qm-strip-title{flex:none;color:var(--dsw-alias-label-tertiary,#8b94a8);}
.qm-strip .qm-strip-summary{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.qm-strip .qm-strip-meta{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;}
.qm-rail{width:32px;height:32px;margin:2px;display:flex;align-items:center;justify-content:center;
  border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;}
.qm-rail:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block;}
.qm-dot.ok{background:var(--dsw-alias-state-success-primary,#34d399);}
.qm-dot.warn{background:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-dot.crit{background:var(--dsw-alias-state-error-primary,#f87171);}
.qm-dot.err{background:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-dot.off{background:var(--dsw-alias-border-l2,#262d3d);}
.qm-pop{position:fixed;z-index:1200;box-sizing:border-box;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:10px;padding:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 24px rgba(0,0,0,.5));
  color:var(--dsw-alias-label-primary,#dbe2ee);font-size:12px;font-family:var(--dsw-font-family),sans-serif;
  overflow-y:auto;}
.qm-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.qm-pop-head b{font-size:13px;}
.qm-pop-head>span{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-pop-today{color:var(--dsw-alias-label-primary,#dbe2ee);font-weight:600;}
.qm-pop .qm-stale{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;margin:2px 0 6px;}
.qm-pop .qm-empty{color:var(--dsw-alias-label-tertiary,#8b94a8);padding:8px 4px;}
.qm-pop .qm-empty .qm-btn{display:block;margin-top:6px;}
.qm-srows{display:flex;flex-direction:column;gap:2px;margin-bottom:8px;}
.qm-srow{padding:6px 8px;border-radius:8px;}
.qm-srow:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-srow-main{display:flex;align-items:center;gap:8px;min-width:0;}
.qm-srow-name{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}
.qm-srow-head{flex:none;font-weight:700;}
.qm-srow-head.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-srow-head.warn{color:var(--dsw-alias-state-warn-primary,#fbbf24);}
.qm-srow-head.crit{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-srow-head.err{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-srow-head.off{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-srow-today{flex:none;color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:10px;}
.qm-srow-entry{display:flex;justify-content:space-between;gap:10px;margin-top:2px;padding-left:16px;
  color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;}
.qm-srow-more{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;padding-left:16px;}
.qm-srow-err{color:var(--dsw-alias-state-error-primary,#f87171);font-size:11px;margin-top:4px;padding-left:16px;}
.qm-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--dsw-alias-border-l1,#262d3d);padding-top:8px;}
.qm-pop-time{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-pop-actions{display:flex;gap:4px;flex:none;}
.qm-btn{background:none;border:none;color:var(--dsw-alias-state-business-primary,#4f8cff);cursor:pointer;font-size:11px;padding:2px 4px;}
.qm-btn:hover{text-decoration:underline;}
.qm-card-btn{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
.qm-card-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#20283a);}
.qm-overlay{position:fixed;inset:0;z-index:1500;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;}
.qm-overlay .qm-card{width:min(880px,94vw);max-height:86vh;overflow:auto;
  background:var(--dsw-alias-bg-base,#0b0e13);border:1px solid var(--dsw-alias-border-l2,#262d3d);
  border-radius:14px;padding:16px;color:var(--dsw-alias-label-primary,#dbe2ee);
  font-family:var(--dsw-font-family),sans-serif;box-sizing:border-box;}
.qm-overlay .qm-card h3{margin:0 0 4px;font-size:15px;}
.qm-overlay .qm-sub{color:var(--dsw-alias-label-tertiary,#8b94a8);font-size:11px;margin-bottom:12px;}
.qm-overlay .qm-toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.qm-overlay .qm-toolbar button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;
  color:var(--dsw-alias-label-primary,#dbe2ee);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:12px;font-family:inherit;}
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
.qm-pill.off{color:var(--dsw-alias-label-tertiary,#6b7280);}
.qm-history{margin-top:14px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-history summary{cursor:pointer;padding:8px 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#8b94a8);}
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
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:2px 10px;font-size:11px;font-family:inherit;}
.qm-settings .s-test-res{font-size:11px;margin-left:8px;}
.qm-settings .s-test-res.ok{color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-settings .s-test-res.bad{color:var(--dsw-alias-state-error-primary,#f87171);}
.qm-settings .s-actions{display:flex;gap:8px;justify-content:flex-end;}
.qm-settings .s-actions button{border:1px solid var(--dsw-alias-border-l2,#262d3d);background:none;border-radius:8px;
  color:var(--dsw-alias-label-primary,#dbe2ee);cursor:pointer;padding:5px 14px;font-size:12px;font-family:inherit;}
.qm-settings .s-actions button.qm-pri{background:var(--dsw-alias-button-info-fill,#4f8cff);border-color:transparent;color:#fff;}
.qm-settings .s-saved{color:var(--dsw-alias-state-success-primary,#34d399);font-size:11px;align-self:center;}
.qm-settings .pnote{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b94a8);}

.qm-settings .qm-pages-title{display:flex;justify-content:space-between;margin:4px 0 8px;color:var(--dsw-alias-label-secondary,#8b94a8);font-size:12px;}
.qm-settings .qm-pages-title span{color:var(--dsw-alias-label-tertiary,#5c6577);font-size:10px;}
.qm-page-list{display:flex;flex-direction:column;gap:6px;}
.qm-page-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,#262d3d);border-radius:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#151922);}
.qm-page-main{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;cursor:pointer;}
.qm-page-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qm-page-pill{flex:none;padding:1px 8px;border-radius:8px;font-size:10px;border:1px solid var(--dsw-alias-border-l2,#262d3d);color:var(--dsw-alias-label-secondary,#8b94a8);}
.qm-page-pill.ghost{opacity:.6;}
.qm-page-auto{flex:none;font-size:10px;color:var(--dsw-alias-state-success-primary,#34d399);}
.qm-page-actions{flex:none;display:flex;align-items:center;gap:6px;font-size:11px;}
.qm-page-toggle{display:flex;gap:4px;align-items:center;margin:0;font-size:11px;}
.qm-page-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .s-test.qm-pri-soft{border-color:var(--dsw-alias-state-business-primary,#4f8cff);color:var(--dsw-alias-state-business-primary,#4f8cff);}
.qm-settings .qm-page-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.qm-settings .qm-page-head b{flex:1 1 0;font-size:14px;}
.qm-settings .qm-inline-toggle{display:flex;align-items:center;gap:6px;margin:8px 0 0;font-size:12px;}
.qm-settings .qm-inline-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#4f8cff);}
      `;

      function ensureStyle() {
        const tagId = "dsh-quota-monitor/widget.css";
        if (document.querySelector(`style[data-plugin-css="${tagId}"]`)) return;
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-quota-monitor";
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }

      // ---------- 应用入口 ----------
      const inject = ["slots", "locale"];

      function apply(ctx) {
        ensureStyle();

        // 本地化词典（DSH 官方模式：locale.register 后由槽位注入 t）
        let disposeLocale = null;
        try {
          disposeLocale = ctx.locale.register(NS, LOCALES);
        } catch (error) {
          console.warn("[quota-monitor] locale register failed", error);
        }

        // 侧边栏底槽：小组件（list slot，keyed id，官方渲染契约）
        let disposeFooter = null;
        let disposeCard = null;
        try {
          disposeFooter = ctx.slots.inject("sidebar.footer.action", () =>
            ctx.slots.register({
              name: "sidebar.footer.action",
              id: "quota-monitor",
              locale: NS,
            }, FooterWidget),
          );
        } catch (error) {
          console.warn("[quota-monitor] sidebar footer slot unavailable", error);
        }

        // DSH 设置页插件清单卡片 → 打开设置弹层
        try {
          disposeCard = ctx.slots.inject("settings.plugin.item", () =>
            ctx.slots.register({
              name: "settings.plugin.item",
              key: NS,
              locale: NS,
            }, SettingsCard),
          );
        } catch (error) {
          console.warn("[quota-monitor] settings card slot unavailable", error);
        }

        ctx.effect(() => () => {
          disposeLocale?.();
          disposeFooter?.();
          disposeCard?.();
        }, "quota-monitor: slot disposers");
      }

      exports.apply = apply;
      exports.inject = inject;
      return module.exports;
    },
  });
})();