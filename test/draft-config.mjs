import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply } from "../lib/index.js";
import { PROVIDERS } from "../lib/providers.js";

test("test connection validates the current draft without persisting it", async (t) => {
  const previous = process.env.DSH_HOME, home = mkdtempSync(join(tmpdir(), "qm-draft-"));
  process.env.DSH_HOME = home;
  const routes = new Map(), queried = [];
  let writes = 0;
  t.mock.method(PROVIDERS.opencode, "query", async (config) => {
    queried.push(config); return { state: "ok", entries: [], headline: { amt: "10" } };
  });
  const dispose = apply({ settings: {
    register: () => ({ get: () => ({ suppliers: { opencode: { enabled: false, apiKey: "saved", orgId: "saved-org" } } }), watch: () => () => {} }),
    update: async () => { writes++; },
  }, webServer: { register(r) { routes.set(r.path, r.handler); return () => {}; } }, on() { return () => {}; } });
  t.after(() => { dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true }); });
  async function request(body) {
    const req = Object.assign(new PassThrough(), { method: "POST", headers: {} });
    let result;
    const response = routes.get("/api/dsh-token-quota/test")(req, { writeHead() {}, end(s) { result = JSON.parse(s); } });
    req.end(JSON.stringify(body)); await response; return result;
  }
  assert.equal((await request({ supplier: "opencode", config: { apiKey: "draft", orgId: "draft-org" } })).ok, true);
  assert.equal(queried[0].apiKey, "draft"); assert.equal(queried[0].orgId, "draft-org");
  assert.equal((await request({ supplier: "opencode", config: { warnPct: 200 } })).ok, false);
  assert.equal(queried.length, 1);
  await request({ supplier: "opencode" });
  assert.equal(queried[1].apiKey, "saved"); assert.equal(writes, 0);
});
