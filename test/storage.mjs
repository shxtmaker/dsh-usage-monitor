// test/storage.mjs — 本地用量数据存储单元测试（真实临时目录，纯 fs）
// 用法：node test/storage.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_DIR_NAME,
  USAGE_DIR_NAME,
  dayKeyOf,
  hourKeyOf,
  hourTimeMs,
  loadUsageFile,
  migrateUsageDir,
  pruneBuckets,
  saveUsageFile,
  usageFilePath,
} from "../lib/storage.js";

const dir = mkdtempSync(join(tmpdir(), "qm-storage-"));
const file = usageFilePath(dir);

// ---- 时间 key ----
// 夹具相对真实时钟生成（保留期按 Date.now() 修剪，避免硬编码日期过期）
const nowMs = Date.now();
const now = new Date(nowMs - (nowMs % 3_600_000)); // 对齐到整点，本地时间
const hour = now.getHours();
const keyNow = hourKeyOf(now);
assert.equal(dayKeyOf(now), keyNow.slice(0, 8));
assert.equal(hourTimeMs(keyNow), now.getTime());
assert.equal(hourTimeMs("not-a-key"), 0);
console.log(`✓ 小时桶 key：${keyNow}（YYYYMMDDHH / 日前缀 / 解析）`);

// ---- 保留期修剪 ----
const oldKey = hourKeyOf(new Date(now.getTime() - 8 * 24 * 3600_000)); // 8 天前
const recentKey = hourKeyOf(new Date(now.getTime() - 3600_000)); // 1 小时前
const buckets = {
  deepseek: { [oldKey]: 999, [recentKey]: 100, bad: 5 },
  opencode: { [recentKey]: 50, zeroed: 0 },
};
const bucketsBefore = JSON.stringify(buckets);
const pruned = pruneBuckets(buckets, 7, now);
assert.deepEqual(pruned, { deepseek: { [recentKey]: 100 }, opencode: { [recentKey]: 50 } }, "过期/非法/零值桶应被修剪");
assert.equal(JSON.stringify(buckets), bucketsBefore, "修剪不得修改入参");
console.log("✓ 保留期修剪：只留 7 天内 >0 的合法小时桶");

// ---- 原子写 + 载入回读 ----
const res = saveUsageFile(file, buckets, 7);
assert.equal(res.ok, true);
assert.equal(existsSync(file), true, "用量文件应已写入");
const loaded = loadUsageFile(file);
assert.deepEqual(loaded, pruned, "载入回读应与修剪后一致");
console.log(`✓ 落盘/载入：${file}`);

// ---- 损坏/缺失文件容忍 ----
assert.deepEqual(loadUsageFile(join(dir, "missing.json")), {}, "缺失文件应返回空");
const junk = join(dir, "junk.json");
saveUsageFile(junk, {}, 7);
assert.deepEqual(loadUsageFile(junk), {}, "空桶文件应返回空");
console.log("✓ 缺失/空文件容错");

// ---- 改名迁移：旧目录 quota-monitor/ → 新目录 dsh-token-quota/ ----
const migDir = mkdtempSync(join(tmpdir(), "qm-migrate-"));
const legacyPath = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyPath, { deepseek: { [recentKey]: 42 } }, 7);
assert.equal(existsSync(legacyPath), true, "旧目录文件应已就位");
const migratedPath = migrateUsageDir(migDir);
assert.equal(migratedPath, usageFilePath(migDir), "应返回新目录路径");
assert.equal(existsSync(legacyPath), false, "旧目录应已搬走");
assert.deepEqual(loadUsageFile(migratedPath), { deepseek: { [recentKey]: 42 } }, "迁移后数据必须原样保留");
console.log("✓ 改名迁移：旧用量目录搬到新目录且数据无损");

// 新目录已存在时不动旧目录（避免覆盖现有数据）
const legacyAgain = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyAgain, { stale: { [recentKey]: 1 } }, 7);
const afterSecond = migrateUsageDir(migDir);
assert.equal(afterSecond, usageFilePath(migDir), "已有新目录时仍用新目录");
assert.deepEqual(loadUsageFile(afterSecond), { deepseek: { [recentKey]: 42 } }, "不得被旧目录覆盖");
console.log("✓ 新目录已存在时不搬迁、不覆盖");

// 两边都没有：返回新目录路径（首次安装的正常路径）
const freshDir = mkdtempSync(join(tmpdir(), "qm-fresh-"));
assert.equal(migrateUsageDir(freshDir), usageFilePath(freshDir), "全新安装应直接用新目录");
console.log("✓ 全新安装：直接用新目录");

rmSync(migDir, { recursive: true, force: true });
rmSync(freshDir, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });
console.log("\n存储单元测试全部通过 ✔");
