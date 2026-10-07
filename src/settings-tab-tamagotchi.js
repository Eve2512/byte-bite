"use strict";

// byte-bite tamagotchi Settings tab: opt-in toggle, HP bar toggle, decay
// tuning, read-only stats and a confirmed "Reset pet". Writes go through
// settingsAPI.update (controller → store) like every other tab; stats come
// from the dedicated settings:tamagotchi-* IPC and live pushes.

(function initSettingsTabTamagotchi(root) {
  // Keep in sync with src/prefs.js and src/settings-actions.js.
  const FAINT_HOUR_OPTIONS = Object.freeze([
    { value: 8, labelKey: "tamagotchiFaint8h" },
    { value: 24, labelKey: "tamagotchiFaint24h" },
    { value: 72, labelKey: "tamagotchiFaint3d" },
  ]);
  const TOKENS_PER_BELLY_OPTIONS = Object.freeze([25000, 50000, 100000, 250000, 500000, 1000000]);
  const STAGE_LABEL_KEYS = Object.freeze({
    full: "tamagotchiStageFull",
    content: "tamagotchiStageContent",
    hungry: "tamagotchiStageHungry",
    weak: "tamagotchiStageWeak",
    fainted: "tamagotchiStageFainted",
  });

  let state = null;
  let helpers = null;
  let ops = null;
  let statsHost = null;
  let lastSnapshot = null;
  let fetchSeq = 0;
  let resetPending = false;
  let liveListenerRegistered = false;

  function t(key) {
    return helpers.t(key);
  }

  function formatTokenCount(n) {
    if (!Number.isFinite(n)) return "0";
    if (n >= 1000000) return `${Math.round(n / 100000) / 10}M`;
    if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
    return String(Math.round(n));
  }

  function formatDays(n) {
    return t("tamagotchiDays").replace("{n}", String(Number.isFinite(n) ? n : 0));
  }

  // Pure: snapshot → [[labelKey, value], ...] (exported for tests).
  function buildStatsModel(snapshot, nowMs = Date.now()) {
    if (!snapshot || snapshot.enabled !== true) return null;
    const stage = typeof snapshot.stage === "string" ? snapshot.stage : null;
    let fullness = Number.isFinite(snapshot.fullness) ? snapshot.fullness : 0;
    if (stage !== "fainted" && Number.isFinite(snapshot.faintsAt)
      && Number.isFinite(snapshot.faintAfterMs) && snapshot.faintAfterMs > 0) {
      fullness = Math.max(0, Math.min(1, (snapshot.faintsAt - nowMs) / snapshot.faintAfterMs));
    }
    return [
      ["tamagotchiStatStage", stage ? { key: STAGE_LABEL_KEYS[stage] || "tamagotchiStageNone" } : { key: "tamagotchiStageNone" }],
      ["tamagotchiStatFullness", stage ? `${Math.round(fullness * 100)}%` : "–"],
      ["tamagotchiStatAge", { days: Number.isFinite(snapshot.ageDays) ? snapshot.ageDays : 0 }],
      ["tamagotchiStatBestAge", { days: Number.isFinite(snapshot.bestAgeDays) ? snapshot.bestAgeDays : 0 }],
      ["tamagotchiStatFaints", String(Number.isFinite(snapshot.faintCount) ? snapshot.faintCount : 0)],
      ["tamagotchiStatTokens", formatTokenCount(snapshot.tokensEatenTotal)],
    ];
  }

  function renderValue(value) {
    if (value && typeof value === "object") {
      if (value.key) return t(value.key);
      if (Object.prototype.hasOwnProperty.call(value, "days")) return formatDays(value.days);
    }
    return String(value);
  }

  function buildTextBlock(labelKey, descKey) {
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t(labelKey);
    text.appendChild(label);
    if (descKey) {
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = t(descKey);
      text.appendChild(desc);
    }
    return text;
  }

  function savePref(key, value) {
    return window.settingsAPI.update(key, value).then((result) => {
      if (result && result.status === "ok") return true;
      ops.showToast(t("toastSaveFailed") + ((result && result.message) || "unknown error"), { error: true });
      return false;
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      return false;
    });
  }

  function buildSegmentedPrefRow({ key, labelKey, descKey, options, fallback, disabled }) {
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(buildTextBlock(labelKey, descKey));
    const controlHost = document.createElement("div");
    controlHost.className = "row-control";
    const snapshot = state.snapshot || {};
    const control = helpers.buildSegmentedRadio({
      value: String(snapshot[key] !== undefined ? snapshot[key] : fallback),
      disabled,
      ariaLabel: t(labelKey),
      options: options.map((option) => ({ value: String(option.value), label: option.label })),
      onChange: (next) => savePref(key, Number(next)),
    });
    controlHost.appendChild(control.element);
    row.appendChild(controlHost);
    return row;
  }

  function renderStats() {
    if (!statsHost) return;
    statsHost.innerHTML = "";
    const model = buildStatsModel(lastSnapshot);
    if (!model) {
      const row = document.createElement("div");
      row.className = "row";
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.textContent = t("tamagotchiStatsOff");
      row.appendChild(desc);
      statsHost.appendChild(row);
      return;
    }
    for (const [labelKey, value] of model) {
      const row = document.createElement("div");
      row.className = "row tamagotchi-stat-row";
      row.appendChild(buildTextBlock(labelKey, null));
      const control = document.createElement("div");
      control.className = "row-control tamagotchi-stat-value";
      control.textContent = renderValue(value);
      row.appendChild(control);
      statsHost.appendChild(row);
    }
  }

  function fetchStats() {
    if (!window.settingsAPI || typeof window.settingsAPI.getTamagotchi !== "function") return;
    const seq = ++fetchSeq;
    window.settingsAPI.getTamagotchi().then((result) => {
      if (seq !== fetchSeq) return;
      lastSnapshot = result && result.status === "ok" ? result.snapshot : null;
      renderStats();
    }).catch(() => {});
  }

  async function confirmAndReset(button) {
    if (resetPending) return;
    const action = await helpers.showSettingsConfirmModal({
      title: t("tamagotchiResetConfirmTitle"),
      detail: t("tamagotchiResetConfirmDetail"),
      actions: [
        { id: "cancel", label: t("tamagotchiCancel"), tone: "neutral", defaultFocus: true },
        { id: "confirm", label: t("tamagotchiResetConfirmAction"), tone: "danger" },
      ],
    });
    if (action !== "confirm") return;
    resetPending = true;
    helpers.setButtonState(button, { pending: true });
    try {
      const result = await window.settingsAPI.resetTamagotchi();
      if (!result || result.status !== "ok") throw new Error("reset failed");
      ops.showToast(t("tamagotchiResetDone"));
      fetchStats();
    } catch {
      ops.showToast(t("tamagotchiResetFailed"), { error: true });
    } finally {
      resetPending = false;
      helpers.setButtonState(button, { pending: false });
    }
  }

  function render(parent) {
    const snapshot = state.snapshot || {};
    const enabled = snapshot.tamagotchiEnabled === true;

    const h1 = document.createElement("h1");
    h1.textContent = t("tamagotchiSectionTitle");
    parent.appendChild(h1);
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("tamagotchiIntro");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection("", [
      helpers.buildSwitchRow({
        key: "tamagotchiEnabled",
        labelKey: "rowTamagotchiEnabled",
        descKey: "rowTamagotchiEnabledDesc",
      }),
      helpers.buildSwitchRow({
        key: "tamagotchiShowHpBar",
        labelKey: "rowTamagotchiHpBar",
        descKey: "rowTamagotchiHpBarDesc",
        disabled: !enabled,
      }),
      buildSegmentedPrefRow({
        key: "tamagotchiFaintAfterHours",
        labelKey: "rowTamagotchiFaintAfter",
        descKey: "rowTamagotchiFaintAfterDesc",
        fallback: 24,
        options: FAINT_HOUR_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
      }),
      buildSegmentedPrefRow({
        key: "tamagotchiTokensPerBelly",
        labelKey: "rowTamagotchiTokensPerBelly",
        descKey: "rowTamagotchiTokensPerBellyDesc",
        fallback: 100000,
        options: TOKENS_PER_BELLY_OPTIONS.map((value) => ({ value, label: formatTokenCount(value) })),
      }),
    ]));

    statsHost = document.createElement("div");
    statsHost.className = "section-rows tamagotchi-stats";
    const statsSection = helpers.buildSection(t("tamagotchiStatsTitle"), []);
    statsSection.appendChild(statsHost);
    parent.appendChild(statsSection);
    renderStats();
    fetchStats();

    const resetRow = document.createElement("div");
    resetRow.className = "row";
    resetRow.appendChild(buildTextBlock("rowTamagotchiReset", "rowTamagotchiResetDesc"));
    const resetHost = document.createElement("div");
    resetHost.className = "row-control";
    const resetButton = helpers.buildButton({
      labelKey: "tamagotchiResetButton",
      tone: "danger",
      pending: resetPending,
    });
    resetButton.addEventListener("click", () => { void confirmAndReset(resetButton); });
    resetHost.appendChild(resetButton);
    resetRow.appendChild(resetHost);
    parent.appendChild(helpers.buildSection("", [resetRow]));

    if (!liveListenerRegistered && window.settingsAPI
      && typeof window.settingsAPI.onTamagotchiChanged === "function") {
      liveListenerRegistered = true;
      window.settingsAPI.onTamagotchiChanged((next) => {
        lastSnapshot = next || null;
        fetchSeq += 1; // a live push supersedes any in-flight fetch
        if (state.activeTab === "tamagotchi" && statsHost && statsHost.isConnected !== false) renderStats();
      });
    }
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs.tamagotchi = { render };
  }

  root.ClawdSettingsTabTamagotchi = {
    init,
    __test: {
      FAINT_HOUR_OPTIONS,
      TOKENS_PER_BELLY_OPTIONS,
      buildStatsModel,
      formatTokenCount,
    },
  };
})(globalThis);
