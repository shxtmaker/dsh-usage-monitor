# dsh-quota-monitor（用量监控）

DeepSeek Harness 插件：显示各供应商**可用周期限额**——sidebar 小组件 + 详情页，支持

- **DeepSeek**：账户余额（`/user/balance`）
- **OpenCode**：5h 滚动 / 周 / 月窗口用量（`/zen/go/v1/usage`）+ allowance 计量表（`/api/go/status`，OAuth + x-org-id）
- **Command Code**：5h / 周窗口额度 + 套餐月额度（`/alpha/billing/*`，plan 表随上游；DSH 自动填入的聊天网关 baseURL 会自动收敛到同源根路径 `/alpha/*`）

数据层移植自 [Token-Consumption-Monitoring](https://github.com/shxtmaker/Token-Consumption-Monitoring) `refactor/unified-query-methods` 分支的「统一查询方法」模式（Describe→Scan→Query），只保留纯 HTTP 方法；Windows 专属方法（WebView2 控制台、本地 SQLite）已按规格丢弃。

## 功能

- **小组件（sidebar）**：状态点 + 名称 + 百分比（余额类显示金额）+ 当日 token 消耗量；点击弹 popover（限额项/重置/错误/上次刷新）；只显示**当前供应商**（DSH 启用 ∩ 近期流量，「无 DSH 路由的供应商恒为候选」；只有真实 session/event 才算流量信号，冷启动未调用或近 24h 无任何流量时按启用清单兜底显示，兜底时标注「近 24h 无流量」，避免小组件「暂无供应商」）；**位置自适应**——插在侧栏底部按钮区上方（8px 间隙永不重叠），内容超高内部滚动，侧栏收起为窄栏时自动隐藏
- **详情页**：供应商分栏（kanban 风），栏头状态胶囊 + 限额项卡片；刷新历史表格默认收起；刷新全部 / 设置入口
- **设置**：原生设置卡片（`settings.plugin.item` 槽位）+ 详情页内面板；每供应商 启用 / API Key（password 掩码）/ Base URL / 警告·临界阈值；全局轮询间隔；**测试连接**按钮
- **调度**：默认 60s 轮询（10–3600 可配）；同供应商 in-flight 合并去重；失败指数退避（30s→1m→2m→4m→10m；401/403 → 30min）；手动刷新立即执行并重置计时器
- **历史**：每供应商最近 50 条、全局 500 条（内存，重启即清）
- **密钥**：DSH 原生 settings 命名空间 `quota-monitor`（`$DSH_HOME/settings.yaml`，热重载、原子写、`role('secret')` 脱敏）
- **自动探测**：启动 / settings 热重载 / `llm/adapters-updated` / `credentials/reference-updated` 时探测 DSH LLM 注册表（`ctx.llm` 目录 + 存活路由）与 `llm-deepseek` / `llm-pi-ai` 配置节；命中支持路由（`deepseek-official`、pi-ai `deepseek` / `opencode-go` / `commandcode-goat` 及前缀变体）且 DSH user 层已配置/凭据库已存密钥 → 自动启用 + Base URL + **API Key 自动填入**（从 DSH 凭据库/环境变量拷贝进插件 settings，`role('secret')` 脱敏；仅当插件侧 Key 为空时填写）；用户手动填过 Key 或显式关闭的不覆盖；已探测但暂不支持的供应商（openrouter 等）仅在设置面板提示

## 结构

```
lib/index.js      宿主半：settings 注册、轮询调度、当前供应商/当日消耗量折叠、/api 路由、自动探测接入
lib/detect.js     自动探测 DSH 已添加供应商（ctx.llm 目录/存活路由 + 配置节 + 凭据解析）与自动填入补丁
lib/providers.js  数据层：三种供应商取数方法（可独立复用）
lib/client.js     客户端半：小组件 / 详情页 / 设置面板（纯 React.createElement，无构建）
test/smoke.mjs    数据层冒烟（Mock fetch）
test/detect.mjs   自动探测单元测试（目录/凭据/去重/无密钥）
test/mock-dsh.mjs 宿主半集成冒烟（Mock ctx + fetch）
```

宿主路由（loopback 同源守卫）：

| 路由 | 说明 |
|---|---|
| `GET /api/quota-monitor/state` | 完整状态（供应商/当前集/当日消耗/历史/设置回显 + 探测诊断 `detect`） |
| `POST /api/quota-monitor/refresh` | 强制刷新全部启用的供应商，返回新状态 |
| `POST /api/quota-monitor/test` | `{supplier}` 单次取数测试 |
| `POST /api/quota-monitor/settings` | 深合并写入设置（密钥留空 = 不变） |

## 安装

```bash
# 1. 添加插件（link 安装，目录即本仓库）
dsh plugin --profile web add link:/run/media/lin-qingyue/AI\ Project/DeepSeek\ harness/插件开发/用量监控

# 2. 重启 web GUI 使补丁生效（会中断当前会话）
dsh --profile web

# 3. 验证
dsh --profile web --dump-config   # 应出现 quota-monitor 行
```

装好后在 DSH 设置页（插件清单 → 用量监控卡片）配置各供应商密钥，或点小组件「详情 → 设置」。

## 测试

```bash
node test/smoke.mjs      # 数据层：三供应商解析 / 401 / 格式化
node test/mock-dsh.mjs   # 宿主半：路由 / 事件折叠 / 设置热更新 / 退避
```

## 仓库

源码：[github.com/shxtmaker/dsh-usage-monitor](https://github.com/shxtmaker/dsh-usage-monitor)（作者 [shxtmaker](https://github.com/shxtmaker)）

## 已知限制与后续

- 密钥**清除**需直接编辑 `$DSH_HOME/settings.yaml`（本版设置面板只支持留空不改）
- OpenCode / Command Code 如果经由 llm-pi-ai 路由（`opencode-go`、`commandcode-goat` 等）接入 DSH → 可自动探测，也有「当日消耗量」与当前集流量过滤；独立 CLI 直连（不经 DSH 路由）的用法仍不可观测 → 恒候选、消耗显示 —；多日历史/趋势不在范围内
- 刷新历史仅内存保存（落盘列入迷雾）；响应头速率限额余量、OpenRouter/Moonshot 供应商扩展为后续项
- 阈值语义：百分比越大越紧（用量/限额）；余额类无限额概念，恒为正常态