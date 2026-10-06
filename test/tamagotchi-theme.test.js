"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(ROOT, "src"));
const { validateTheme, TAMAGOTCHI_OPTIONAL_STATES, VISUAL_FALLBACK_STATES } = require("../src/theme-schema");
const { sanitizeSvg } = require("../src/theme-sanitizer");
const { buildStateBindings, resolveVisualBinding } = require("../src/state-visual-resolver");
const { resolveTamagotchiRestVisual } = require("../src/tamagotchi-mood");

const MOOD_FILES = ["clawd-hungry.svg", "clawd-fainted.svg"];

function rawTheme(id) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "themes", id, "theme.json"), "utf8"));
}

function moodVisual(theme, mood, state) {
  const bindings = buildStateBindings(JSON.parse(JSON.stringify(theme)));
  return resolveTamagotchiRestVisual({
    mood,
    state,
    stateBindings: bindings,
    resolveBinding: (s) => resolveVisualBinding(s, bindings, { pickStateFile: (files) => files[0] }),
  });
}

describe("tamagotchi theme schema", () => {
  it("declares hungry/fainted as optional fallback-capable states", () => {
    assert.deepEqual(TAMAGOTCHI_OPTIONAL_STATES, ["hungry", "fainted"]);
    for (const state of TAMAGOTCHI_OPTIONAL_STATES) assert.ok(VISUAL_FALLBACK_STATES.has(state));
  });

  it("themes may omit the mood states entirely", () => {
    const cfg = rawTheme("calico");
    assert.equal(cfg.states.hungry, undefined);
    assert.deepEqual(validateTheme(cfg), []);
  });

  it("rejects a declared but empty mood state", () => {
    const cfg = rawTheme("calico");
    cfg.states.hungry = [];
    assert.ok(validateTheme(cfg).some((e) => e.includes("states.hungry must be a non-empty array")));
  });

  it("accepts fallbackTo on mood states and resolves through it", () => {
    const cfg = rawTheme("calico");
    cfg.states.fainted = { fallbackTo: "collapsing" };
    cfg.states.hungry = { fallbackTo: "dozing" };
    assert.deepEqual(validateTheme(cfg), []);
    const theme = themeLoader.loadTheme("calico");
    const patched = JSON.parse(JSON.stringify(theme));
    patched._stateBindings.fainted = { files: [], fallbackTo: "collapsing" };
    patched._stateBindings.hungry = { files: [], fallbackTo: "dozing" };
    assert.equal(moodVisual(patched, "fainted", "idle"), theme.states.collapsing[0]);
    assert.equal(moodVisual(patched, "hungry", "idle"), theme.states.dozing[0]);
  });
});

describe("tamagotchi built-in theme art", () => {
  it("Clawd binds its generated hungry/fainted art", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    assert.deepEqual(theme.states.hungry, ["clawd-hungry.svg"]);
    assert.deepEqual(theme.states.fainted, ["clawd-fainted.svg"]);
    assert.equal(moodVisual(theme, "hungry", "idle"), "clawd-hungry.svg");
    assert.equal(moodVisual(theme, "fainted", "sleeping"), "clawd-fainted.svg");
  });

  it("the fainted sprite uses the low sleeping hitbox", () => {
    const raw = rawTheme("clawd");
    assert.ok(raw.sleepingHitboxFiles.includes("clawd-fainted.svg"));
    assert.ok(!raw.sleepingHitboxFiles.includes("clawd-hungry.svg"));
  });

  it("Calico and Cloudling fall back to existing art", () => {
    for (const id of ["calico", "cloudling"]) {
      const theme = themeLoader.loadTheme(id);
      assert.equal(moodVisual(theme, "hungry", "idle"), null, `${id} hungry keeps idle`);
      const sleeping = resolveVisualBinding("sleeping", buildStateBindings(JSON.parse(JSON.stringify(theme))), {
        pickStateFile: (files) => files[0],
      });
      assert.equal(moodVisual(theme, "fainted", "idle"), sleeping, `${id} fainted uses sleeping art`);
    }
  });

  for (const file of MOOD_FILES) {
    it(`${file} matches the Clawd sprite conventions and is sanitizer-stable`, () => {
      const source = fs.readFileSync(path.join(ROOT, "assets", "svg", file), "utf8");
      assert.match(source, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-15 -25 45 45" width="500" height="500">/);
      assert.match(source, /fill="#DE886D"/, "Clawd body colour");
      assert.doesNotMatch(source, /<script|on[a-z]+=|javascript:|<animate|<set\b|xlink:href="(?!#)|href="(?!#)/i);
      assert.equal(sanitizeSvg(source), source, "the user-theme sanitizer must not need to change it");
    });
  }

  it("hungry exposes the accessory follow anchor, fainted hides accessories", () => {
    const raw = rawTheme("clawd");
    const hungry = fs.readFileSync(path.join(ROOT, "assets", "svg", "clawd-hungry.svg"), "utf8");
    assert.match(hungry, /<g id="accessory-anchor"/);
    const head = raw.customization.accessories.files;
    const mouth = raw.customization.mouthAccessories.files;
    assert.equal(head["clawd-hungry.svg"].followTarget.id, "accessory-anchor");
    assert.equal(mouth["clawd-hungry.svg"].followTarget.id, "accessory-anchor");
    assert.deepEqual(head["clawd-fainted.svg"], { visibility: "hidden" });
    assert.deepEqual(mouth["clawd-fainted.svg"], { visibility: "hidden" });
  });
});
