# dsh-usage-monitor（用量监控）

DeepSeek Harness 插件：显示各供应商**可用周期限额 / 余额 / 报告用量费用**——sidebar 脚部小组件 + 详情页。

查询覆盖随 [Token-Consumption-Monitoring](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring)（`main`，v1.3.x）的
[docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md)
重构，供应商注册表按「凭据类别 × 地域」拆分（与上游「一个页面保存一种凭据」一致；普通 API Key、Management Key、Admin Key 不互相尝试）：

| 供应商 | 查询方法（端点） | 凭据类别 | 密钥来源 |
|---|---|---|---|
| DeepSeek | 账户余额 `/user/balance`（多币种保留，严格官方地址） | 普通 API Key | DSH 自动识别 |
| OpenRouter | 当前 Key 周期额度 + 今日费用 `/api/v1/key` | 普通 API Key | DSH 自动识别 |
| OpenRouter 账户 | 账户 credits `/api/v1/credits`（total_credits − total_usage） | Management Key | 手动 |
| OpenAI 组织 | 用量 `/v1/organization/usage/completions` + 费用 `/v1/organization/costs`（最近完整 UTC 日，分页+去重游标） | 组织 Admin Key | 手动 |
| Anthropic 组织 | 用量 `/v1/organizations/usage_report/messages` + 费用 `/v1/organizations/cost_report`（美分→USD） | 组织 Admin Key | 手动 |
| Moonshot 国内 | 余额 `/v1/users/me/balance`（api.moonshot.cn，CNY） | 普通 API Key | DSH 自动识别 |
| Moonshot 国际 | 余额 `/v1/users/me/balance`（api.moonshot.ai，USD） | 普通 API Key | DSH 自动识别 |
| Z.ai | Coding Plan 窗口 `/api/monitor/usage/quota/limit`（api.z.ai；Authorization 原样不带 Bearer） | 普通 API Key | DSH 自动识别 |
| 智谱 Coding Plan | 同上（open.bigmodel.cn） | 普通 API Key | DSH 自动识别 |
| MiniMax 国际 | Token Plan 窗口 `/v1/token_plan/remains`（www.minimax.io；显式剩余百分比，不猜旧计数） | 普通 API Key | DSH 自动识别 |
| MiniMax 国内 | 同上（www.minimaxi.com） | 普通 API Key | DSH 自动识别 |
| OpenCode（兼容） | 5h/周/月窗口 `/zen/go/v1/usage` + allowance `/api/go/status`（OAuth + x-org-id） | 普通 API Key / OAuth | DSH 自动识别 / 手动 |
| Command Code（兼容） | 5h/周窗口 + 套餐月额度 `/alpha/billing/*`（plan 表随上游；网关 baseURL 收敛到同源根路径） | 普通 API Key | DSH 自动识别 |

官方方法只接受对应 HTTPS 主机 + 已知基础路径（拒绝端口/用户信息/查询串/重定向），地址不匹配不发请求；
无限额度 / 未知余额 / 缺字段保留未知，不冒充零值；分页失败不发布部分总数；不同币种、窗口、来源不相加。
Windows 专属方法（WebView2 控制台、本地 SQLite、本机 Codex CLI 登录）按规格丢弃——Codex 需本机 CLI 登录态，不适用于服务端 DSH，不注册。

## 功能

- **小组件（sidebar 脚部）**：**经 DSH 官方槽位 `sidebar.footer.action` 嵌入**侧边栏底部，与其他脚部按钮/组件同处内容流、并排渲染，**不扫描/不劫持 DOM、不做 fixed 悬浮**；宽栏紧凑条（状态点 + 概览 + 今日 token 总消耗）点击展开 Popover；rail 窄栏自动切换图标态。只显示**当前供应商**（DSH 启用 ∩ 近期流量；组织账务等无 DSH 路由的供应商恒为候选；冷启动或近 24h 无流量时按启用清单兜底并标注）
- **详情页**：供应商分栏（kanban 风），栏头状态胶囊 + 限额/用量/费用条目卡片；刷新历史默认收起；刷新全部 / 设置入口
- **设置**：原生设置卡片 + 详情页内面板；**表单按供应商 needs 元数据动态渲染**（凭据类别文案：API Key / Admin Key / Management Key / Coding Plan Key / Token Plan Key，OpenCode 另含 allowance Token 与 org id）；全局轮询间隔/保留期；**测试连接**
- **调度**：默认 60s 轮询（10–3600 可配）；同供应商 in-flight 合并去重；失败指数退避（30s→1m→2m→4m→10m；401/403 → 30min）；手动刷新立即执行
- **历史**：每供应商最近 50 条、全局 500 条（内存，重启即清）
- **本地用量数据**：当日 token 消耗按「供应商 × 小时桶」落盘（`$DSH_HOME/quota-monitor/usage.json`，原子写、防抖 2s），按保留期修剪（默认 7 天，1–90 可配）
- **密钥**：DSH settings 命名空间 `quota-monitor`（`role('secret')` 脱敏、热重载、原子写）
- **各 API key 自动识别（v0.3）**：启动 / settings 热重载 / `llm/adapters-updated` / `credentials/reference-updated` 时，以 **DSH 接缝为准**探测 `llm-deepseek` 配置节与 `llm-pi-ai.providers` 字典（`ctx.llm` 目录/存活路由补充，凭据经 `ctx.credentials` 解析后回退 `process.env`），把每把普通 Key 归属到对应供应商（路由名精确/前缀 + 官方主机兜底归类）→ 自动启用 + 官方 Base URL（DSH 路由地址在白名单内才采用）+ **API Key 本体拷贝**（仅插件侧为空时填写，手动 Key 不覆盖、显式关闭不复活）。凭据类别守门：**DSH 普通聊天 Key 绝不套用到需要 Admin/Management Key 的组织/账户供应商**——OpenAI/Anthropic 聊天路由探测后仅提示「需 Admin Key 手动配置」；此类页面出现时设置面板标注手动填写。

