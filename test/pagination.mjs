import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../lib/providers.js";

test("unfinished organization pagination never publishes a partial total", async () => {
  const original = globalThis.fetch;
  let page = 0;
  globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({
    data: [], has_more: true, next_page: String(++page),
  }) });
  try {
    const openai = await PROVIDERS["openai-org"].query({ apiKey: "test" });
    assert.equal(openai.state, "err");
    assert.match(openai.error.message, /分页上限/);
    assert.deepEqual(openai.entries, []);
    const anthropic = await PROVIDERS["anthropic-org"].query({ apiKey: "test" });
    assert.equal(anthropic.state, "err");
    assert.match(anthropic.error.message, /后续分页/);
    assert.deepEqual(anthropic.entries, []);
  } finally { globalThis.fetch = original; }
});
