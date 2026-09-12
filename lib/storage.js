// lib/storage.js — 本地用量数据（供应商 × 小时桶，落盘到 DSH 数据目录）
// 文件：<DSH_HOME>/dsh-token-quota/usage.json（DSH_HOME 缺省为 ~/.dsh，与 DSH 自身
// dsh-home-paths 的解析规则一致：$DSH_HOME 优先，空白视为未设置）
// 结构：{ version: 1, savedAt, buckets: { supplierId: { "YYYYMMDDHH": tokens } } }
// 语义：
//   - 同一 (turn, step) 的 usage 样本是替换关系，折叠发生在宿主内存；
//     这里只负责「小时桶求和」的持久化与 保留期 修剪（小时桶 key 过期即删）。
//   - 原子写：先写同目录 tmp 再 rename，崩溃不留下半截 JSON。

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const USAGE_FILE_VERSION = 1;

/** DSH 数据根目录：$DSH_HOME（非空白）优先，否则 ~/.dsh。 */
export function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? resolve(env.trim()) : resolve(join(homedir(), ".dsh"));
}

/** 本插件用量数据目录名（v1.1.2 起；改名前的目录名见 LEGACY_DIR_NAME）。 */
export const USAGE_DIR_NAME = "dsh-token-quota";
/** 改名前（≤ v1.1.1）的用量数据目录名，仅用于一次性迁移。 */
export const LEGACY_DIR_NAME = "quota-monitor";

/** 本插件用量数据文件绝对路径。 */
export function usageFilePath(home, dirName = USAGE_DIR_NAME) {
  return join(home || dshHome(), dirName, "usage.json");
}

/**
 * 旧目录 → 新目录的一次性迁移（插件改名 dsh-usage-monitor → dsh-token-quota）。
 *
 * 只在「旧目录存在且新目录不存在」时搬一次；搬不动（跨设备 EXDEV、权限、被占用）
 * 不抛错、不删旧数据，返回旧路径继续读，下次启动再试。
 *
 * @returns 迁移后应使用的 usage.json 绝对路径。
 */
export function migrateUsageDir(home) {
  const root = home || dshHome();
  const next = usageFilePath(root);
  const legacy = usageFilePath(root, LEGACY_DIR_NAME);
  try {
    if (existsSync(legacy) && !existsSync(next)) {
      mkdirSync(dirname(next), { recursive: true });
      renameSync(join(root, LEGACY_DIR_NAME), join(root, USAGE_DIR_NAME));
    }
  } catch {
    /* 迁移失败：回落到旧路径读取，不丢数据 */
  }
  return existsSync(next) ? next : (existsSync(legacy) ? legacy : next);
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
  return readUsageFile(file).buckets;
}

export function readUsageFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || data.version !== USAGE_FILE_VERSION || !data.buckets || typeof data.buckets !== "object") {
      return { status: "invalid", buckets: {}, error: "用量文件格式或版本不受支持，已保留原文件" };
    }
    return { status: "ok", buckets: data.buckets };
  } catch (error) {
    return error.code === "ENOENT" ? { status: "missing", buckets: {} }
      : { status: "invalid", buckets: {}, error: `用量文件读取失败，已保留原文件：${error.message}` };
  }
}

/** 原子落盘（修剪后写入）；返回 { ok } 或 { ok:false, error }。 */
export function saveUsageFile(file, buckets, retentionDays = 7) {
  return writeUsageSnapshot(file, pruneBuckets(buckets, retentionDays));
}

function writeUsageSnapshot(file, buckets) {
  let tmp;
  try {
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ version: USAGE_FILE_VERSION, savedAt: new Date().toISOString(), buckets }, null, 2),
      "utf8",
    );
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* 已重命名或删除。 */ } }
  }
}

const stores = new Map();

/** 同进程共享桶；跨进程持有短写锁后按增量合并，避免旧快照覆盖。 */
export function acquireUsageStore(file, retentionDays = 7) {
  file = resolve(file);
  let store = stores.get(file);
  if (!store) {
    const loaded = readUsageFile(file);
    const buckets = pruneBuckets(loaded.buckets, retentionDays);
    store = { buckets, baseline: structuredClone(buckets), clients: new Map(),
      dirty: false, error: loaded.error || null, recordUsage: null };
    stores.set(file, store);
  }
  const token = Symbol();
  store.clients.set(token, retentionDays);
  function flush({ waitForLockMs = 0 } = {}) {
    if (!store.dirty) return { ok: !store.error, error: store.error };
    let lock;
    const lockFile = `${file}.lock`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const deadline = Date.now() + waitForLockMs;
      for (;;) {
        try { lock = openSync(lockFile, "wx"); break; }
        catch (error) {
          if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
          // 仅退出冲刷等待短写锁；运行期间失败后由宿主定时重试。
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const latest = readUsageFile(file);
      if (latest.status === "invalid") throw new Error(latest.error);
      const days = store.clients.size ? Math.max(...store.clients.values()) : retentionDays;
      const cutoff = Date.now() - days * 24 * 3600_000;
      const merged = pruneBuckets(latest.buckets, days);
      for (const id of new Set([...Object.keys(store.buckets), ...Object.keys(store.baseline)])) {
        const local = store.buckets[id] || {}, base = store.baseline[id] || {};
        for (const hour of new Set([...Object.keys(local), ...Object.keys(base)])) {
          const delta = (local[hour] || 0) - (base[hour] || 0);
          if (!delta || hourTimeMs(hour) < cutoff) continue;
          const hours = merged[id] ??= {};
          hours[hour] = Math.max(0, (hours[hour] || 0) + delta);
          if (!hours[hour]) delete hours[hour];
        }
        if (merged[id] && !Object.keys(merged[id]).length) delete merged[id];
      }
      const result = writeUsageSnapshot(file, merged);
      if (!result.ok) throw new Error(result.error);
      for (const id of Object.keys(store.buckets)) delete store.buckets[id];
      Object.assign(store.buckets, merged);
      store.baseline = structuredClone(merged);
      store.dirty = false;
      store.error = null;
      return { ok: true };
    } catch (error) {
      store.error = error.code === "EEXIST" ? "用量文件正在写入或存在遗留锁，稍后重试" : error.message;
      return { ok: false, error: store.error };
    } finally {
      if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockFile); } catch { /* 保留错误供下次写入报告。 */ } }
    }
  }
  let released = false;
  return {
    store, flush,
    markDirty() { store.dirty = true; },
    setRetention(days) {
      if (store.clients.get(token) !== days) store.dirty = true;
      store.clients.set(token, days);
    },
    release() {
      if (released) return { ok: true };
      const result = flush({ waitForLockMs: 2000 });
      released = true;
      store.clients.delete(token);
      if (!store.clients.size) stores.delete(file);
      return result;
    },
  };
}
