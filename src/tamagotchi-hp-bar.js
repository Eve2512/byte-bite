"use strict";

// ── Tamagotchi HP bar (pet render window) ──
//
// Optional fullness bar drawn under the pet. It lives in the render window,
// which is permanently click-through (input is owned by the separate hit
// window), so it can never change hit testing, drag or click reactions.
//
// The main process pushes a store snapshot (plus `showHpBar`) only on real
// changes; between pushes the bar interpolates locally from
// faintsAt / faintAfterMs, so no polling IPC is needed.
//
// Loaded both by Node tests (module.exports) and by the renderer as a plain
// <script> (globalThis.tamagotchiHpBar), like pet-accessory-layout.js.

(function exposeTamagotchiHpBar(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.tamagotchiHpBar = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createTamagotchiHpBar() {
  // Colour bands follow the store's stage thresholds:
  // content+ (>= 0.35) green, hungry (>= 0.1) amber, weak (< 0.1) red.
  const OK_MIN = 0.35;
  const LOW_MIN = 0.1;
  const REFRESH_MS = 30 * 1000;
  const HIDDEN = Object.freeze({ visible: false, fraction: 0, level: null, text: "" });

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function computeHpBarModel(snapshot, nowMs, options = {}) {
    if (!snapshot || typeof snapshot !== "object") return HIDDEN;
    if (snapshot.enabled !== true || snapshot.showHpBar !== true) return HIDDEN;
    if (options.miniMode === true) return HIDDEN;
    if (typeof snapshot.stage !== "string" || !snapshot.stage) return HIDDEN;

    if (snapshot.stage === "fainted" || snapshot.alive === false) {
      return { visible: true, fraction: 0, level: "fainted", text: "zzz" };
    }

    let fraction;
    if (Number.isFinite(snapshot.faintsAt) && Number.isFinite(snapshot.faintAfterMs)
      && snapshot.faintAfterMs > 0 && Number.isFinite(nowMs)) {
      fraction = clamp01((snapshot.faintsAt - nowMs) / snapshot.faintAfterMs);
    } else if (Number.isFinite(snapshot.fullness)) {
      fraction = clamp01(snapshot.fullness);
    } else {
      return HIDDEN;
    }
    // Ran out locally before the store's next tick noticed the faint.
    if (fraction <= 0) return { visible: true, fraction: 0, level: "fainted", text: "zzz" };

    const level = fraction >= OK_MIN ? "ok" : (fraction >= LOW_MIN ? "low" : "critical");
    return { visible: true, fraction, level, text: "" };
  }

  function mountHpBar(doc, parent) {
    if (!doc || !parent) return null;
    const bar = doc.createElement("div");
    bar.id = "tamagotchi-hp-bar";
    bar.className = "tamagotchi-hp-bar";
    bar.setAttribute("aria-hidden", "true");
    bar.hidden = true;
    const fill = doc.createElement("div");
    fill.className = "tamagotchi-hp-fill";
    const zzz = doc.createElement("span");
    zzz.className = "tamagotchi-hp-zzz";
    bar.appendChild(fill);
    bar.appendChild(zzz);
    parent.appendChild(bar);
    return { bar, fill, zzz };
  }

  function applyHpBarModel(view, model) {
    if (!view || !model) return;
    view.bar.hidden = !model.visible;
    if (!model.visible) return;
    view.bar.setAttribute("data-level", model.level || "");
    view.fill.style.width = `${Math.round(model.fraction * 1000) / 10}%`;
    view.zzz.textContent = model.text || "";
  }

  return {
    OK_MIN,
    LOW_MIN,
    REFRESH_MS,
    computeHpBarModel,
    mountHpBar,
    applyHpBarModel,
  };
});