## 客户端渲染契约（v0.2 重构）

浏览器半 `lib/client.js` 不操作侧边栏 DOM，全部走 DSH 官方客户端注入面：

| 槽位 | 注册 id/key | 内容 |
|---|---|---|
| `sidebar.footer.action`（list） | `id: quota-monitor` | 小组件主体：宽栏紧凑条 / rail 图标态；Popover 与弹层经 `createPortal` 挂 body |
| `settings.plugin.item` | `key: quota-monitor` | 设置页「插件清单 → 用量监控」卡片 |

依赖声明只列 boot graph 内真实存在的包；Popover 采用官方「贴底展开」定位；详情/设置是居中 overlay。客户端代码由宿主按 rev 重新下发，覆盖文件后刷新浏览器即可生效（无需重新构建插件）。

## 结构

```
lib/index.js      宿主半：settings 注册（schema 按供应商 needs 生成）、轮询调度、当前供应商/当日消耗量折叠、/api 路由、自动探测接入
lib/detect.js     DSH 路由→供应商识别（凭据类别×地域、官方主机/路径判定、Admin 不套用）与自动填入补丁
lib/providers.js  数据层：供应商注册表（13 项，元数据驱动 needs/baseUrl/官方端点白名单）+ 全部查询方法
lib/storage.js    本地用量数据（小时桶、保留期、原子写）
lib/client.js     客户端半：脚部槽位小组件 / Popover / 详情页 / 设置面板（按 needs 动态渲染）
test/smoke.mjs    数据层冒烟（Mock fetch：全部官方方法 + 端点校验 + 多币种/分页）
test/detect.mjs   自动探测单元测试（路由/地域/凭据类别/去重/无密钥/手动接管）
test/mock-dsh.mjs 宿主半集成冒烟（Mock ctx + fetch）
test/storage.mjs  本地用量数据存储单元测试
```

宿主路由（loopback 同源守卫）：`GET /api/quota-monitor/state`（含探测诊断 detect 与每供应商 needs/meta 元数据）·
`POST /refresh` · `POST /test`（`{supplier}`）· `POST /settings`（深合并，密钥留空 = 不变）。

## 安装

```bash
# 1. 添加插件（link 安装，目录即本仓库）
dsh plugin --profile web add link:/run/media/lin-qingyue/AI\ Project/DeepSeek\ harness/插件开发/用量监控

# 2. 重启 web GUI 使补丁生效（会中断当前会话）
dsh --profile web
```

装好后在 DSH 设置页（插件清单 → 用量监控卡片）配置各供应商密钥，或点小组件「详情 → 设置」。
v0.1/v0.2 升级：直接覆盖本目录文件后刷新浏览器 / 重启 web GUI 即可；旧 settings 中 deepseek/opencode/commandcode 配置原样保留，
新增供应商默认关闭，探测到 DSH 对应密钥后自动启用。

## 测试

```bash
node test/smoke.mjs      # 数据层：13 供应商解析 / 端点校验 / 多币种 / 分页 / 401
node test/detect.mjs     # 自动探测：路由映射 / 地域 / 凭据类别守门 / 去重
node test/mock-dsh.mjs   # 宿主半：路由 / 事件折叠 / 设置热更新 / 自动填入 / 退避
node test/storage.mjs    # 本地用量数据存储
```

## 仓库

源码：[github.com/shxtmaker/dsh-usage-monitor](https://github.com/shxtmaker/dsh-usage-monitor)
内网镜像：[http://192.168.3.100:3300/lqy/dsh-usage-monitor](http://192.168.3.100:3300/lqy/dsh-usage-monitor)
上游查询覆盖：[Token-Consumption-Monitoring docs/query-coverage.md](http://192.168.3.100:3300/lqy/Token-Consumption-Monitoring/src/branch/main/docs/query-coverage.md)

## 已知限制与后续

- 密钥**清除**需直接编辑 `$DSH_HOME/settings.yaml`（设置面板只支持留空不改）
- OpenAI / Anthropic 组织与 OpenRouter 账户（Management）供应商依赖 DSH 之外的更高凭据类别 → 不自动填，仅手动；真实账户联调尚未用真实 Admin/Management Key 验证（与上游验证记录一致）
- Codex（本机 CLI 登录）不注册；OpenCode / Command Code 独立 CLI 直连（不经 DSH 路由）的用法仍不可观测 → 恒候选、当日消耗显示 —
- 刷新历史仅内存；多日历史/趋势不在范围（本地用量数据小时桶可作后续趋势源）；响应头速率限额余量、GitHub/Cursor/云厂商（Vertex/Azure/Bedrock/百炼/方舟等）为后续项
- 阈值语义：百分比越大越紧（用量/限额）；余额类无限额概念，恒为正常态
