# dsh-usage-monitor（用量监控）

当前版本：**v1.2.1**（2026-09-09）。

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

## v1.1 新增

- **设置页「仅显示已添加」**：供应商目录与详情页分栏只显示**已添加供应商**——服务端推导（最新 DSH 探测命中 ∨ 已启用 ∨ 任一密钥已填；仅改阈值/Base URL 不算；显式停用但有密钥仍显示）。未添加的收进目录底部**「可添加供应商」折叠列表**，每项「打开配置 → 添加」，保存后即加入主目录。
- **重新扫描按钮（标题行）**：设置目录标题行显示「已接入 N」计数芯片 + **⟳ 重新扫描**，结果独立一行（接入名单 / 最近扫描时间 / 失败原因）。按钮触发 `POST /api/quota-monitor/rescan`，与周期自动探测完全一致（幂等自动填入、尊重手动密钥与显式关闭）；发现新的可添加供应商时**自动展开并高亮**。
- **窗口用量重置时间补齐（Command Code）**：5h / 周窗口的 `resetAt`（真实契约 = epoch-毫秒，已用真实账户复核）经宽容解析显示「约 X 小时后重置 / M月D日 重置」；月额度显示订阅周期结束 `currentPeriodEnd`（缺省如实标注，绝不把 `currentPeriodStart` 当重置）；窗口确实未提供重置时刻的行如实标注「未提供重置时刻」，不伪造。
- **供应商配置页「当前额度」预览**：独立配置页展示最近一次取数的限额条目（含重置时间），与小组件 Popover / 详情卡片同一份数据 → 三处一致。

## 功能

- **小组件（sidebar 脚部）**：**经 DSH 官方槽位 `sidebar.footer.action` 嵌入**侧边栏底部，与其他脚部按钮/组件同处内容流、并排渲染，**不扫描/不劫持 DOM、不做 fixed 悬浮**；宽栏紧凑条主显示**当前显示页正在使用的模型供应商**——显示页 = 侧栏会话列表当前选中的会话（官方 `sessions.list.current`），显示该会话**最近一次**真实 LLM 调用命中的供应商 + 模型名（「在用 DeepSeek · deepseek-chat」+ 相对时间）；多会话并行用不同供应商时**各页互不串**，切会话经 sessions 订阅即时重拉、同页内每 10s 刷新；当前页尚无调用（含新会话/空页）严格显示「暂无调用」，不回退其它页。点击展开 Popover 查看各供应商限额；rail 窄栏自动切换图标态。弹层列表仍显示**当前供应商**（DSH 启用 ∩ 近期流量；组织账务等无 DSH 路由的供应商恒为候选；冷启动或近 24h 无流量时按启用清单兜底并标注）
- **详情页**：供应商分栏（kanban 风，仅已添加供应商），栏头状态胶囊 + 限额/用量/费用条目卡片；刷新历史默认收起；刷新全部 / 设置入口
- **设置**：原生设置卡片 + 详情页内面板；配置界面为「**供应商页目录（仅显示已添加）→ 每个供应商独立配置页**」——目录行内可直接启停/测试连接，点「打开配置」进入该供应商单页（凭据类别徽标、**当前额度预览**、按 needs 动态渲染的密钥字段、Base URL/警告·临界阈值、测试连接、保存）；目录底部「可添加供应商」折叠列表提供手动添加入口；标题行含 **⟳ 重新扫描** 与最近扫描结果；全局轮询间隔/保留期单独一组；OpenCode 页含 allowance Token 与 org id
- **调度**：默认 60s 轮询（10–3600 可配）；同供应商 in-flight 合并去重；失败指数退避（30s→1m→2m→4m→10m；401/403 → 30min）；手动刷新立即执行
- **历史**：每供应商最近 50 条、全局 500 条（内存，重启即清）
- **本地用量数据**：当日 token 消耗按「供应商 × 小时桶」落盘（`$DSH_HOME/quota-monitor/usage.json`，原子写、防抖 2s），按保留期修剪（默认 7 天，1–90 可配）
- **密钥**：DSH settings 命名空间 `quota-monitor`（`role('secret')` 脱敏、热重载、原子写）
- **各 API key 自动识别（v0.3 起）**：启动 / settings 热重载 / `llm/adapters-updated` / `credentials/reference-updated` 时，以 **DSH 接缝为准**探测 `llm-deepseek` 配置节与 `llm-pi-ai.providers` 字典（`ctx.llm` 目录/存活路由补充，凭据经 `ctx.credentials` 解析后回退 `process.env`），把每把普通 Key 归属到对应供应商（路由名精确/前缀 + 官方主机兜底归类）→ 自动启用 + 官方 Base URL（DSH 路由地址在白名单内才采用）+ **API Key 本体拷贝**（仅插件侧为空时填写，手动 Key 不覆盖、显式关闭不复活）。凭据类别守门：**DSH 普通聊天 Key 绝不套用到需要 Admin/Management Key 的组织/账户供应商**——OpenAI/Anthropic 聊天路由探测后仅提示「需 Admin Key 手动配置」；此类页面出现时设置面板标注手动填写。

