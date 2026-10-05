"use strict";

// ── Tamagotchi IPC: hunger snapshot → pet renderer ──
//
// Pushes "tamagotchi:snapshot" whenever the store changes (meal, faint,
// stage crossing, enable/disable) and answers "tamagotchi:get-snapshot" so a
// freshly loaded renderer can pull the current value. Renderers interpolate
// fullness between pushes from faintsAt/faintAfterMs - the store only
// broadcasts on real changes, not on every minute of decay.

const SNAPSHOT_CHANNEL = "tamagotchi:snapshot";
const GET_SNAPSHOT_CHANNEL = "tamagotchi:get-snapshot";

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerTamagotchiIpc requires ${name}`);
  return value;
}

function registerTamagotchiIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const store = requiredDependency(options.store, "store");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");

  ipcMain.handle(GET_SNAPSHOT_CHANNEL, () => store.snapshot());
  const unsubscribe = store.onChange((snapshot) => {
    sendToRenderer(SNAPSHOT_CHANNEL, snapshot);
  });

  return {
    // Re-push after a renderer (re)load or theme reload drops its state.
    resend() {
      sendToRenderer(SNAPSHOT_CHANNEL, store.snapshot());
    },
    dispose() {
      unsubscribe();
      ipcMain.removeHandler(GET_SNAPSHOT_CHANNEL);
    },
  };
}

module.exports = {
  GET_SNAPSHOT_CHANNEL,
  SNAPSHOT_CHANNEL,
  registerTamagotchiIpc,
};
