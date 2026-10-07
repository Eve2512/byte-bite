"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");
const { createTamagotchiStore } = require("../src/tamagotchi-store");

function loadTab() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-tab-tamagotchi.js"), "utf8"), context);
  return context.ClawdSettingsTabTamagotchi;
}

function loadI18n() {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(SRC, "settings-i18n.js"), "utf8"), context);
  return context.ClawdSettingsI18n.STRINGS;
}

describe("tamagotchi prefs and validators", () => {
  it("defaults keep the feature off with 24h / 100k", () => {
    const d = prefs.getDefaults();
    assert.equal(d.tamagotchiEnabled, false);
    assert.equal(d.tamagotchiShowHpBar, false);
    assert.equal(d.tamagotchiFaintAfterHours, 24);
    assert.equal(d.tamagotchiTokensPerBelly, 100000);
  });

  it("load-time validation drops out-of-range values", () => {
    const v = prefs.validate({ tamagotchiFaintAfterHours: 5, tamagotchiTokensPerBelly: -1 });
    assert.equal(v.tamagotchiFaintAfterHours, 24);
    assert.equal(v.tamagotchiTokensPerBelly, 100000);
    const ok = prefs.validate({ tamagotchiFaintAfterHours: 72, tamagotchiTokensPerBelly: 250000 });
    assert.equal(ok.tamagotchiFaintAfterHours, 72);
    assert.equal(ok.tamagotchiTokensPerBelly, 250000);
  });

  it("settings validators accept only the offered choices", () => {
    const deps = { snapshot: prefs.getDefaults() };
    for (const h of [8, 24, 72]) assert.equal(updateRegistry.tamagotchiFaintAfterHours(h, deps).status, "ok");
    for (const h of [0, 12, "24", null]) assert.equal(updateRegistry.tamagotchiFaintAfterHours(h, deps).status, "error");
    assert.equal(updateRegistry.tamagotchiTokensPerBelly(100000, deps).status, "ok");
    assert.equal(updateRegistry.tamagotchiTokensPerBelly(123, deps).status, "error");
    assert.equal(updateRegistry.tamagotchiEnabled(true, deps).status, "ok");
    assert.equal(updateRegistry.tamagotchiEnabled("yes", deps).status, "error");
  });

  it("the tab offers exactly the validated choices", () => {
    const tab = loadTab();
    assert.deepEqual(Array.from(tab.__test.FAINT_HOUR_OPTIONS, (o) => o.value), prefs.SCHEMA.tamagotchiFaintAfterHours.enum);
    assert.deepEqual(Array.from(tab.__test.TOKENS_PER_BELLY_OPTIONS), prefs.SCHEMA.tamagotchiTokensPerBelly.enum);
  });
});

describe("tamagotchi store configure", () => {
  it("emits when the decay rate changes and keeps the current fullness", () => {
    let t = 1_000_000;
    const store = createTamagotchiStore({ now: () => t, persistPath: null, enabled: true });
    store.feedCodexUsage("s", { total: 0, last: 0 });
    const seen = [];
    store.onChange((s) => seen.push(s));
    const before = store.snapshot().fullness;
    assert.equal(store.configure({ faintAfterMs: 8 * 3600 * 1000 }), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].faintAfterMs, 8 * 3600 * 1000);
    assert.equal(store.snapshot().fullness, before);
    assert.equal(store.configure({ faintAfterMs: 8 * 3600 * 1000 }), false, "no-op change");
    assert.equal(seen.length, 1);
    store.dispose();
  });
});

describe("tamagotchi Settings tab", () => {
  it("builds stats only while enabled", () => {
    const { buildStatsModel } = loadTab().__test;
    assert.equal(buildStatsModel(null), null);
    assert.equal(buildStatsModel({ enabled: false, stage: "full" }), null);
    const model = buildStatsModel({
      enabled: true, stage: "hungry", fullness: 0.2, faintsAt: 2000 + 5000, faintAfterMs: 10000,
      ageDays: 3, bestAgeDays: 7, faintCount: 2, tokensEatenTotal: 1234567,
    }, 2000);
    // The tab runs in its own vm realm: compare plain JSON.
    const byKey = JSON.parse(JSON.stringify(Object.fromEntries(model.map(([k, v]) => [k, v]))));
    assert.deepEqual(byKey.tamagotchiStatStage, { key: "tamagotchiStageHungry" });
    assert.equal(byKey.tamagotchiStatFullness, "50%");
    assert.deepEqual(byKey.tamagotchiStatAge, { days: 3 });
    assert.deepEqual(byKey.tamagotchiStatBestAge, { days: 7 });
    assert.equal(byKey.tamagotchiStatFaints, "2");
    assert.equal(byKey.tamagotchiStatTokens, "1.2M");
  });

  it("every tab string exists in all seven locales", () => {
    const strings = loadI18n();
    const source = fs.readFileSync(path.join(SRC, "settings-tab-tamagotchi.js"), "utf8");
    const keys = new Set(Array.from(source.matchAll(/"((?:tamagotchi|rowTamagotchi)[A-Za-z0-9]+)"/g), (m) => m[1]));
    for (const prefKey of Object.keys(prefs.SCHEMA)) keys.delete(prefKey);
    keys.add("sidebarTamagotchi");
    assert.ok(keys.size > 20);
    for (const lang of ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]) {
      for (const key of keys) {
        assert.equal(typeof strings[lang][key], "string", `${lang}.${key}`);
      }
      assert.match(strings[lang].tamagotchiDays, /\{n\}/, `${lang}.tamagotchiDays placeholder`);
    }
  });

  it("is registered as a sidebar tab with its script and icon", () => {
    const html = fs.readFileSync(path.join(SRC, "settings.html"), "utf8");
    const tabAt = html.indexOf('<script src="settings-tab-tamagotchi.js"></script>');
    assert.ok(tabAt > 0 && tabAt < html.indexOf('<script src="settings-renderer.js"></script>'));
    const renderer = fs.readFileSync(path.join(SRC, "settings-renderer.js"), "utf8");
    assert.ok(renderer.includes('{ id: "tamagotchi", labelKey: "sidebarTamagotchi", available: true }'));
    assert.ok(renderer.includes("globalThis.ClawdSettingsTabTamagotchi.init(core)"));
    const icons = fs.readFileSync(path.join(SRC, "settings-icons.js"), "utf8");
    assert.match(icons, /\n  tamagotchi:\n/);
  });

  it("main wires prefs into the store and exposes it to Settings IPC", () => {
    const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
    assert.ok(main.includes('_settingsController.subscribeKey("tamagotchiFaintAfterHours", () => {'));
    assert.ok(main.includes('_settingsController.subscribeKey("tamagotchiTokensPerBelly", () => {'));
    assert.ok(main.includes("...getTamagotchiConfigFromPrefs(),"));
    assert.ok(main.includes("  tamagotchi: _tamagotchi,"));
    assert.ok(main.includes('broadcastSettingsWindow("settings:tamagotchi-changed", snapshot)'));
  });
});
