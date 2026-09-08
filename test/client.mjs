import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import React from "react";
import { create, act } from "react-test-renderer";

function client(fetch, timers = []) {
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
  return slots["sidebar.footer.action"];
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
