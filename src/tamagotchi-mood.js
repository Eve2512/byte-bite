"use strict";

// ── Tamagotchi mood → resting visual ──
//
// The hunger store (src/tamagotchi-store.js) reports a stage; this module
// decides how that stage changes what the pet looks like. It is deliberately
// a pure visual substitution layered on top of the existing state machine:
// logical states, priorities, timers and session snapshots are untouched.
//
// Precedence (highest first):
//   1. Real activity (thinking / working / juggling / permission /
//      notification / attention / error / sweeping / carrying / reactions /
//      roam / mini states / update visuals / Settings previews) — never
//      overridden. The pet must never hide what an agent is doing.
//   2. Do Not Disturb — DND's sleep sequence keeps its own art even when the
//      pet is hungry or fainted. DND is an explicit user choice and is the
//      more important thing to communicate.
//   3. Mini mode — unchanged; mini has its own small sprite set.
//   4. Tamagotchi mood on resting states:
//        hungry / weak → "hungry" art on idle only (a hungry pet still yawns,
//                        dozes and sleeps normally)
//        fainted       → "fainted" art on idle and the settled sleep states
//                        (collapsing / sleeping / waking); tick.js skips the
//                        yawn/doze build-up and drops straight to sleeping.
//   5. Everything else — existing behaviour.
//
// Disabled feature or a full/content pet → null, so callers keep their
// existing visual byte-for-byte.
//
// Theme fallback when a theme has no art for a mood:
//   hungry  → null (existing idle art, including the user's idle choice)
//   fainted → the theme's sleeping art

const MOOD_HUNGRY = "hungry";
const MOOD_FAINTED = "fainted";

const HUNGRY_REST_STATES = new Set(["idle"]);
const FAINTED_REST_STATES = new Set(["idle", "collapsing", "sleeping", "waking"]);

function moodFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.enabled !== true) return null;
  switch (snapshot.stage) {
    case "fainted":
      return MOOD_FAINTED;
    case "hungry":
    case "weak":
      return MOOD_HUNGRY;
    default:
      return null;
  }
}

function hasBinding(stateBindings, state) {
  const entry = stateBindings && stateBindings[state];
  if (!entry) return false;
  return (Array.isArray(entry.files) && entry.files.length > 0) || !!entry.fallbackTo;
}

function isMoodRestState(mood, state) {
  if (mood === MOOD_HUNGRY) return HUNGRY_REST_STATES.has(state);
  if (mood === MOOD_FAINTED) return FAINTED_REST_STATES.has(state);
  return false;
}

// options:
//   mood            "hungry" | "fainted" | null
//   state           logical state about to be displayed
//   miniMode        boolean
//   doNotDisturb    boolean
//   settingsPreview boolean — Settings animation previews show the real slot
//   stateBindings   theme state bindings (state-visual-resolver.buildStateBindings)
//   resolveBinding  (state) => file — resolves a binding incl. fallbackTo
//   eyeTrackedStates optional Set/array of theme eyeTracking.states; a
//                   non-idle eye-tracked state is never substituted so the
//                   renderer does not try to attach eyes to mood art
// Returns a file name, or null to keep the existing visual.
function resolveTamagotchiRestVisual(options = {}) {
  const mood = options.mood;
  const state = options.state;
  if (mood !== MOOD_HUNGRY && mood !== MOOD_FAINTED) return null;
  if (typeof state !== "string" || !isMoodRestState(mood, state)) return null;
  if (options.miniMode || options.doNotDisturb || options.settingsPreview) return null;
  if (state !== "idle" && options.eyeTrackedStates) {
    const tracked = options.eyeTrackedStates instanceof Set
      ? options.eyeTrackedStates
      : new Set(Array.isArray(options.eyeTrackedStates) ? options.eyeTrackedStates : []);
    if (tracked.has(state)) return null;
  }
  const resolveBinding = typeof options.resolveBinding === "function" ? options.resolveBinding : null;
  if (!resolveBinding) return null;
  const bindings = options.stateBindings;
  if (hasBinding(bindings, mood)) return resolveBinding(mood) || null;
  if (mood === MOOD_FAINTED && hasBinding(bindings, "sleeping")) {
    return resolveBinding("sleeping") || null;
  }
  return null;
}

module.exports = {
  MOOD_HUNGRY,
  MOOD_FAINTED,
  HUNGRY_REST_STATES,
  FAINTED_REST_STATES,
  moodFromSnapshot,
  isMoodRestState,
  resolveTamagotchiRestVisual,
};