## 客户端渲染契约

浏览器半 `lib/client.js` 不操作侧边栏 DOM，全部走 DSH 官方客户端注入面：

| 槽位 | 注册 id/key | 内容 |
|---|---|---|
| `sidebar.footer.action`（list） | `id: quota-monitor` | 小组件主体：宽栏紧凑条（「在用」当前显示页最近一次调用的 供应商 · 模型 + 相对时间）/ rail 图标态；跟随 `sessions.list.current` 切页即时重拉；Popover 与弹层经 `createPortal` 挂 body |
| `settings.plugin.item` | `key: quota-monitor` | 设置页「插件清单 → 用量监控」卡片 |

依赖声明只列 boot graph 内真实存在的包；Popover 采用官方「贴底展开」定位；详情/设置是居中 overlay。客户端代码由宿主按 rev 重新下发，覆盖文件后刷新浏览器即可生效（无需重新构建插件）。

## 结构

```
lib/index.js      宿主半：settings 注册（schema 按供应商 needs 生成）、轮询调度、当前供应商/当日消耗量折叠、
                  自动探测接入、/api 路由（含 /rescan）、每供应商 added/addedReason 推导
lib/detect.js     DSH 路由→供应商识别（凭据类别×地域、官方主机/路径判定、Admin 不套用）与自动填入补丁
lib/providers.js  数据层：供应商注册表（13 项，元数据驱动 needs/baseUrl/官方端点白名单）+ 全部查询方法
                  （含重置时间宽容解析：ISO / epoch-毫秒；窗口缺 resetAt 如实标注）
lib/scheduler.js  查询调度、失败退避、并发合并与配置版本失效
lib/usage.js      会话步骤用量替换记账（跨小时保留首次报告小时）
lib/storage.js    本地用量数据（小时桶、保留期、增量合并、写入锁与恢复保护）
lib/routes.js     自动探测与事件记账共用的供应商路由归属
lib/client.js     客户端半：脚部槽位小组件（sessions.list 跟随当前显示页）/ Popover / 详情页 /
                  设置面板（已添加过滤目录 + 可添加列表 + 标题行重新扫描 + 配置页当前额度预览）
test/smoke.mjs    数据层冒烟（Mock fetch：全部官方方法 + 端点校验 + 多币种/分页 + CC 重置时间）
test/detect.mjs   自动探测单元测试（路由/地域/凭据类别/去重/无密钥/手动接管）
test/mock-dsh.mjs 宿主半集成冒烟（Mock ctx + fetch；含 added 推导与 /rescan）
test/storage.mjs  本地用量数据存储单元测试
```

宿主路由（loopback 同源守卫）：`GET /api/quota-monitor/state[?session=<会话id>]`（含探测诊断 detect、每供应商 needs/meta 元数据与 `added/addedReason`；带 `?session=` 时 `active` 为该会话页最近一次调用，空串/未知会话=暂无，缺参=全局最近一次）·
`POST /refresh`（同样支持 `?session=` 保持会话范围）· `POST /test`（`{supplier}`）· `POST /settings`（深合并，密钥留空 = 不变）·
`POST /rescan`（手动触发与周期自动探测一致的 DSH 扫描 + 自动填入，返回与 /state 相同载荷）。

## 安装

请先安装 Git、Node.js 与 DSH，并确认 `dsh --version` 可以正常运行。以下命令使用 `web` profile；其他 profile 请替换命令中的名称。当前验证环境为 Node.js 24.19.0、DSH 0.1.2-rc.1。

### 从源码安装

Linux / macOS：

```bash
git clone https://github.com/shxtmaker/dsh-usage-monitor.git
cd dsh-usage-monitor
npm ci
dsh plugin --profile web add "link:$(pwd)"
dsh --profile web
```

Windows PowerShell：

```powershell
git clone https://github.com/shxtmaker/dsh-usage-monitor.git
Set-Location dsh-usage-monitor
npm ci
$pluginDirectory = (Get-Location).Path
dsh plugin --profile web add "link:$pluginDirectory"
dsh --profile web
```

`link:` 安装直接使用该源码目录，请保留目录。若 DSH 已在运行，请先结束当前任务并退出，再重新启动；重启会中断尚未完成的会话任务。

### 从压缩包安装

