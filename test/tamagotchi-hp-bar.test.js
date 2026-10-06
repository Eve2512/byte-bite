"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { computeHpBarModel, mountHpBar, applyHpBarModel } = require("../src/tamagotchi-hp-bar");
const { registerTamagotchiIpc } = require("../src/tamagotchi-ipc");
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function snap(overrides = {}) {
  return {
    enabled: true,
    showHpBar: true,
    stage: "content",
    alive: true,
    fullness: 0.5,
    faintsAt: NOW + 12 * HOUR,
    faintAfterMs: 24 * HOUR,
    capturedAt: NOW,
    ...overrides,
  };
}

describe("tamagotchi HP bar visibility", () => {
  it("is hidden unless the feature and the HP bar pref are both on", () => {
    assert.equal(computeHpBarModel(null, NOW).visible, false);
    assert.equal(computeHpBarModel(snap({ enabled: false }), NOW).visible, false);
    assert.equal(computeHpBarModel(snap({ showHpBar: false }), NOW).visible, false);
    assert.equal(computeHpBarModel(snap({ showHpBar: undefined }), NOW).visible, false);
    assert.equal(computeHpBarModel(snap(), NOW).visible, true);
  });

  it("is hidden in mini mode and before a pet exists", () => {
    assert.equal(computeHpBarModel(snap(), NOW, { miniMode: true }).visible, false);
    assert.equal(computeHpBarModel(snap({ stage: null, fullness: null }), NOW).visible, false);
  });
});

describe("tamagotchi HP bar level", () => {
  it("interpolates fullness locally from faintsAt/faintAfterMs", () => {
    assert.equal(computeHpBarModel(snap(), NOW).fraction, 0.5);
    assert.equal(computeHpBarModel(snap(), NOW + 6 * HOUR).fraction, 0.25);
  });

  it("shifts green -> amber -> red with the store's stage thresholds", () => {
    assert.equal(computeHpBarModel(snap(), NOW).level, "ok");
    assert.equal(computeHpBarModel(snap(), NOW + 6 * HOUR).level, "low");
    assert.equal(computeHpBarModel(snap(), NOW + 11 * HOUR).level, "critical");
  });

  it("shows an empty bar with zzz when fainted", () => {
    for (const model of [
      computeHpBarModel(snap({ stage: "fainted", alive: false, faintsAt: null, fullness: 0 }), NOW),
      computeHpBarModel(snap(), NOW + 13 * HOUR),
    ]) {
      assert.deepEqual(model, { visible: true, fraction: 0, level: "fainted", text: "zzz" });
    }
  });

  it("falls back to the pushed fullness without timeline data", () => {
    const model = computeHpBarModel(snap({ faintsAt: undefined, fullness: 0.8 }), NOW);
    assert.equal(model.fraction, 0.8);
    assert.equal(model.level, "ok");
  });
});

describe("tamagotchi HP bar DOM", () => {
  function fakeDocument() {
    const make = (tag) => ({
      tag,
      hidden: false,
      attrs: {},
      style: {},
      children: [],
      textContent: "",
      setAttribute(name, value) { this.attrs[name] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
    });
    return { createElement: make, root: make("div") };
  }

  it("mounts a hidden bar and applies models", () => {
    const doc = fakeDocument();
    const view = mountHpBar(doc, doc.root);
    assert.equal(doc.root.children[0], view.bar);
    assert.equal(view.bar.id, "tamagotchi-hp-bar");
    assert.equal(view.bar.hidden, true);
    applyHpBarModel(view, computeHpBarModel(snap(), NOW + 6 * HOUR));
    assert.equal(view.bar.hidden, false);
    assert.equal(view.bar.attrs["data-level"], "low");
    assert.equal(view.fill.style.width, "25%");
    applyHpBarModel(view, computeHpBarModel(snap(), NOW, { miniMode: true }));
    assert.equal(view.bar.hidden, true);
  });
});

describe("tamagotchi HP bar wiring", () => {
  it("defaults off and validates as a boolean pref", () => {
    assert.equal(prefs.getDefaults().tamagotchiShowHpBar, false);
    const deps = { snapshot: prefs.getDefaults() };
    assert.equal(updateRegistry.tamagotchiShowHpBar(true, deps).status, "ok");
    assert.equal(updateRegistry.tamagotchiShowHpBar("yes", deps).status, "error");
  });

  it("ipc stamps display prefs on pushes, pulls and resends", () => {
    const handlers = new Map();
    const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
    let listener = null;
    const store = {
      snapshot: () => ({ enabled: true, stage: "full" }),
      onChange: (fn) => { listener = fn; return () => { listener = null; }; },
    };
    let show = false;
    const sent = [];
    const ipc = registerTamagotchiIpc({
      ipcMain,
      store,
      sendToRenderer: (channel, payload) => sent.push(payload),
      decorate: (s) => ({ ...s, showHpBar: show }),
    });
    assert.equal(handlers.get("tamagotchi:get-snapshot")().showHpBar, false);
    show = true;
    listener({ enabled: true, stage: "hungry" });
    ipc.resend();
    assert.deepEqual(sent.map((s) => s.showHpBar), [true, true]);
    ipc.dispose();
  });

  it("the pet page loads the HP bar script before renderer.js and main resends on pref change", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
    const barAt = html.indexOf('<script src="tamagotchi-hp-bar.js"></script>');
    assert.ok(barAt > 0 && barAt < html.indexOf('<script src="renderer.js"></script>'));
    const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
    assert.match(renderer, /hpBarApi\.mountHpBar\(document, container\)/);
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.ok(main.includes('_settingsController.subscribeKey("tamagotchiShowHpBar", () => _tamagotchiIpc.resend());'));
    assert.ok(main.includes('showHpBar: _settingsController.get("tamagotchiShowHpBar") === true,'));
  });
});
