import { MODULE_ID } from "./util.js";

/** Re-render the target reticle when its settings change. */
const refreshTargetUI = () => Hooks.callAll(`${MODULE_ID}.refreshTargetUI`);

export function registerSettings() {
  game.settings.register(MODULE_ID, "autoClearTargets", {
    name: "BATTLECARD.Settings.AutoClearTargets.Name",
    hint: "BATTLECARD.Settings.AutoClearTargets.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "bypassKey", {
    name: "BATTLECARD.Settings.BypassKey.Name",
    hint: "BATTLECARD.Settings.BypassKey.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      Shift: "BATTLECARD.Settings.BypassKey.Shift",
      Control: "BATTLECARD.Settings.BypassKey.Control",
      Alt: "BATTLECARD.Settings.BypassKey.Alt",
      None: "BATTLECARD.Settings.BypassKey.None"
    },
    default: "Shift"
  });

  game.settings.register(MODULE_ID, "defaultRollMode", {
    name: "BATTLECARD.Settings.DefaultRollMode.Name",
    hint: "BATTLECARD.Settings.DefaultRollMode.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      core: "BATTLECARD.Settings.DefaultRollMode.Core",
      publicroll: "CHAT.RollPublic",
      gmroll: "CHAT.RollPrivate",
      blindroll: "CHAT.RollBlind",
      selfroll: "CHAT.RollSelf"
    },
    default: "core"
  });

  game.settings.register(MODULE_ID, "reticleEnabled", {
    name: "BATTLECARD.Settings.ReticleEnabled.Name",
    hint: "BATTLECARD.Settings.ReticleEnabled.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: refreshTargetUI
  });

  game.settings.register(MODULE_ID, "reticleColor", {
    name: "BATTLECARD.Settings.ReticleColor.Name",
    hint: "BATTLECARD.Settings.ReticleColor.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "#E24B4A",
    onChange: refreshTargetUI
  });

  game.settings.register(MODULE_ID, "reticleSpeed", {
    name: "BATTLECARD.Settings.ReticleSpeed.Name",
    hint: "BATTLECARD.Settings.ReticleSpeed.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      slow: "BATTLECARD.Settings.ReticleSpeed.Slow",
      medium: "BATTLECARD.Settings.ReticleSpeed.Medium",
      fast: "BATTLECARD.Settings.ReticleSpeed.Fast"
    },
    default: "medium",
    onChange: refreshTargetUI
  });

  // Hidden: remembered dialog position, persisted per client.
  game.settings.register(MODULE_ID, "dialogPosition", {
    scope: "client",
    config: false,
    type: Object,
    default: null
  });
}

/** The roll mode the dialog should start with. */
export function initialRollMode() {
  const pref = game.settings.get(MODULE_ID, "defaultRollMode");
  if (pref === "core") return game.settings.get("core", "rollMode");
  return pref;
}
