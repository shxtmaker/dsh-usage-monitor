import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

test("host-derived custom routes share attribution and tool events do not change the latest call", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "qm-routes-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const events = new Map(), routes = new Map();
  const dispose = apply({ settings: {
    register: () => ({ get: () => ({ suppliers: {} }), watch: () => () => {}, describe: () => ({}) }),
    get: (ns) => ns === "llm-pi-ai" ? { providers: {
      "custom-a": { baseURL: "https://api.deepseek.com" },
      "custom-b": { baseURL: "https://api.deepseek.com" },
    } } : {}, update: async () => {},
  }, webServer: { register(r) { routes.set(r.path, r.handler); return () => {}; } },
  on(n, f) { events.set(n, f); return () => {}; } });
  t.after(() => { dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true }); });
  await routes.get("/api/quota-monitor/rescan")({ method: "POST", headers: {}, url: "/" }, { writeHead() {}, end() {} });
  const emit = (s, type, data) => events.get("session/event")(s, { type, data });
  const read = (url = "/") => {
    let state;
    routes.get("/api/quota-monitor/state")({ method: "GET", headers: {}, url },
      { writeHead() {}, end(s) { state = JSON.parse(s); } });
    return state;
  };
  const a = { id: "a" }, b = { id: "b" };
  emit(a, "assistant/message", { message: { source: { provider: "custom-a", model: "a" } }, usage: { inputTokens: 100 }, turn: 1, step: 1 });
  emit(b, "assistant/message", { message: { source: { provider: "custom-b", model: "b" } }, usage: { inputTokens: 20 }, turn: 1, step: 1 });
  assert.equal(read().suppliers.find((s) => s.id === "deepseek").todayTokens, 120);
  const before = read().active;
  emit(a, "tool/result", {});
  assert.deepEqual(read().active, before);
  assert.equal(before.model, "b");
  events.get("api-session/removed")("a");
  assert.equal(read("/?session=a").active, null);
  assert.equal(read("/?session=b").active.model, "b");
});
