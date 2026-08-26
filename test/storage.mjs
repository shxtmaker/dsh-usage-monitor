// test/storage.mjs — 本地用量数据存储单元测试（真实临时目录，纯 fs）
// 用法：node test/storage.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dayKeyOf,
  hourKeyOf,
  hourTimeMs,
  loadUsageFile,
  pruneBuckets,
  saveUsageFile,
  usageFilePath,
} from "../lib/storage.js";

const dir = mkdtempSync(join(tmpdir(), "qm-storage-"));
const file = usageFilePath(dir);

// ---- 时间 key ----
const now = new Date(2026, 7, 26, 19, 30); // 2026-08-26 19:30 本地
assert.equal(hourKeyOf(now), "2026082619");
assert.equal(dayKeyOf(now), "20260826");
assert.equal(hourTimeMs("2026082619"), new Date(2026, 7, 26, 19).getTime());
assert.equal(hourTimeMs("not-a-key"), 0);
console.log("✓ 小时桶 key：YYYYMMDDHH / 日前缀 / 解析");

// ---- 保留期修剪 ----
const oldKey = hourKeyOf(new Date(2026, 7, 18, 10)); // 8 天前
const recentKey = hourKeyOf(new Date(2026, 7, 26, 18));
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

rmSync(dir, { recursive: true, force: true });
console.log("\n存储单元测试全部通过 ✔");
