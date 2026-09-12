import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

test("OpenCode rejects a successful HTTP response without recognized data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, text: async () => "{}" }));
  const result = await PROVIDERS.opencode.query({ apiKey: "fake" });
  assert.equal(result.state, "err");
  assert.equal(result.error.code, "no-data");
});

test("cancellation reaches the HTTP request and prevents subsequent pages", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const result = PROVIDERS["openai-org"].query({ apiKey: "fake" }, { signal: controller.signal });
  controller.abort();
  assert.equal((await result).state, "err");
  assert.equal(calls, 2); // 并发用量和费用各一个请求，没有后续分页。
});
