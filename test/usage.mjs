import assert from "node:assert/strict";
import test from "node:test";
import { createUsageRecorder } from "../lib/usage.js";
import { hourKeyOf } from "../lib/storage.js";

test("replacement across midnight and suppliers subtracts from the original bucket", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const before = new Date(2026, 8, 8, 23, 59);
  const after = new Date(2026, 8, 9, 0, 1);
  record(session, "a", { inputTokens: 10 }, 1, 1, before);
  record(session, "b", { inputTokens: 30 }, 1, 1, after);
  assert.deepEqual(buckets.a, {});
  assert.deepEqual(buckets.b, { [hourKeyOf(before)]: 30 });
});
test("interleaved steps replace independently; invalid counts do not poison totals", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  record(session, "a", { inputTokens: 10 }, 1, 1);
  record(session, "a", { inputTokens: 20 }, 1, 2);
  record(session, "a", { inputTokens: 30, outputTokens: Infinity, cacheReadTokens: -3 }, 1, 1);
  assert.equal(buckets.a[hourKeyOf()], 50);
  record({}, "a", { inputTokens: 7 }, 1, 1);
  assert.equal(buckets.a[hourKeyOf()], 57);
});

// ---- C2：只有桶真的变了才返回 true（index.js 据此决定 markDirty / 排程落盘） ----
test("an unchanged final sample reports no change and never rewrites the bucket", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const at = new Date(2026, 8, 12, 10, 5);
  const sample = { inputTokens: 10, outputTokens: 20 };
  assert.equal(record(session, "a", sample, 1, 1, at), true, "首次样本必须记一次变更");
  const snapshot = JSON.stringify(buckets);
  let changes = 0;
  for (let i = 0; i < 100; i++) if (record(session, "a", sample, 1, 1, at)) changes++;
  assert.equal(changes, 0, "同一步骤的相同最终样本重复 100 次都不得算变更");
  assert.equal(JSON.stringify(buckets), snapshot, "桶内容必须逐字节不变");
  assert.equal(buckets.a[hourKeyOf(at)], 30);
});

test("a changed final count, a changed supplier and a midnight rollover all stay correct", () => {
  const buckets = {};
  const record = createUsageRecorder(buckets);
  const session = {};
  const at = new Date(2026, 8, 12, 10, 5);
  const first = new Date(2026, 8, 12, 23, 59);
  const later = new Date(2026, 8, 13, 0, 1);
  // 流式期间同一 (turn, step) 的早期样本被最终样本替换
  assert.equal(record(session, "a", { inputTokens: 10 }, 1, 1, first), true);
  assert.equal(record(session, "a", { inputTokens: 25 }, 1, 1, first), true, "最终数量变化必须算变更");
  assert.equal(buckets.a[hourKeyOf(first)], 25, "替换而非累加");
  // 供应商变化：旧桶扣减 + 新桶增加（同一步骤，归属小时仍是首次报告的小时）
  assert.equal(record(session, "b", { inputTokens: 40 }, 1, 1, first), true, "供应商变化必须算变更");
  assert.equal(buckets.a[hourKeyOf(first)], undefined, "旧供应商桶被扣空后删除");
  assert.equal(buckets.b[hourKeyOf(first)], 40);
  // 跨午夜的新步骤（非替换）落在新的本地小时桶
  assert.equal(record(session, "b", { inputTokens: 5 }, 1, 2, later), true);
  assert.equal(buckets.b[hourKeyOf(later)], 5);
  assert.equal(buckets.b[hourKeyOf(first)], 40, "跨日不得动到已有小时桶");
  // 未标识事件维持原有「每次都累加」规则（不做猜测去重）
  assert.equal(record(session, "b", { inputTokens: 3 }, null, null, at), true);
  assert.equal(record(session, "b", { inputTokens: 3 }, null, null, at), true, "未标识事件不参与去重");
  assert.equal(buckets.b[hourKeyOf(at)], 6);
  // 无效计数不改动桶，也不算变更
  const before = JSON.stringify(buckets);
  assert.equal(record(session, "a", { inputTokens: 0, outputTokens: 0 }, 9, 9, at), false, "全 0 样本不产生桶变化");
  assert.equal(record(session, "a", { inputTokens: NaN, outputTokens: "x" }, 9, 9, at), false, "非法计数不算变更");
  assert.equal(JSON.stringify(buckets), before, "无效输入不得污染桶");
});
