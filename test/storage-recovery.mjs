import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { acquireUsageStore, hourKeyOf, loadUsageFile, saveUsageFile } from "../lib/storage.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "qm-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, "usage.json") };
}
test("shared instances preserve usage when an idle instance exits", (t) => {
  const { file } = fixture(t);
  const a = acquireUsageStore(file), b = acquireUsageStore(file);
  a.store.buckets.deepseek = { [hourKeyOf()]: 100 }; a.markDirty();
  assert.equal(a.release().ok, true);
  assert.equal(b.release().ok, true);
  assert.equal(loadUsageFile(file).deepseek[hourKeyOf()], 100);
});
test("another process's updates are merged with the local delta", (t) => {
  const { file } = fixture(t);
  saveUsageFile(file, { deepseek: { [hourKeyOf()]: 100 } });
  const a = acquireUsageStore(file);
  a.store.buckets.deepseek[hourKeyOf()] += 20; a.markDirty();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { acquireUsageStore, hourKeyOf } from ${JSON.stringify(new URL("../lib/storage.js", import.meta.url).href)};
    const store = acquireUsageStore(process.argv[1]);
    store.store.buckets.deepseek[hourKeyOf()] += 30;
    store.markDirty();
    if (!store.release().ok) process.exit(1);
  `, file], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(a.release().ok, true);
  assert.equal(loadUsageFile(file).deepseek[hourKeyOf()], 150);
});
test("corrupt history survives release and new events; repair enables a retry", (t) => {
  const { file } = fixture(t);
  const original = '{"version":1,"buckets":';
  writeFileSync(file, original);
  const store = acquireUsageStore(file);
  store.store.buckets.deepseek = { [hourKeyOf()]: 5 }; store.markDirty();
  assert.equal(store.flush().ok, false);
  assert.equal(readFileSync(file, "utf8"), original);
  writeFileSync(file, JSON.stringify({ version: 1, buckets: {} }));
  assert.equal(store.release().ok, true);
  assert.equal(loadUsageFile(file).deepseek[hourKeyOf()], 5);
});
test("failed rename removes its temporary file", (t) => {
  const { root, file } = fixture(t);
  mkdirSync(file);
  assert.equal(saveUsageFile(file, { deepseek: { [hourKeyOf()]: 10 } }).ok, false);
  assert.deepEqual(readdirSync(root), ["usage.json"]);
});
test("a held write lock preserves dirty updates for a later retry", (t) => {
  const { file } = fixture(t);
  const store = acquireUsageStore(file);
  store.store.buckets.deepseek = { [hourKeyOf()]: 10 }; store.markDirty();
  writeFileSync(`${file}.lock`, "locked");
  assert.equal(store.flush().ok, false);
  rmSync(`${file}.lock`);
  assert.equal(store.release().ok, true);
  assert.equal(loadUsageFile(file).deepseek[hourKeyOf()], 10);
});

test("reducing retention removes expired history even without a new usage event", (t) => {
  const { file } = fixture(t);
  const old = hourKeyOf(new Date(Date.now() - 20 * 86400000));
  saveUsageFile(file, { deepseek: { [old]: 100, [hourKeyOf()]: 10 } }, 90);
  const store = acquireUsageStore(file, 90);
  store.setRetention(7);
  assert.equal(store.release().ok, true);
  assert.deepEqual(loadUsageFile(file).deepseek, { [hourKeyOf()]: 10 });
});
