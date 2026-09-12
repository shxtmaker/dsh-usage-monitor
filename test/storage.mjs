// test/storage.mjs — 本地用量数据存储单元测试（真实临时目录，纯 fs）
// 用法：node test/storage.mjs
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  sumDayTokens,
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

// ---- 今日统计：只读当天 24 个本地小时键 ----
{
  const noon = new Date(2026, 8, 12, 12, 30, 0); // 本地 2026-09-12 12:30
  const day = dayKeyOf(noon);
  const hours = {
    [`${day}00`]: 10, // 当天首小时
    [`${day}09`]: 5,
    [`${day}23`]: 100, // 当天末小时
    [`${day}24`]: 999, // 非法小时键不得计入
    [dayKeyOf(new Date(2026, 8, 11, 23, 0, 0)) + "23"]: 77, // 跨日边界：昨日末小时
    [dayKeyOf(new Date(2026, 8, 13, 0, 0, 0)) + "00"]: 88, // 明日首小时
    bad: 123,
  };
  assert.equal(sumDayTokens(hours, noon), 115, "只累加当天 00–23 的桶");
  assert.equal(sumDayTokens({}, noon), null, "空桶 → null");
  assert.equal(sumDayTokens(undefined, noon), null, "无桶 → null");
  assert.equal(sumDayTokens({ [`${day}00`]: 0, [`${day}01`]: -5, [`${day}02`]: "x" }, noon), null,
    "全 0/负数/非法值 → null（不把未知当 0 以外的意思，也不返回 0）");
  assert.equal(sumDayTokens({ [`${day}00`]: "12" }, noon), 12, "数值字符串按数值累加");
  // 读键次数上界：实现只允许发 24 次键查询（用 Proxy 计数）
  let reads = 0;
  const counted = new Proxy({ [`${day}03`]: 7 }, {
    get(target, key) { if (typeof key === "string") reads++; return target[key]; },
  });
  assert.equal(sumDayTokens(counted, noon), 7);
  assert.equal(reads, 24, "每个供应商最多 24 次小时键查询（不再遍历整份历史）");
  // 旧数据（远超保留期的时间桶）不影响当日读数，也不参与遍历
  const legacyHeavy = {};
  for (let i = 24; i < 2160; i++) legacyHeavy[hourKeyOf(new Date(noon.getTime() - i * 3600_000))] = i;
  assert.equal(sumDayTokens(legacyHeavy, noon), null, "90 天历史里当天无数据 → null");
  legacyHeavy[`${day}05`] = 3;
  assert.equal(sumDayTokens(legacyHeavy, noon), 3, "历史很长时当日读数不变");
  console.log("✓ 今日统计：只用当天 24 个小时键（含跨日/非法键/90 天历史）");
}

// ---- 两个不同时区的进程读同一份桶：按各自本地日求和 ----
{
  const { execFileSync } = await import("node:child_process");
  const storageUrl = new URL("../lib/storage.js", import.meta.url).href;
  // 固定在同一个 UTC 时刻（2026-09-12T23:30Z）：上海已是 9/13 07:30，纽约还是 9/12 19:30。
  const instant = Date.UTC(2026, 8, 12, 23, 30, 0);
  // 同一份桶（键按 UTC 小时写成）：上海窗口 2026091216–2026091307、纽约窗口 2026091204–2026091303
  const shared = { "2026091204": 4, "2026091212": 8, "2026091219": 16, "2026091223": 32, "2026091307": 64 };
  const script = `
    import { sumDayTokens, dayKeyOf } from ${JSON.stringify(storageUrl)};
    const d = new Date(Number(process.argv[1]));
    process.stdout.write(JSON.stringify({
      day: dayKeyOf(d),
      sum: sumDayTokens(${JSON.stringify(shared)}, d),
    }));
  `;
  const run = (tz) => JSON.parse(execFileSync(process.execPath,
    ["--input-type=module", "-e", script, String(instant)],
    { env: { ...process.env, TZ: tz }, encoding: "utf8" }));
  const shanghai = run("Asia/Shanghai");
  const newYork = run("America/New_York");
  assert.equal(shanghai.day, "20260913", "上海进程的自然日已跨到 9/13");
  assert.equal(newYork.day, "20260912", "纽约进程的自然日仍是 9/12");
  assert.equal(shanghai.sum, 64, "上海只统计本地 9/13 的桶（19:30Z 已是次日 03:30）");
  assert.equal(newYork.sum, 4 + 8 + 16 + 32, "纽约只统计本地 9/12 的桶（UTC 深夜仍属当地当天）");
  console.log("✓ 时区：两个进程各按本地日求和，互不串日");
}

// ---- 改名迁移：旧目录 quota-monitor/ → 新目录 dsh-token-quota/ ----
// 覆盖成功迁移、重复调用幂等、新旧并存、目标空目录、目标无 usage.json 回落、跨设备/权限失败。
const migDir = mkdtempSync(join(tmpdir(), "qm-migrate-"));
const legacyDirPath = join(migDir, LEGACY_DIR_NAME);
const legacyPath = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyPath, { deepseek: { [recentKey]: 42 } }, 7);
assert.equal(existsSync(legacyPath), true, "旧目录文件应已就位");
const migratedPath = migrateUsageDir(migDir);
assert.equal(migratedPath.path, usageFilePath(migDir), "应返回新目录路径");
assert.equal(migratedPath.status, "migrated", "旧目录存在且目标目录不存在时必须真的搬迁");
assert.equal(existsSync(legacyPath), false, "旧目录应已搬走");
assert.equal(existsSync(legacyDirPath), false, "旧目录本身不得残留");
assert.deepEqual(loadUsageFile(migratedPath.path), { deepseek: { [recentKey]: 42 } }, "迁移后数据必须原样保留");
// 幂等：再调一次不应报错、不应改动数据（目标已存在 → kept-new）
const migratedAgain = migrateUsageDir(migDir);
assert.equal(migratedAgain.path, usageFilePath(migDir));
assert.equal(migratedAgain.status, "kept-new");
assert.deepEqual(loadUsageFile(migratedAgain.path), { deepseek: { [recentKey]: 42 } }, "重复调用不得改动数据");
console.log("✓ 改名迁移：旧用量目录搬到新目录且数据无损（含重复调用幂等）");

