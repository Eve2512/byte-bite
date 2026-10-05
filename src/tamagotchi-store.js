"use strict";

// ── Tamagotchi hunger store ──
//
// The pet eats the fresh tokens your agents consume (see
// hooks/context-usage.js for what counts as "fresh"). Fullness drains
// linearly on wall-clock time - including while the app is closed - so a
// full belly empties in `faintAfterMs`. At zero the pet faints: its age
// streak resets and it stays down until the next meal revives it.
//
// Nothing is derived from a running timer: every read settles the timeline
// from timestamps, so a laptop that slept through the faint moment still
// records the faint at the moment it actually happened.
//
// Opt-in: while disabled the store neither feeds nor persists. Disabling
// freezes the clock and re-enabling resumes it, so turning the feature off
// for a holiday does not come back to a fainted pet.
//
// Persisted to ~/.clawd/tamagotchi.json. Only counters, timestamps, opaque
// Claude message ids (for de-duplication) and per-session Codex running
// totals are stored - no content, titles or paths.

const fs = require("fs");
const path = require("path");
const os = require("os");

const { readJsonFile } = require("../hooks/json-utils");

const PERSIST_VERSION = 1;
const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".clawd", "tamagotchi.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAINT_AFTER_MS = DAY_MS;
const DEFAULT_TOKENS_PER_FULL_BELLY = 100000;
const INITIAL_FULLNESS = 0.6;
const PERSIST_DEBOUNCE_MS = 1000;
const MAX_SEEN_MEAL_IDS = 1000;
const MAX_CODEX_BASELINES = 200;
const MAX_MEAL_TOKENS = 2000000;

// Stage thresholds on fullness (0..1). "fainted" is a separate flag, not a
// threshold, because a fainted pet stays fainted until fed.
const STAGES = [
  { stage: "full", min: 0.75 },
  { stage: "content", min: 0.35 },
  { stage: "hungry", min: 0.1 },
  { stage: "weak", min: 0 },
];

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function freshPet(nowMs) {
  return {
    alive: true,
    fullness: INITIAL_FULLNESS,
    // Timestamp the stored fullness was valid at; decay runs from here.
    fullnessAt: nowMs,
    bornAt: nowMs,
    faintedAt: null,
    lastMealAt: null,
    faintCount: 0,
    bestAgeMs: 0,
    tokensEatenTotal: 0,
  };
}

