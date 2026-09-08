import assert from "node:assert/strict";
import test from "node:test";
import { createScheduler } from "../lib/scheduler.js";

const success = { state: "ok", entries: [{ remain: "10" }], headline: { amt: "10" } };
function fixture(query) {
  let time = 1000;
  const config = { enabled: true, apiKey: "old" };
  const history = [];
  const scheduler = createScheduler({ providers: { a: { query } }, getConfig: () => ({ ...config }),
    onRecord: (r) => history.push(r), now: () => time });
  return { scheduler, config, history, advance: (ms) => { time += ms; } };
}
test("returned failures use the complete backoff sequence and auth delay", async () => {
  let code = "network";
  let calls = 0;
  const f = fixture(() => { calls++; return { state: "err", error: { code, message: code }, entries: [] }; });
  for (const delay of [30000, 60000, 120000, 240000, 600000, 600000]) {
    await f.scheduler.run("a");
    const count = calls;
    f.advance(delay - 1);
    await f.scheduler.run("a");
    assert.equal(calls, count);
    f.advance(1);
  }
  code = "auth";
  await f.scheduler.run("a");
  const count = calls;
  f.advance(1800000 - 1);
  await f.scheduler.run("a");
  assert.equal(calls, count);
  assert.ok(f.history.every((r) => !r.ok));
});
test("concurrent refresh callers await one request", async () => {
  let resolve;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  const first = f.scheduler.run("a");
  const second = f.scheduler.run("a", { force: true });
  assert.equal(first, second);
  await Promise.resolve();
  resolve(success);
  assert.deepEqual(await second, await first);
  assert.equal(f.history.length, 1);
});
test("credential replacement and disposal discard late results", async () => {
  let resolve;
  const f = fixture(() => new Promise((r) => { resolve = r; }));
  const pending = f.scheduler.run("a");
  await Promise.resolve();
  f.config.apiKey = "new";
  f.scheduler.sync();
  resolve(success);
  assert.equal(await pending, null);
  assert.equal(f.history.length, 0);
  const next = f.scheduler.run("a");
  await Promise.resolve();
  f.scheduler.dispose();
  resolve(success);
  assert.equal(await next, null);
});
test("thrown failures preserve data and a successful manual retry resets delay", async () => {
  let fail = false;
  const f = fixture(() => { if (fail) throw new Error("offline"); return success; });
  await f.scheduler.run("a");
  fail = true;
  const failed = await f.scheduler.run("a", { force: true });
  assert.equal(failed.state, "err");
  assert.deepEqual(failed.entries, success.entries);
  fail = false;
  await f.scheduler.run("a", { force: true });
  assert.equal(f.scheduler.getState("a").failures, 0);
  assert.equal(f.scheduler.getState("a").nextAt, 61000);
});

test("a manual refresh after credential replacement queries the new revision and cancels the old one", async () => {
  const requests = [];
  let cfg = { enabled: true, apiKey: "old" };
  const scheduler = createScheduler({ providers: { a: { query(config, { signal }) {
    return new Promise((resolve) => requests.push({ key: config.apiKey, signal, resolve }));
  } } }, getConfig: () => ({ ...cfg }), onRecord() {} });
  const old = scheduler.run("a");
  await Promise.resolve();
  cfg.apiKey = "new";
  scheduler.sync();
  const fresh = scheduler.run("a", { force: true });
  await Promise.resolve();
  assert.notEqual(old, fresh);
  assert.deepEqual(requests.map((r) => r.key), ["old", "new"]);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ ...success, headline: { amt: "old" } });
  assert.equal(await old, null);
  assert.equal(scheduler.run("a", { force: true }), fresh);
  requests[1].resolve({ ...success, headline: { amt: "new" } });
  assert.equal((await fresh).headline.amt, "new");
  scheduler.dispose();
});
