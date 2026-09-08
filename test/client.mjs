import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

function client(fetch, timers = [], slot = "sidebar.footer.action") {
  let plugin;
  const slots = {};
  const document = { querySelector() { return true; }, body: {}, addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load({ factory }) {
      plugin = factory((id) => id === "react" ? React : { createPortal: (child) => child });
    } } }, document, fetch, console,
    setInterval(fn) { timers.push(fn); return fn; }, clearInterval() {},
  });
  plugin.apply({ locale: { register() {} }, effect() {}, slots: {
    inject(name, fn) { fn(); }, register({ name }, component) { slots[name] = component; },
  } });
  return slots[slot];
}
const payload = (name) => ({ ok: true, suppliers: [], active: { name, model: "model", at: Date.now() } });
test("collapsed sidebar click opens and closes the detail dialog", async () => {
  const Component = client(async () => ({ json: async () => payload("A") }));
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: false, t: (k) => k })); });
    await act(async () => { tree.root.findByProps({ className: "qm-rail" }).props.onClick(); });
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 1);
    const close = tree.root.findAllByType("button").find((b) => b.props["aria-label"] === "close" || b.children.includes("close"));
    assert.ok(close);
    await act(async () => { close.props.onClick(); });
    assert.equal(tree.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("late state responses cannot overwrite a newer poll", async () => {
  const pending = [];
  const timers = [];
  const Component = client(() => new Promise((resolve) => pending.push(resolve)), timers);
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { wide: true, t: (k) => k })); });
    await act(async () => { timers[0](); });
    await act(async () => { pending[1]({ json: async () => payload("new") }); });
    await act(async () => { pending[0]({ json: async () => payload("old") }); });
    assert.ok(tree.root.findByProps({ className: "qm-strip-summary" }).children[0].includes("new"));
  } finally { await act(async () => { tree?.unmount(); }); }
});

test("settings preserve non-secret values and retain the draft on rejected saves", async () => {
  const posts = [];
  const data = { ok: true, poll: {}, suppliers: [{ id: "opencode", name: "OpenCode", added: true,
    enabled: true, orgId: "org-original", meta: { needs: [{ key: "apiKey", secret: true }, { key: "orgId", secret: false }] } }] };
  const Component = client(async (url, opts) => {
    if (opts?.method === "POST") posts.push(JSON.parse(opts.body));
    return { ok: opts?.method !== "POST", status: 400,
      json: async () => opts?.method === "POST" ? { ok: false, error: "validation rejected" } : data };
  }, [], "settings.plugin.item");
  let tree;
  try {
    await act(async () => { tree = create(React.createElement(Component, { t: (k) => k })); });
    await act(async () => { tree.root.findByProps({ className: "qm-card-btn" }).props.onClick(); });
    assert.equal(tree.root.findByProps({ role: "dialog" }).props["aria-modal"], true);
    await act(async () => { tree.root.findByProps({ className: "qm-page-main" }).props.onClick(); });
    assert.ok(tree.root.findAllByType("input").some((i) => i.props.value === "org-original"));
    await act(async () => { tree.root.findAllByType("button").find((b) => b.children.includes("save")).props.onClick(); });
    assert.equal(posts[0].suppliers.opencode.orgId, "org-original");
    assert.equal(tree.root.findAllByProps({ className: "qm-page-head" }).length, 1);
    assert.equal(tree.root.findAllByProps({ className: "s-saved" }).length, 0);
    assert.equal(tree.root.findByProps({ role: "alert" }).children[0], "validation rejected");
  } finally { await act(async () => tree?.unmount()); }
});