function createTamagotchiStore(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  // options.persistPath: undefined -> default path, null -> in-memory only.
  const persistPath = options.persistPath === undefined ? DEFAULT_PERSIST_PATH : options.persistPath;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  let faintAfterMs = DEFAULT_FAINT_AFTER_MS;
  let tokensPerFullBelly = DEFAULT_TOKENS_PER_FULL_BELLY;
  let enabled = false;
  let pausedAt = null;
  let pet = null;
  // Claude message id -> tokens already credited (insertion-ordered for LRU).
  const seenMeals = new Map();
  // Codex session key -> last seen running fresh-token total.
  const codexBaselines = new Map();
  const listeners = new Set();
  let persistTimer = null;
  let loaded = false;

  function configure(config = {}) {
    if (config.faintAfterMs !== undefined) {
      const ms = finiteOr(config.faintAfterMs, DEFAULT_FAINT_AFTER_MS);
      if (ms > 0) {
        // Keep the current fullness: settle on the old rate, then switch.
        settle(now());
        faintAfterMs = ms;
      }
    }
    if (config.tokensPerFullBelly !== undefined) {
      const n = finiteOr(config.tokensPerFullBelly, DEFAULT_TOKENS_PER_FULL_BELLY);
      if (n > 0) tokensPerFullBelly = n;
    }
  }

  function load() {
    loaded = true;
    if (!persistPath) return;
    let raw = null;
    try {
      raw = readJsonFile(persistPath);
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "object" || Number(raw.version) !== PERSIST_VERSION) return;
    const p = raw.pet;
    if (p && typeof p === "object") {
      const t = now();
      pet = {
        alive: p.alive !== false,
        fullness: clamp01(finiteOr(p.fullness, INITIAL_FULLNESS)),
        fullnessAt: finiteOr(p.fullnessAt, t),
        bornAt: finiteOr(p.bornAt, t),
        faintedAt: Number.isFinite(p.faintedAt) ? p.faintedAt : null,
        lastMealAt: Number.isFinite(p.lastMealAt) ? p.lastMealAt : null,
        faintCount: Math.max(0, Math.floor(finiteOr(p.faintCount, 0))),
        bestAgeMs: Math.max(0, finiteOr(p.bestAgeMs, 0)),
        tokensEatenTotal: Math.max(0, finiteOr(p.tokensEatenTotal, 0)),
      };
    }
    pausedAt = Number.isFinite(raw.pausedAt) ? raw.pausedAt : null;
    if (Array.isArray(raw.seenMeals)) {
      for (const pair of raw.seenMeals.slice(-MAX_SEEN_MEAL_IDS)) {
        if (Array.isArray(pair) && typeof pair[0] === "string" && Number.isFinite(pair[1])) {
          seenMeals.set(pair[0], pair[1]);
        }
      }
    }
    if (Array.isArray(raw.codexBaselines)) {
      for (const pair of raw.codexBaselines.slice(-MAX_CODEX_BASELINES)) {
        if (Array.isArray(pair) && typeof pair[0] === "string" && Number.isFinite(pair[1])) {
          codexBaselines.set(pair[0], pair[1]);
        }
      }
    }
  }

  function persistNow() {
    if (persistTimer) {
      clearTimer(persistTimer);
      persistTimer = null;
    }
    if (!persistPath || !pet) return true;
    const body = JSON.stringify({
      version: PERSIST_VERSION,
      pet,
      pausedAt,
      seenMeals: [...seenMeals],
      codexBaselines: [...codexBaselines],
    });
    const tmpPath = `${persistPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, body, "utf8");
      fs.renameSync(tmpPath, persistPath);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      logWarn("Clawd: tamagotchi persist failed:", err && err.message);
      return false;
    }
  }

  function schedulePersist() {
    if (!persistPath || persistTimer) return;
    persistTimer = setTimer(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
    if (persistTimer && typeof persistTimer.unref === "function") persistTimer.unref();
  }

  function emit() {
    if (!listeners.size) return;
    const snap = snapshot();
    for (const fn of listeners) {
      try { fn(snap); } catch (err) { logWarn("Clawd: tamagotchi listener failed:", err && err.message); }
    }
  }

  function ensurePet(t) {
    if (!loaded) load();
    if (!pet) {
      pet = freshPet(t);
      schedulePersist();
    }
    return pet;
  }

  // Bring the stored state up to `t`: apply decay and record a faint at the
  // exact moment fullness hit zero. Returns true when the stage flag changed.
  function settle(t) {
    if (!pet || !pet.alive) return false;
    const elapsed = Math.max(0, t - pet.fullnessAt);
    const remaining = pet.fullness - elapsed / faintAfterMs;
    if (remaining > 0) {
      pet.fullness = remaining;
      pet.fullnessAt = t;
      return false;
    }
    const faintAt = pet.fullnessAt + pet.fullness * faintAfterMs;
    pet.bestAgeMs = Math.max(pet.bestAgeMs, faintAt - pet.bornAt);
    pet.alive = false;
    pet.fullness = 0;
    pet.fullnessAt = faintAt;
    pet.faintedAt = faintAt;
    pet.faintCount += 1;
    schedulePersist();
    return true;
  }

  function eat(tokens, t) {
    const amount = Math.min(MAX_MEAL_TOKENS, Math.max(0, Math.floor(finiteOr(tokens, 0))));
    if (amount <= 0) return false;
    settle(t);
    if (!pet.alive) {
      // Revival: the age streak starts over from this meal.
      pet.alive = true;
      pet.bornAt = t;
      pet.faintedAt = null;
      pet.fullness = 0;
    }
    pet.fullness = clamp01(pet.fullness + amount / tokensPerFullBelly);
    pet.fullnessAt = t;
    pet.lastMealAt = t;
    pet.tokensEatenTotal += amount;
    schedulePersist();
    return true;
  }

  function rememberSeen(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  // meals: [{ id, tokens }] from the Claude hook (already normalized).
  // `scope` namespaces ids per reporting profile (local / remote:<id>).
  function feedClaudeMeals(meals, scope = "local") {
    if (!enabled || !Array.isArray(meals) || !meals.length) return 0;
    const t = now();
    ensurePet(t);
    let total = 0;
    for (const meal of meals) {
      if (!meal || typeof meal.id !== "string") continue;
      const key = `${scope}|${meal.id}`;
      const tokens = Math.floor(finiteOr(meal.tokens, 0));
      const credited = seenMeals.has(key) ? seenMeals.get(key) : 0;
      // A later sighting of the same message may carry a larger (final)
      // output count; credit only the difference.
      if (tokens > credited) {
        total += tokens - credited;
        rememberSeen(seenMeals, key, tokens, MAX_SEEN_MEAL_IDS);
      }
    }
    if (total > 0 && eat(total, t)) emit();
    return total;
  }

  // usage: { total, last } from extractCodexTokenUsage. Feeds on the delta of
  // the running total; the first sighting of a session (no baseline, e.g.
  // after a restart) feeds only the latest request so history is not replayed.
  function feedCodexUsage(sessionKey, usage) {
    if (!enabled || typeof sessionKey !== "string" || !sessionKey) return 0;
    if (!usage || !Number.isFinite(usage.total) || usage.total < 0) return 0;
    const t = now();
    ensurePet(t);
    const baseline = codexBaselines.get(sessionKey);
    let tokens;
    if (baseline === undefined || usage.total < baseline) {
      tokens = Math.min(usage.total, Math.max(0, finiteOr(usage.last, 0)));
    } else {
      tokens = usage.total - baseline;
    }
    rememberSeen(codexBaselines, sessionKey, usage.total, MAX_CODEX_BASELINES);
    if (tokens > 0 && eat(tokens, t)) {
      emit();
    } else {
      schedulePersist();
    }
    return tokens > 0 ? tokens : 0;
  }

  function setEnabled(value) {
    const next = value === true;
    if (next === enabled) return;
    const t = now();
    enabled = next;
    ensurePet(t);
    if (!next) {
      settle(t);
      pausedAt = t;
      persistNow();
    } else {
      if (Number.isFinite(pausedAt)) {
        // Shift the timeline forward by the paused span so no decay accrues.
        const gap = Math.max(0, t - pausedAt);
        pet.fullnessAt += gap;
        pet.bornAt += gap;
        if (pet.lastMealAt !== null) pet.lastMealAt += gap;
      }
      pausedAt = null;
      schedulePersist();
    }
    emit();
  }

  function stageFor(p) {
    if (!p.alive) return "fainted";
    for (const { stage, min } of STAGES) {
      if (p.fullness >= min) return stage;
    }
    return "weak";
  }

  function snapshot() {
    const t = enabled ? now() : (Number.isFinite(pausedAt) ? pausedAt : now());
    if (!loaded) load();
    if (!pet) {
      return { enabled, stage: null, fullness: null };
    }
    // Listeners hear about a faint discovered here on the next tick().
    if (enabled) settle(t);
    const ageMs = pet.alive ? Math.max(0, t - pet.bornAt) : 0;
    return {
      enabled,
      stage: stageFor(pet),
      fullness: pet.fullness,
      alive: pet.alive,
      ageMs,
      ageDays: Math.floor(ageMs / DAY_MS),
      bestAgeDays: Math.floor(Math.max(pet.bestAgeMs, ageMs) / DAY_MS),
      faintCount: pet.faintCount,
      faintedAt: pet.faintedAt,
      lastMealAt: pet.lastMealAt,
      tokensEatenTotal: pet.tokensEatenTotal,
      // Wall-clock moment the pet will faint if not fed (null when fainted).
      faintsAt: pet.alive ? pet.fullnessAt + pet.fullness * faintAfterMs : null,
      // Lets renderers interpolate: fullness(t) = (faintsAt - t) / faintAfterMs.
      faintAfterMs,
      capturedAt: t,
    };
  }

  // Called periodically by the runtime so a faint (or stage crossing) is
  // noticed and broadcast even when no agent is reporting.
  let lastStage = null;
  function tick() {
    if (!enabled) return;
    ensurePet(now());
    settle(now());
    const stage = stageFor(pet);
    if (stage !== lastStage) {
      lastStage = stage;
      emit();
    }
  }

  function onChange(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function reset() {
    pet = freshPet(now());
    seenMeals.clear();
    codexBaselines.clear();
    pausedAt = enabled ? null : now();
    loaded = true;
    persistNow();
    emit();
  }

  function dispose() {
    if (persistTimer) persistNow();
    listeners.clear();
  }

  configure(options);
  if (options.enabled === true) setEnabled(true);

  return {
    configure,
    setEnabled,
    isEnabled: () => enabled,
    feedClaudeMeals,
    feedCodexUsage,
    snapshot,
    tick,
    onChange,
    reset,
    flush: persistNow,
    dispose,
  };
}

module.exports = {
  DEFAULT_PERSIST_PATH,
  DEFAULT_FAINT_AFTER_MS,
  DEFAULT_TOKENS_PER_FULL_BELLY,
  createTamagotchiStore,
};
