// test/migration.mjs — 插件改名（dsh-usage-monitor → dsh-token-quota）的一次性迁移
// 用法：node test/migration.mjs
//
// 覆盖两件事：
//   1) settings 命名空间 quota-monitor → dsh-token-quota（旧数据保留、不覆盖新配置）
//   2) 用量目录 <DSH_HOME>/quota-monitor/ → dsh-token-quota/（真实临时目录，见 test/storage.mjs）
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const NS = "dsh-token-quota";
const LEGACY_NS = "quota-monitor";

/** 最小 Cordis ctx：只装 settings / webServer，记录 update 调用。 */
function makeCtx({ user, legacyUser }) {
  const updates = [];
  const ctx = {
    settings: {
      register: (ns) => ({
        get: () => ({}),
        watch: () => () => {},
        describe: () => ({ user }),
      }),
      describe: () => [
        { ns: NS, value: user, user },
        ...(legacyUser === undefined ? [] : [{ ns: LEGACY_NS, value: legacyUser, user: legacyUser }]),
      ],
      update: async (ns, patch) => { updates.push({ ns, patch }); },
    },
    webServer: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, updates };
}

const home = mkdtempSync(join(tmpdir(), "qm-migrate-ns-"));
process.env.DSH_HOME = home;
const legacySuppliers = { deepseek: { enabled: true, apiKey: "sk-legacy" } };

// 1) 新命名空间为空 + 旧命名空间有用户配置 ⇒ 整段拷到新命名空间，且旧的不动
{
  const { ctx, updates } = makeCtx({ user: undefined, legacyUser: { suppliers: legacySuppliers } });
  const dispose = apply(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 1, "应恰好触发一次迁移写入");
  assert.equal(updates[0].ns, NS, "写入目标必须是新命名空间");
  assert.deepEqual(updates[0].patch, { suppliers: legacySuppliers }, "必须整段拷贝旧用户配置（含密钥）");
  assert.notEqual(updates[0].ns, LEGACY_NS, "绝不能写回旧命名空间");
  dispose();
  console.log("✓ 旧命名空间配置已迁移到新命名空间（旧数据保留）");
}

// 2) 新命名空间已有用户配置 ⇒ 不迁移、不覆盖
{
  const { ctx, updates } = makeCtx({ user: { suppliers: { deepseek: { apiKey: "sk-new" } } }, legacyUser: { suppliers: legacySuppliers } });
  const dispose = apply(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 0, "新命名空间已有配置时不得覆盖");
  dispose();
  console.log("✓ 新命名空间已有配置：不迁移、不覆盖");
}

// 3) 没有旧命名空间（全新安装）⇒ 不写入
{
  const { ctx, updates } = makeCtx({ user: undefined, legacyUser: undefined });
  const dispose = apply(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 0, "全新安装不该产生迁移写入");
  dispose();
  console.log("✓ 全新安装：无迁移写入");
}

// 4) 旧命名空间存在但为空对象 ⇒ 不写入
{
  const { ctx, updates } = makeCtx({ user: undefined, legacyUser: {} });
  const dispose = apply(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 0, "旧命名空间为空对象时不该写入");
  dispose();
  console.log("✓ 旧命名空间为空：不写入");
}


// 5) describe 抛异常 ⇒ 不迁移、不崩，且走 warn（迁移失败必须留痕）
{
  const updates = [];
  const ctx = {
    settings: {
      register: () => ({ get: () => ({}), watch: () => () => {}, describe: () => ({ user: undefined }) }),
      describe: () => { throw new Error("settings backend down"); },
      update: async (ns, patch) => { updates.push({ ns, patch }); },
    },
    webServer: { register: () => () => {} },
    on: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() { warned.push(1); }, error() {} },
  };
  const warned = [];
  const dispose = apply(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(updates.length, 0, "describe 失败时不得写入");
  assert.equal(warned.length, 1, "迁移失败必须 warn 留痕，不能静默");
  dispose();
  console.log("✓ describe 失败：不写入、走 warn 留痕");
}

rmSync(home, { recursive: true, force: true });
console.log("\n改名迁移测试全部通过 ✔");
