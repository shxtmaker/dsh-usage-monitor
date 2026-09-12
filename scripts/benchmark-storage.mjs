import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireUsageStore, saveUsageFile, hourKeyOf } from "../lib/storage.js";

const root = mkdtempSync(join(tmpdir(), "qm-benchmark-"));
try {
  for (const days of [7, 90]) {
    const buckets = {};
    for (let s = 0; s < 13; s++) {
      const hours = buckets[`supplier-${s}`] = {};
      for (let h = 0; h < days * 24; h++) hours[hourKeyOf(new Date(Date.now() - h * 3600000))] = 10000;
    }
    const file = join(root, `${days}.json`);
    const initial = saveUsageFile(file, buckets, days);
    if (!initial.ok) throw new Error(initial.error);
    const store = acquireUsageStore(file, days), times = [];
    for (let i = 0; i < 10; i++) {
      store.store.buckets["supplier-0"][hourKeyOf()]++;
      store.markDirty();
      const start = performance.now(), result = store.flush();
      if (!result.ok) throw new Error(result.error);
      times.push(performance.now() - start);
    }
    store.release();
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ days, bytes: statSync(file).size,
      medianMs: +((times[4] + times[5]) / 2).toFixed(2), maxMs: +times.at(-1).toFixed(2) }));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
