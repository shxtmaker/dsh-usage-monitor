// lib/storage.js — 本地用量数据（供应商 × 小时桶，落盘到 DSH 数据目录）
// 文件：<DSH_HOME>/quota-monitor/usage.json（DSH_HOME 缺省为 ~/.dsh，与 DSH 自身
// dsh-home-paths 的解析规则一致：$DSH_HOME 优先，空白视为未设置）
// 结构：{ version: 1, savedAt, buckets: { supplierId: { "YYYYMMDDHH": tokens } } }
// 语义：
//   - 同一 (turn, step) 的 usage 样本是替换关系，折叠发生在宿主内存；
//     这里只负责「小时桶求和」的持久化与 保留期 修剪（小时桶 key 过期即删）。
//   - 原子写：先写同目录 tmp 再 rename，崩溃不留下半截 JSON。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const USAGE_FILE_VERSION = 1;

/** DSH 数据根目录：$DSH_HOME（非空白）优先，否则 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : resolve(join(homedir(), ".dsh"));
}

/** 本插件用量数据文件绝对路径。 */
export function usageFilePath(home) {
  return join(home || dshHome(), "quota-monitor", "usage.json");
}

/** 小时桶 key：本地时区的 YYYYMMDDHH。 */
export function hourKeyOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}`;
}

/** 自然日 key：YYYYMMDD（本地时区）。 */
export function dayKeyOf(date = new Date()) {
  return hourKeyOf(date).slice(0, 8);
}

/** 把小时桶 key 解析为本地时间戳；非法 key 返回 0（修剪时直接丢弃）。 */
export function hourTimeMs(key) {
  if (typeof key !== "string" || !/^\d{10}$/.test(key)) return 0;
  const d = new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(4, 6)) - 1,
    Number(key.slice(6, 8)),
    Number(key.slice(8, 10)),
    0,
    0,
    0,
  );
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

/** 按保留期修剪小时桶（默认 7 天）；只保留 >0 的合法桶。返回新对象，不修改入参。 */
export function pruneBuckets(buckets, retentionDays = 7, now = new Date()) {
  const days = Math.max(1, Number(retentionDays) || 7);
  const cutoff = now.getTime() - days * 24 * 3600_000;
  const out = {};
  for (const [id, hours] of Object.entries(buckets || {})) {
    if (!hours || typeof hours !== "object") continue;
    const kept = {};
    for (const [key, value] of Object.entries(hours)) {
      const tokens = Number(value);
      if (Number.isFinite(tokens) && tokens > 0 && hourTimeMs(key) >= cutoff) {
        kept[key] = Math.floor(tokens);
      }
    }
    if (Object.keys(kept).length) out[id] = kept;
  }
  return out;
}

/** 载入用量文件；缺失/损坏/版本不符一律视为空（不影响插件运行）。 */
export function loadUsageFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || data.version !== USAGE_FILE_VERSION || !data.buckets || typeof data.buckets !== "object") {
      return {};
    }
    return data.buckets;
  } catch {
    return {};
  }
}

/** 原子落盘（修剪后写入）；返回 { ok } 或 { ok:false, error }。 */
export function saveUsageFile(file, buckets, retentionDays = 7) {
  try {
    const pruned = pruneBuckets(buckets, retentionDays);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: USAGE_FILE_VERSION, savedAt: new Date().toISOString(), buckets: pruned }, null, 2),
      "utf8",
    );
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}