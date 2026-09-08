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
