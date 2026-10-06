"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

const {
  moodFromSnapshot,
  resolveTamagotchiRestVisual,
} = require("../src/tamagotchi-mood");
const { buildStateBindings, resolveVisualBinding } = require("../src/state-visual-resolver");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function themeWithMoodArt() {
  const theme = cloneTheme(_defaultTheme);
  theme.states.hungry = ["mood-hungry.svg"];
  theme.states.fainted = ["mood-fainted.svg"];
  delete theme._stateBindings;
  return theme;
}

function themeWithoutMoodArt() {
  const theme = cloneTheme(_defaultTheme);
  delete theme.states.hungry;
  delete theme.states.fainted;
  delete theme._stateBindings;
  return theme;
}

function resolverFor(theme) {
  const bindings = buildStateBindings(cloneTheme(theme));
  return {
    bindings,
    resolve: (state) => resolveVisualBinding(state, bindings, { pickStateFile: (files) => files[0] }),
  };
}

describe("tamagotchi moodFromSnapshot", () => {
  it("is null when the feature is disabled or there is no pet", () => {
    assert.equal(moodFromSnapshot(null), null);
    assert.equal(moodFromSnapshot({ enabled: false, stage: "fainted" }), null);
    assert.equal(moodFromSnapshot({ enabled: true, stage: null }), null);
  });

  it("maps stages to moods", () => {
    assert.equal(moodFromSnapshot({ enabled: true, stage: "full" }), null);
    assert.equal(moodFromSnapshot({ enabled: true, stage: "content" }), null);
    assert.equal(moodFromSnapshot({ enabled: true, stage: "hungry" }), "hungry");
    assert.equal(moodFromSnapshot({ enabled: true, stage: "weak" }), "hungry");
    assert.equal(moodFromSnapshot({ enabled: true, stage: "fainted" }), "fainted");
  });
});

describe("tamagotchi resolveTamagotchiRestVisual precedence", () => {
  const { bindings, resolve } = resolverFor(themeWithMoodArt());
  const base = { stateBindings: bindings, resolveBinding: resolve };

  it("returns null with no mood (disabled = unchanged)", () => {
    for (const state of ["idle", "sleeping", "working"]) {
      assert.equal(resolveTamagotchiRestVisual({ ...base, mood: null, state }), null);
    }
  });

  it("activity always beats hunger and fainting", () => {
    const activity = [
      "thinking", "working", "juggling", "notification", "attention", "error",
      "sweeping", "carrying", "roam", "dizzy", "mini-idle", "mini-alert", "mini-working",
    ];
    for (const mood of ["hungry", "fainted"]) {
      for (const state of activity) {
        assert.equal(resolveTamagotchiRestVisual({ ...base, mood, state }), null, `${mood}/${state}`);
      }
    }
  });

  it("hungry only changes idle; the sleep sequence keeps its art", () => {
    assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "hungry", state: "idle" }), "mood-hungry.svg");
    for (const state of ["yawning", "dozing", "collapsing", "sleeping", "waking"]) {
      assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "hungry", state }), null, state);
    }
  });

  it("fainted changes idle and the settled sleep states", () => {
    for (const state of ["idle", "collapsing", "sleeping", "waking"]) {
      assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "fainted", state }), "mood-fainted.svg", state);
    }
    assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "fainted", state: "yawning" }), null);
  });

  it("never substitutes an eye-tracked non-idle state", () => {
    assert.equal(resolveTamagotchiRestVisual({
      ...base, mood: "fainted", state: "sleeping", eyeTrackedStates: ["idle", "sleeping"],
    }), null);
    assert.equal(resolveTamagotchiRestVisual({
      ...base, mood: "fainted", state: "idle", eyeTrackedStates: ["idle"],
    }), "mood-fainted.svg");
  });

  it("DND, mini mode and Settings previews win over the mood", () => {
    for (const flag of ["doNotDisturb", "miniMode", "settingsPreview"]) {
      assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "fainted", state: "sleeping", [flag]: true }), null, flag);
      assert.equal(resolveTamagotchiRestVisual({ ...base, mood: "hungry", state: "idle", [flag]: true }), null, flag);
    }
  });

  it("falls back when the theme has no mood art", () => {
    const fallback = resolverFor(themeWithoutMoodArt());
    const opts = { stateBindings: fallback.bindings, resolveBinding: fallback.resolve };
    assert.equal(resolveTamagotchiRestVisual({ ...opts, mood: "hungry", state: "idle" }), null);
    assert.equal(resolveTamagotchiRestVisual({ ...opts, mood: "fainted", state: "idle" }), "clawd-sleeping.svg");
  });
});

