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

// ---- C3：官方地址策略只有一个事实来源（探测可采纳地址 ≡ 查询可使用的基础地址）----
test("every official supplier accepts exactly its declared hosts/base paths and rejects the rest without network calls", async (t) => {
  const { OFFICIAL_ENDPOINTS, OFFICIAL_HOSTS } = await import("../lib/providers.js");
  const { isOfficialBaseUrl } = await import("../lib/providers.js");
  // 任何被拒绝的地址都不得触发网络调用
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, text: async () => "{}" }; });

  const otherHost = "evil.example.com";
  const rejected = (id) => {
    const spec = OFFICIAL_ENDPOINTS[id];
    const host = spec.hosts[0];
    return [
      `https://other.example.com`,                       // 非官方主机
      `http://${host}`,                                  // 非 HTTPS
      `https://${host}:8443`,                            // 非默认端口
      `https://user:pass@${host}`,                       // 携带用户信息
      `https://${host}/v1?x=1`,                          // 查询串
      `https://${host}/v1#frag`,                         // fragment
      `https://${host}/not-a-known-base`,                // 未声明的基础路径
      `https://sub.${host}`,                             // 子域不匹配（精确主机）
      `not a url`,
      "",
    ];
  };

  for (const [id, spec] of Object.entries(OFFICIAL_ENDPOINTS)) {
    assert.deepEqual(OFFICIAL_HOSTS[id], spec.hosts, `${id} 的主机策略必须与端点策略同源`);
    // 声明过的基础路径全部可采纳
    for (const path of spec.basePaths) {
      const url = `https://${spec.hosts[0]}${path}`;
      assert.equal(isOfficialBaseUrl(id, url), true, `${id} 应采纳官方地址 ${url}`);
    }
    // 未声明的形态一律拒绝
    for (const url of rejected(id)) {
      assert.equal(isOfficialBaseUrl(id, url), false, `${id} 必须拒绝 ${JSON.stringify(url)}`);
    }
    // 通过探测校验拒绝的地址，在查询入口也不得发出请求
    const before = calls;
    const result = await PROVIDERS[id].query({ apiKey: "fake", baseUrl: `https://${otherHost}` });
    assert.equal(result.state, "err", `${id} 使用非法地址必须直接失败`);
    // 单端点供应商报 endpoint；Admin 供应商（用量 + 费用两路合并）报 partial
    assert.ok(["endpoint", "partial"].includes(result.error.code),
      `${id} 非法地址应报端点错误（实际 ${result.error.code}），不得是网络错误`);
    assert.match(result.error.message, /Base URL/, `${id} 错误信息必须指出是地址问题`);
    assert.equal(calls, before, `${id} 非法地址不得触发任何网络调用`);
  }
  // 私有兼容来源没有官方白名单：它们的安全边界另行处理（只要求安全 HTTPS 形态）
  assert.equal(OFFICIAL_ENDPOINTS.opencode, undefined);
  assert.equal(OFFICIAL_ENDPOINTS.commandcode, undefined);
});
