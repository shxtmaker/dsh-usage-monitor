import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const npm = process.env.npm_execpath;
if (!npm) throw new Error("请通过 npm run test:pack 运行");
const packed = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
assert.equal(packed.status, 0, packed.stderr);
const [manifest] = JSON.parse(packed.stdout);
const paths = new Set(manifest.files.map((file) => file.path));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
for (const required of [pkg.main, pkg.exports["./client"], pkg.dsh.bundle.patch, "lib/routes.js", "lib/storage.js", "README.md"]) {
  assert.ok(paths.has(required.replace(/^\.\//, "")), `产物缺少 ${required}`);
}
assert.equal(manifest.name, "dsh-usage-monitor");
assert.ok(!manifest.files.some((file) => file.path.startsWith("node_modules/") || file.path.startsWith("test-results/")));
console.log(`打包验证通过：${manifest.files.length} 个文件，${manifest.size} 字节`);