function makeStateCtx(theme, mood) {
  const sent = [];
  const ctx = {
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode: false,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    mouseStillSince: Date.now(),
    playSound() {},
    sendToRenderer(channel, ...args) { sent.push([channel, ...args]); },
    syncHitWin() {},
    sendToHitWin() {},
    miniPeekIn() {},
    miniPeekOut() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    pendingPermissions: [],
    resolvePermissionEntry() {},
    t: (k) => k,
    focusTerminalWindow() {},
  };
  if (mood !== undefined) ctx.getTamagotchiMood = () => mood.value;
  return { ctx, sent };
}

describe("state.js tamagotchi integration", () => {
  let api;
  afterEach(() => {
    if (api) api.cleanup();
    api = null;
  });

  it("without the ctx hook idle and sleeping stay byte-identical", () => {
    const { ctx } = makeStateCtx(themeWithMoodArt());
    api = require("../src/state")(ctx);
    api.applyState("idle", api.getSvgOverride("idle"));
    assert.equal(api.getCurrentSvg(), "clawd-idle-follow.svg");
    api.applyState("sleeping");
    assert.equal(api.getCurrentSvg(), "clawd-sleeping.svg");
  });

  it("a null mood (feature off) keeps the user's idle choice and sleep art", () => {
    const mood = { value: null };
    const { ctx } = makeStateCtx(themeWithMoodArt(), mood);
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    api = require("../src/state")(ctx);
    api.applyState("idle", api.getSvgOverride("idle"));
    assert.equal(api.getCurrentSvg(), "clawd-idle-reading.svg");
    api.applyState("sleeping");
    assert.equal(api.getCurrentSvg(), "clawd-sleeping.svg");
  });

  it("hungry replaces the resting idle sprite, even a user-chosen one", () => {
    const mood = { value: "hungry" };
    const { ctx, sent } = makeStateCtx(themeWithMoodArt(), mood);
    ctx.getIdleVisualChoice = () => "clawd-idle-reading.svg";
    api = require("../src/state")(ctx);
    api.applyState("idle", api.getSvgOverride("idle"));
    assert.equal(api.getCurrentSvg(), "mood-hungry.svg");
    assert.deepEqual(sent.filter(([ch]) => ch === "state-change").at(-1), ["state-change", "idle", "mood-hungry.svg"]);
    assert.equal(api.getCurrentState(), "idle", "logical state is untouched");
  });

  it("activity beats hunger: working/thinking/notification keep their art", () => {
    const mood = { value: "fainted" };
    const { ctx } = makeStateCtx(themeWithMoodArt(), mood);
    api = require("../src/state")(ctx);
    for (const state of ["working", "thinking", "notification", "attention", "error"]) {
      api.applyState(state, api.getSvgOverride(state));
      assert.notEqual(api.getCurrentSvg(), "mood-fainted.svg", state);
      assert.equal(api.getCurrentState(), state);
    }
  });

  it("fainted shows on sleeping, but DND keeps its own sleep art", () => {
    const mood = { value: "fainted" };
    const { ctx } = makeStateCtx(themeWithMoodArt(), mood);
    api = require("../src/state")(ctx);
    api.applyState("sleeping");
    assert.equal(api.getCurrentSvg(), "mood-fainted.svg");
    ctx.doNotDisturb = true;
    api.applyState("sleeping");
    assert.equal(api.getCurrentSvg(), "clawd-sleeping.svg");
  });

  it("Settings previews of idle show the real idle slot", () => {
    const mood = { value: "hungry" };
    const { ctx } = makeStateCtx(themeWithMoodArt(), mood);
    api = require("../src/state")(ctx);
    api.applyState("idle", api.getSvgOverride("idle"), { settingsPreview: true });
    assert.equal(api.getCurrentSvg(), "clawd-idle-follow.svg");
  });

  it("mini mode keeps mini art", () => {
    const mood = { value: "fainted" };
    const { ctx } = makeStateCtx(themeWithMoodArt(), mood);
    ctx.miniMode = true;
    api = require("../src/state")(ctx);
    api.applyState("mini-idle");
    assert.equal(api.getCurrentSvg(), "clawd-mini-idle.svg");
  });
});

function loadTickWithScreen(getCursorScreenPoint) {
  const electronPath = require.resolve("electron");
  const tickPath = require.resolve("../src/tick");
  const previousElectron = require.cache[electronPath] || null;
  const previousTick = require.cache[tickPath] || null;
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { screen: { getCursorScreenPoint } },
  };
  delete require.cache[tickPath];
  return {
    initTick: require("../src/tick"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousTick) require.cache[tickPath] = previousTick;
      else delete require.cache[tickPath];
    },
  };
}

