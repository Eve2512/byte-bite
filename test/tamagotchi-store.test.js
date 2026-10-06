"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createTamagotchiStore } = require("../src/tamagotchi-store");
const {
  extractClaudeTokenMealsFromEntries,
  extractCodexTokenUsage,
  normalizeTokenMeals,
} = require("../hooks/context-usage");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tempPersistPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clawd-tamagotchi-")), "tamagotchi.json");
}

function makeStore(clock, extra = {}) {
  return createTamagotchiStore({ persistPath: null, now: () => clock.t, enabled: true, ...extra });
}

describe("tamagotchi store", () => {
  it("is disabled by default and ignores food while off", () => {
    const clock = { t: 1000 };
    const store = createTamagotchiStore({ persistPath: null, now: () => clock.t });
    assert.strictEqual(store.isEnabled(), false);
    assert.strictEqual(store.feedClaudeMeals([{ id: "msg_1", tokens: 5000 }]), 0);
    assert.strictEqual(store.feedCodexUsage("s1", { total: 5000, last: 5000 }), 0);
    assert.strictEqual(store.snapshot().stage, null);
  });

  it("does not write a persist file while disabled", () => {
    const persistPath = tempPersistPath();
    const store = createTamagotchiStore({ persistPath });
    store.feedClaudeMeals([{ id: "msg_1", tokens: 5000 }]);
    store.flush();
    assert.strictEqual(fs.existsSync(persistPath), false);
  });

  it("hatches at 60% and drains linearly to a faint after 24h of a full belly", () => {
    const clock = { t: 0 };
    const store = makeStore(clock);
    assert.ok(Math.abs(store.snapshot().fullness - 0.6) < 1e-9);
    store.feedClaudeMeals([{ id: "msg_1", tokens: 40000 }]); // +0.4 -> full
    assert.strictEqual(store.snapshot().fullness, 1);
    assert.strictEqual(store.snapshot().stage, "full");
    clock.t = 12 * HOUR;
    assert.ok(Math.abs(store.snapshot().fullness - 0.5) < 1e-9);
    assert.strictEqual(store.snapshot().stage, "content");
    clock.t = 20 * HOUR;
    assert.strictEqual(store.snapshot().stage, "hungry");
    clock.t = 23 * HOUR;
    assert.strictEqual(store.snapshot().stage, "weak");
    clock.t = 25 * HOUR;
    const snap = store.snapshot();
    assert.strictEqual(snap.stage, "fainted");
    assert.strictEqual(snap.alive, false);
    assert.strictEqual(snap.faintedAt, DAY);
    assert.strictEqual(snap.faintCount, 1);
    assert.strictEqual(snap.faintsAt, null);
  });

  it("resets the age streak on faint and revives on the next meal", () => {
    const clock = { t: 0 };
    const store = makeStore(clock, { faintAfterMs: 10 * DAY });
    clock.t = 3 * DAY;
    assert.strictEqual(store.snapshot().ageDays, 3);
    clock.t = 7 * DAY; // 0.6 * 10d = 6d -> fainted at day 6
    assert.strictEqual(store.snapshot().stage, "fainted");
    assert.strictEqual(store.snapshot().ageDays, 0);
    assert.strictEqual(store.snapshot().bestAgeDays, 6);
    store.feedClaudeMeals([{ id: "msg_2", tokens: 10000 }]);
    const snap = store.snapshot();
    assert.strictEqual(snap.alive, true);
    assert.strictEqual(snap.ageMs, 0);
    assert.ok(Math.abs(snap.fullness - 0.1) < 1e-9);
    assert.strictEqual(snap.bestAgeDays, 6);
  });

  it("de-duplicates Claude meals by id and credits only a larger re-sighting", () => {
    const clock = { t: 0 };
    const store = makeStore(clock);
    assert.strictEqual(store.feedClaudeMeals([{ id: "msg_a", tokens: 1000 }]), 1000);
    assert.strictEqual(store.feedClaudeMeals([{ id: "msg_a", tokens: 1000 }]), 0);
    assert.strictEqual(store.feedClaudeMeals([{ id: "msg_a", tokens: 1500 }]), 500);
    // Same id from a different profile scope is a different message.
    assert.strictEqual(store.feedClaudeMeals([{ id: "msg_a", tokens: 1500 }], "remote:box"), 1500);
    assert.strictEqual(store.snapshot().tokensEatenTotal, 3000);
  });

  it("feeds Codex on running-total deltas and treats a repeat as zero calories", () => {
    const clock = { t: 0 };
    const store = makeStore(clock);
    // First sighting (e.g. after restart): only the last request counts.
    assert.strictEqual(store.feedCodexUsage("s1", { total: 50000, last: 2000 }), 2000);
    assert.strictEqual(store.feedCodexUsage("s1", { total: 50000, last: 2000 }), 0);
    assert.strictEqual(store.feedCodexUsage("s1", { total: 53000, last: 3000 }), 3000);
    // A running total that goes backwards rebases instead of feeding a negative.
    assert.strictEqual(store.feedCodexUsage("s1", { total: 1000, last: 1000 }), 1000);
    assert.strictEqual(store.snapshot().tokensEatenTotal, 6000);
  });

  it("freezes the clock while disabled", () => {
    const clock = { t: 0 };
    const store = makeStore(clock);
    clock.t = 6 * HOUR;
    store.setEnabled(false);
    clock.t = 30 * DAY;
    store.setEnabled(true);
    const snap = store.snapshot();
    assert.strictEqual(snap.alive, true);
    assert.ok(Math.abs(snap.fullness - 0.35) < 1e-9);
    assert.strictEqual(Math.round(snap.ageMs / HOUR), 6);
  });

  it("survives a restart and keeps decaying on wall-clock time while closed", () => {
    const persistPath = tempPersistPath();
    const clock = { t: 0 };
    const a = createTamagotchiStore({ persistPath, now: () => clock.t, enabled: true });
    a.feedClaudeMeals([{ id: "msg_x", tokens: 40000 }]);
    a.flush();
    clock.t = 6 * HOUR;
    const b = createTamagotchiStore({ persistPath, now: () => clock.t, enabled: true });
    assert.ok(Math.abs(b.snapshot().fullness - 0.75) < 1e-9);
    // Seen ids persisted too: the same tail re-reported after restart is free.
    assert.strictEqual(b.feedClaudeMeals([{ id: "msg_x", tokens: 40000 }]), 0);
    clock.t = 3 * DAY;
    const c = createTamagotchiStore({ persistPath, now: () => clock.t, enabled: true });
    assert.strictEqual(c.snapshot().stage, "fainted");
    assert.strictEqual(c.snapshot().faintedAt, DAY);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("notifies listeners on meals and on a stage change found by tick()", () => {
    const clock = { t: 0 };
    const store = makeStore(clock);
    const stages = [];
    store.onChange((snap) => stages.push(snap.stage));
    store.tick();
    store.feedClaudeMeals([{ id: "m", tokens: 40000 }]);
    clock.t = 2 * DAY;
    store.tick();
    store.tick();
    assert.deepStrictEqual(stages, ["content", "full", "fainted"]);
  });
});

describe("tamagotchi meal extraction", () => {
  it("keys Claude meals by message id, takes the max, and skips cache reads", () => {
    const usage = (output) => ({
      input_tokens: 10,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 90000,
      output_tokens: output,
    });
    const entries = [
      { type: "user", message: { content: "hi" } },
      { type: "assistant", sessionId: "s", message: { id: "msg_1", usage: usage(5) } },
      { type: "assistant", sessionId: "s", message: { id: "msg_1", usage: usage(300) } },
      { type: "assistant", sessionId: "s", isApiErrorMessage: true, message: { id: "msg_err", usage: usage(1) } },
      { type: "assistant", sessionId: "other", message: { id: "msg_other", usage: usage(1) } },
      { type: "assistant", sessionId: "s", message: { usage: usage(1) } },
      { type: "assistant", sessionId: "s", message: { id: "msg_2", usage: usage(40) } },
    ];
    assert.deepStrictEqual(extractClaudeTokenMealsFromEntries(entries, "s"), [
      { id: "msg_1", tokens: 510 },
      { id: "msg_2", tokens: 250 },
    ]);
  });

  it("re-validates meals at the trust boundary", () => {
    assert.deepStrictEqual(normalizeTokenMeals([
      { id: "msg_ok", tokens: 12.7 },
      { id: "bad id with spaces", tokens: 5 },
      { id: "msg_neg", tokens: -1 },
      { id: "msg_huge", tokens: 1e12 },
      null,
    ]), [
      { id: "msg_ok", tokens: 12 },
      { id: "msg_huge", tokens: 2000000 },
    ]);
    assert.deepStrictEqual(normalizeTokenMeals("nope"), []);
  });

  it("computes Codex fresh tokens excluding cached input", () => {
    assert.deepStrictEqual(extractCodexTokenUsage({
      info: {
        total_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500 },
        last_token_usage: { input_tokens: 3000, cached_input_tokens: 2500, output_tokens: 100 },
      },
    }), { total: 2500, last: 600 });
    assert.strictEqual(extractCodexTokenUsage({ info: null }), null);
  });
});

describe("tamagotchi ipc", () => {
  const { registerTamagotchiIpc } = require("../src/tamagotchi-ipc");

  function fakeIpcMain() {
    const handlers = new Map();
    return {
      handlers,
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: (channel) => handlers.delete(channel),
    };
  }

  it("serves the snapshot on request and pushes every change to the pet renderer", () => {
    const clock = { t: 0 };
    const store = createTamagotchiStore({ persistPath: null, now: () => clock.t });
    const ipcMain = fakeIpcMain();
    const sent = [];
    const ipc = registerTamagotchiIpc({
      ipcMain,
      store,
      sendToRenderer: (channel, snapshot) => sent.push([channel, snapshot]),
    });
    assert.strictEqual(ipcMain.handlers.get("tamagotchi:get-snapshot")().enabled, false);

    store.setEnabled(true);
    store.feedClaudeMeals([{ id: "m1", tokens: 10000 }]);
    assert.deepStrictEqual(sent.map(([channel]) => channel), ["tamagotchi:snapshot", "tamagotchi:snapshot"]);
    const last = sent[sent.length - 1][1];
    assert.strictEqual(last.enabled, true);
    assert.ok(Math.abs(last.fullness - 0.7) < 1e-9);
    assert.strictEqual(last.faintAfterMs, DAY);
    assert.strictEqual(last.faintsAt, 0.7 * DAY);

    ipc.resend();
    assert.strictEqual(sent.length, 3);

    ipc.dispose();
    store.feedClaudeMeals([{ id: "m2", tokens: 10000 }]);
    assert.strictEqual(sent.length, 3);
    assert.strictEqual(ipcMain.handlers.has("tamagotchi:get-snapshot"), false);
  });

  it("requires its dependencies", () => {
    assert.throws(() => registerTamagotchiIpc({}), /requires ipcMain/);
  });
});
