# 发布流程

适用于 `dsh-token-quota` 的版本发布。远端：GitHub `shxtmaker/dsh-token-quota`、内网 Gitea `lqy/dsh-token-quota`。

## 0. 前置检查

```bash
npm ci --ignore-scripts
npm test                 # 顶层测试项必须全绿
npm run test:browser     # 首次需 npx playwright install chromium
npm run test:pack
for f in lib/*.js; do node --check "$f"; done
git diff --check
```

任何一项失败都不要继续打标签。

## 1. 版本号

同步修改（三处必须一致）：

- `package.json` 的 `version`
- `package-lock.json` 顶层的 `version` 与 `packages[""].version`
- `README.md`：`当前版本：**vX.Y.Z**` 与安装示例中的 `dsh-token-quota-X.Y.Z.tgz`

语义化约定：修复类改动递增补丁号；新增能力/架构调整递增次版本号；不新增破坏性变更（本轮保持 `usage.json` 版本 1 可回读）。

## 2. 更新验证文档

- `docs/runtime-reliability.md`：本轮行为变更与存储设计。
- `docs/validation-report.md`：环境、实跑命令与实测数值、需求追踪、**未执行项**。
- 基准数值用 `node scripts/benchmark-storage.mjs` 与 `node scripts/benchmark-runtime.mjs` 现场生成，不要沿用旧数字。

## 3. 提交与标签

```bash
git add -A
git commit -m "release: vX.Y.Z <一句话摘要>"
git tag -a vX.Y.Z -m "vX.Y.Z <要点逐条>"
```

标签一律用 **annotated tag**（`-a`），与 v1.1.1 起的既有标签一致。

## 4. 打包产物

```bash
npm pack --pack-destination .                       # npm 安装包（39 个文件，含 lib/test/scripts）
git archive --format=tar.gz --prefix=dsh-token-quota-X.Y.Z/ \
  -o dsh-token-quota-X.Y.Z-source.tar.gz vX.Y.Z     # 源码快照（额外含 docs/ 与 .github/）
sha256sum dsh-token-quota-X.Y.Z.tgz dsh-token-quota-X.Y.Z-source.tar.gz
```

`*.tgz` 已在 `.gitignore` 中，产物不进版本库。发布前用产物本身再跑一遍，避免「只测源码」：

```bash
cd $(mktemp -d) && tar -xzf <repo>/dsh-token-quota-X.Y.Z.tgz
cd package && npm install --ignore-scripts && npm test && npm run test:browser
```

## 5. 推送

```bash
git push origin main
git push origin vX.Y.Z
git push gitea main
git push gitea vX.Y.Z
```

需要注意的一致性检查：

- `git ls-remote --tags <remote>` 与 `git tag` 对比，确认没有该远端缺失的历史标签（v1.2.1 曾只存在于 GitHub）。
- GitHub 远端 URL 必须指向当前仓库名 `shxtmaker/dsh-token-quota`；旧名 `dsh-usage-monitor` 只靠 301 跳转，容易误判。
- 推送是外部可见且难以撤回的操作：确认版本号、目标远端与提交内容后再执行。

## 6. 发布说明

在两个远端的 tag 页面写清：行为变更清单、验证证据（测试项数、打包文件数、基准数值）、以及**验证边界**（未在 Windows 主机、未接真实 DSH、未访问真实计费账户等）。产物校验和一并附上。