function makeTickCtx(theme, statesSeen, rendererCalls) {
  return {
    theme,
    win: {
      setIgnoreMouseEvents() {},
      isDestroyed() { return false; },
      isVisible() { return true; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 120 }; },
    },
    currentState: "idle",
    currentSvg: theme.states.idle[0],
    idlePaused: false,
    miniMode: false,
    miniTransitioning: false,
    dragLocked: false,
    menuOpen: false,
    isAnimating: false,
    mouseOverPet: false,
    miniPeeked: false,
    forceEyeResend: false,
    forceEyeResendBoostUntil: 0,
    startupRecoveryActive: false,
    sendToRenderer(channel, ...args) { rendererCalls.push([channel, ...args]); },
    sendToHitWin() {},
    getHitRectScreen() { return { left: 0, top: 0, right: 120, bottom: 120 }; },
    getObjRect() { return { x: 20, y: 20, w: 60, h: 60 }; },
    setState(state) { statesSeen.push(state); this.currentState = state; },
    applyState(state) { statesSeen.push(state); this.currentState = state; },
    miniPeekIn() {},
    miniPeekOut() {},
  };
}

describe("tick.js tamagotchi integration", () => {
  let loader;
  let tickApi;
  let statesSeen;
  let rendererCalls;
  let cursor;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
    rendererCalls = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    loader.restore();
    mock.timers.reset();
    tickApi = null;
  });

  function sleepTheme() {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "full" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;
    return theme;
  }

  it("a fainted pet skips yawning and settles straight into sleeping", () => {
    const ctx = makeTickCtx(sleepTheme(), statesSeen, rendererCalls);
    ctx.getTamagotchiMood = () => "fainted";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    for (let i = 0; i < 9; i++) mock.timers.tick(50);
    assert.deepEqual(statesSeen, ["sleeping"]);
  });

  it("hungry (or no mood) keeps the normal yawning entry path", () => {
    for (const mood of ["hungry", null]) {
      statesSeen.length = 0;
      const ctx = makeTickCtx(sleepTheme(), statesSeen, rendererCalls);
      ctx.getTamagotchiMood = () => mood;
      tickApi = loader.initTick(ctx);
      tickApi.startMainTick();
      for (let i = 0; i < 9; i++) mock.timers.tick(50);
      assert.deepEqual(statesSeen, ["yawning"], String(mood));
      tickApi.cleanup();
      tickApi = null;
    }
  });

  it("a fainted pet plays no idle-look animations", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = [{ file: "clawd-idle-look.svg", duration: 500 }];
    const ctx = makeTickCtx(theme, statesSeen, rendererCalls);
    ctx.getTamagotchiMood = () => "fainted";
    ctx.getTamagotchiRestVisual = () => "mood-fainted.svg";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    for (let i = 0; i < 20; i++) mock.timers.tick(50);
    assert.equal(rendererCalls.filter(([ch]) => ch === "state-change").length, 0);
  });

  it("idle-look animations return to the hungry rest sprite", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = [{ file: "clawd-idle-look.svg", duration: 500 }];
    const ctx = makeTickCtx(theme, statesSeen, rendererCalls);
    let generation = 0;
    ctx.sendToRenderer = (channel, ...args) => {
      rendererCalls.push([channel, ...args]);
      if (channel !== "state-change") return undefined;
      const request = { visualGeneration: ++generation };
      const options = args[2];
      if (options && typeof options.onLogicalSettlement === "function") {
        options.onLogicalSettlement({ status: "committed", visualGeneration: request.visualGeneration });
      }
      return request;
    };
    ctx.getTamagotchiMood = () => "hungry";
    ctx.getTamagotchiRestVisual = (state) => (state === "idle" ? "mood-hungry.svg" : null);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    const idleChanges = () => rendererCalls.filter(([ch, state]) => ch === "state-change" && state === "idle");
    for (let i = 0; i < 20 && idleChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);
    const idle = idleChanges();
    assert.deepEqual(idle.map(([, , svg]) => svg), ["clawd-idle-look.svg", "mood-hungry.svg"]);
  });
});

describe("main.js tamagotchi mood wiring", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  function sectionBetween(startMarker, endMarker) {
    const start = mainSource.indexOf(startMarker);
    const end = mainSource.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, startMarker);
    assert.notEqual(end, -1, endMarker);
    return mainSource.slice(start, end);
  }

  it("exposes the cached mood to the state and tick ctxs", () => {
    const stateCtx = sectionBetween("const _stateCtx = {", 'const _state = require("./state")');
    const tickCtx = sectionBetween("const _tickCtx = {", 'const _tick = require("./tick")');
    assert.ok(stateCtx.includes("  getTamagotchiMood,"));
    assert.ok(tickCtx.includes("  getTamagotchiMood,"));
    assert.ok(tickCtx.includes("getTamagotchiRestVisual: (state) => _state.getTamagotchiRestVisual(state)"));
  });

  it("repaints a resting pet when the store's mood changes", () => {
    assert.ok(mainSource.includes("_tamagotchi.onChange(syncTamagotchiMood);"));
    assert.match(mainSource, /function refreshTamagotchiRestVisual\(\) \{\s*if \(_mini\.getMiniMode\(\) \|\| doNotDisturb\) return;/);
  });
});
