import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../lib/index.js";

// 独立宿主数据目录；不读取真实 DSH 配置或供应商凭据。
const home = mkdtempSync(join(tmpdir(), "qm-browser-"));
process.env.DSH_HOME = home;
const routes = new Map();
let schema, watch;
let config = { suppliers: { opencode: { enabled: true, orgId: "org-original" } } };
function merge(a, b) {
  const result = structuredClone(a);
  for (const [key, value] of Object.entries(b)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(result[key] || {}, value) : value;
  }
  return result;
}
const dispose = apply({ settings: {
  register(ns, s) { schema = s; config = schema(config); return {
    get: () => config, watch(cb) { watch = cb; return () => {}; }, describe: () => ({ user: config }),
  }; },
  get() {}, update: async (ns, patch) => { config = schema(merge(config, patch)); watch?.(config); },
}, webServer: { register(r) { routes.set(r.path, r.handler); return () => {}; } }, on() { return () => {}; } });

const assets = new Map([
  ["/", [new URL("./shell.html", import.meta.url), "text/html; charset=utf-8"]],
  ["/client.js", [new URL("../../lib/client.js", import.meta.url), "text/javascript"]],
  ["/react.js", [new URL("../../node_modules/react/umd/react.development.js", import.meta.url), "text/javascript"]],
  ["/react-dom.js", [new URL("../../node_modules/react-dom/umd/react-dom.development.js", import.meta.url), "text/javascript"]],
]);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (routes.has(path)) { await routes.get(path)(req, res); return; }
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": asset[1] }); res.end(readFileSync(asset[0]));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(4179, "127.0.0.1");
function close() { dispose(); server.close(); rmSync(home, { recursive: true, force: true }); }
process.on("SIGINT", close); process.on("SIGTERM", close);