// 新目录已存在时不动旧目录（避免覆盖现有数据）
const legacyAgain = usageFilePath(migDir, LEGACY_DIR_NAME);
saveUsageFile(legacyAgain, { stale: { [recentKey]: 1 } }, 7);
const afterSecond = migrateUsageDir(migDir);
assert.equal(afterSecond.path, usageFilePath(migDir), "已有新目录时仍用新目录");
assert.equal(afterSecond.status, "kept-new", "新旧并存时不得合并、不得覆盖");
assert.deepEqual(loadUsageFile(afterSecond.path), { deepseek: { [recentKey]: 42 } }, "不得被旧目录覆盖");
assert.equal(existsSync(legacyAgain), true, "新旧并存时旧目录必须原样保留，不能删");
console.log("✓ 新目录已存在时不搬迁、不覆盖");

// 目标目录存在、但新目录里没有 usage.json：旧文件仍在 → 回落旧路径读，不嵌套、不合并
const splitDir = mkdtempSync(join(tmpdir(), "qm-split-"));
const splitNextDir = usageFilePath(splitDir).replace(/[\\/]usage\.json$/, "");
mkdirSync(splitNextDir, { recursive: true }); // 目标空目录（第三方残留）
const splitLegacy = usageFilePath(splitDir, LEGACY_DIR_NAME);
saveUsageFile(splitLegacy, { moonshot: { [recentKey]: 7 } }, 7);
const splitResult = migrateUsageDir(splitDir);
assert.equal(splitResult.status, "fallback-legacy", "目标空目录 + 旧文件 → 必须回落旧路径");
assert.equal(splitResult.error, "target-dir-exists", "必须记下回落原因供诊断");
assert.equal(splitResult.path, splitLegacy, "回落时必须返回旧 usage.json 路径");
assert.deepEqual(loadUsageFile(splitResult.path), { moonshot: { [recentKey]: 7 } }, "回落读到的仍是旧数据");
assert.equal(existsSync(splitLegacy), true, "回落时不得删除旧文件");
assert.equal(existsSync(usageFilePath(splitDir)), false, "回落时不得凭空造出空的新文件");
assert.equal(existsSync(join(splitNextDir, LEGACY_DIR_NAME)), false, "不得把旧目录嵌套进目标目录（POSIX rename 陷阱）");
// 阻碍消失后下一次启动仍能成功迁移
rmSync(splitNextDir, { recursive: true, force: true });
const splitRetry = migrateUsageDir(splitDir);
assert.equal(splitRetry.status, "migrated", "目标目录被清理后重试必须成功迁移");
assert.deepEqual(loadUsageFile(splitRetry.path), { moonshot: { [recentKey]: 7 } }, "重试迁移后数据不变");
console.log("✓ 目标空目录/缺 usage.json：回落旧路径读，不嵌套不合并（清理后可重试）");

// 跨设备（EXDEV）/ 权限（EPERM）失败：不删旧数据，回落旧路径，状态可诊断
const failDir = mkdtempSync(join(tmpdir(), "qm-fail-"));
const failLegacy = usageFilePath(failDir, LEGACY_DIR_NAME);
saveUsageFile(failLegacy, { zai: { [recentKey]: 5 } }, 7);
const realRenameSync = fs.renameSync;
for (const code of ["EXDEV", "EPERM"]) {
  fs.renameSync = () => { const error = new Error(`simulated ${code}`); error.code = code; throw error; };
  syncBuiltinESMExports();
  const failed = migrateUsageDir(failDir);
  assert.equal(failed.status, "fallback-legacy", `${code}：必须回落旧路径`);
  assert.equal(failed.error, code, `${code}：必须把失败原因记进 status`);
  assert.equal(failed.path, failLegacy, `${code}：必须继续用旧 usage.json`);
  assert.deepEqual(loadUsageFile(failed.path), { zai: { [recentKey]: 5 } }, `${code}：数据不得丢失`);
  assert.equal(existsSync(failLegacy), true, `${code}：不得删除旧数据`);
  assert.equal(existsSync(usageFilePath(failDir)), false, `${code}：不得留下半截新文件`);
}
fs.renameSync = realRenameSync;
syncBuiltinESMExports();
// 故障恢复后下一次启动仍能成功迁移（同一进程内 self-heal）
assert.equal(migrateUsageDir(failDir).status, "migrated", "故障恢复后重试必须成功迁移");
console.log("✓ EXDEV/EPERM 失败：回落旧路径读且不丢数据，恢复后重试成功");
rmSync(failDir, { recursive: true, force: true });

// 两边都没有：返回新目录路径（首次安装的正常路径）
const freshDir = mkdtempSync(join(tmpdir(), "qm-fresh-"));
assert.equal(migrateUsageDir(freshDir).path, usageFilePath(freshDir), "全新安装应直接用新目录");
assert.equal(migrateUsageDir(freshDir).status, "none", "全新安装无迁移状态");
console.log("✓ 全新安装：直接用新目录");

rmSync(migDir, { recursive: true, force: true });
rmSync(splitDir, { recursive: true, force: true });
rmSync(freshDir, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });
console.log("\n存储单元测试全部通过 ✔");