在源码目录执行 `npm pack`，得到 `dsh-usage-monitor-1.2.1.tgz`。也可以使用已有的同名安装包。传给 DSH 的文件路径应为绝对路径，避免 profile 工作目录影响相对路径解析。

Linux / macOS（安装包位于当前目录）：

```bash
dsh plugin --profile web add "$(pwd)/dsh-usage-monitor-1.2.1.tgz"
```

Windows PowerShell：

```powershell
$archivePath = (Resolve-Path ./dsh-usage-monitor-1.2.1.tgz).Path
dsh plugin --profile web add $archivePath
```

安装后重新启动 `dsh --profile web`。压缩包不包含 DSH 与第三方依赖，首次安装仍可能需要联网下载依赖。

装好后在 DSH 设置页（插件清单 → 用量监控卡片）配置各供应商密钥，或点小组件「详情 → 设置」。

### 升级与检查

源码链接安装：在源码目录执行 `git pull --ff-only` 和 `npm ci`，然后重启 DSH 并刷新浏览器。压缩包安装：用新版本安装包的绝对路径重新执行上述 `add` 命令，再重启。

若之前安装的是旧包名 `dsh-quota-monitor`，先执行 `dsh plugin --profile web list --depth 0` 确认旧包仍在，再执行 `dsh plugin --profile web remove dsh-quota-monitor`，最后按上述步骤安装 `dsh-usage-monitor`。不要同时保留两个包。设置命名空间仍为 `quota-monitor`，已保存供应商设置可以继续使用。

执行 `dsh plugin --profile web list --depth 0` 应能看到 `dsh-usage-monitor`；启动后侧边栏底部应出现“用量”，设置页插件清单中应出现“用量监控”。没有配置密钥或当前会话尚无调用时，空状态属于正常行为。

## 测试

```bash
npm test                # 单元测试与宿主集成回归
npm run test:pack        # 安装包入口与文件清单验证
npx playwright install chromium
npm run test:browser     # Chromium 键盘、表单失败与窄屏交互
node test/smoke.mjs      # 数据层：13 供应商解析 / 端点校验 / 多币种 / 分页 / 401 / CC 重置时间
node test/detect.mjs     # 自动探测：路由映射 / 地域 / 凭据类别守门 / 去重
node test/mock-dsh.mjs   # 宿主半：路由 / 事件折叠 / 设置热更新 / 自动填入 / added 推导 / /rescan / 退避
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
- Z.ai / 智谱 等仅返回百分比（无任何时刻字段）的行如实标注、不显示重置时间（不推断、不伪造）；Command Code 窗口重置时间为真实 `resetAt`（epoch-毫秒，已复核）
- 刷新历史仅内存；多日历史/趋势不在范围（本地用量数据小时桶可作后续趋势源）；响应头速率限额余量、GitHub/Cursor/云厂商（Vertex/Azure/Bedrock/百炼/方舟等）为后续项
- 阈值语义：百分比越大越紧（用量/限额）；余额类无限额概念，恒为正常态

## 开发验证

使用 Node.js 24 运行验证。在仓库目录执行：

```bash
npm ci
npm test
npm run test:pack
```

测试包括供应商查询解析、自动探测、存储恢复与跨进程合并、宿主路由与会话隔离、调度取消、用量替换、客户端保存失败，以及 added 推导和重新扫描回归。供应商响应均为模拟数据，不访问真实账户。浏览器测试使用真实 React、插件 HTTP 路由和隔离的数据目录；真实 DSH 的安装及槽位接入另行验收。CI 在 Windows 与 Linux 上运行单元、打包及 Chromium 测试。

查询切换配置或卸载插件时会取消旧请求；整次查询最长 120 秒，单个 HTTP 请求最长 20 秒。自动扫描共享同一调度入口；已删除会话的索引随宿主删除事件回收。

用量文件采用同进程共享、跨进程短写锁和增量合并。读取损坏文件或不支持的版本时保留原文件，并在详情中显示存储错误；修复文件后可重试保存。写入失败不会清除尚未保存的内存增量。异常退出若遗留 `usage.json.lock`，请先确认使用该数据目录的 DSH 进程均已停止，再移除该锁文件并重启。退出时仍无法写入的增量不能保证保留。

查询配置变化会清除该供应商的旧结果；旧请求完成后不再发布数据。失败刷新保留同一配置下的旧数据并标记失败。
同一会话、同一轮次与步骤的用量更新替换此前样本；跨小时及跨午夜时仍归入首次报告的小时。
HTTP 路由仅接受约定的 GET/POST 方法；带 Origin 的浏览器请求必须与本机宿主的协议、主机和端口一致。
通过反向代理访问时需另外设计受信任的公开来源配置，本版本不会信任转发头。
Anthropic 组织响应若声明仍有后续分页，会报告失败，避免将首页数据当作完整总数。
