import { MODULE_ID, loadTemplatesCompat, log, warn } from "./util.js";
import { registerSettings } from "./settings.js";
import { registerSocket } from "./sockets.js";
import { registerChatCardHooks } from "./chat-card.js";
import { BattlecardDialog } from "./attack-dialog.js";
import { registerReticle } from "./reticle.js";

/**
 * Trigger & interception (§3).
 *
 * Strategy: on dnd5e.preUseActivity for attack-roll activities we do NOT
 * cancel usage — cancelling would skip the system's resource consumption
 * (ammo, spell slots). Instead we suppress the system's configuration dialog
 * and its usage chat message, tag the usage config, and open our dialog from
 * dnd5e.postUseActivity once consumption has resolved normally.
 */

Hooks.once("init", () => {
  registerSettings();
  loadTemplatesCompat([
    `modules/${MODULE_ID}/templates/dialog.hbs`,
    `modules/${MODULE_ID}/templates/attack-phase.hbs`,
    `modules/${MODULE_ID}/templates/damage-phase.hbs`,
    `modules/${MODULE_ID}/templates/chat-card.hbs`
  ]);
  registerChatCardHooks();
  log("Initialized");
});

Hooks.once("ready", () => {
  registerSocket();
  registerReticle();
});

Hooks.on("dnd5e.preUseActivity", (activity, usageConfig, dialogConfig, messageConfig) => {
  try {
    // Scope guard (§3): only attack-roll activities. Saves, utility, healing,
    // template-only AoE all return early and behave like vanilla.
    if (activity?.type !== "attack") return;

    // Escape hatch (§3): bypass modifier key → untouched system flow.
    if (isBypassKeyHeld(usageConfig)) return;

    dialogConfig.configure = false;        // no system configuration dialog
    messageConfig.create = false;          // no system usage chat message
    usageConfig.subsequentActions = false; // no auto attack-roll dialog (AttackActivity._triggerSubsequentActions)
    foundry.utils.setProperty(usageConfig, `${MODULE_ID}.intercepted`, true);
  } catch (e) {
    warn("preUseActivity interception failed — falling back to system flow", e);
  }
});

Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, _results) => {
  try {
    if (!foundry.utils.getProperty(usageConfig ?? {}, `${MODULE_ID}.intercepted`)) return;
    BattlecardDialog.open(activity);
  } catch (e) {
    warn("Failed to open Battlecard dialog", e);
  }
});

/**
 * Is the configured bypass key held for this activation? Prefers the
 * originating pointer event; falls back to global keyboard state.
 */
function isBypassKeyHeld(usageConfig) {
  const key = game.settings.get(MODULE_ID, "bypassKey");
  if (key === "None") return false;
  const event = usageConfig?.event;
  if (event && ("shiftKey" in event)) {
    if (key === "Shift") return !!event.shiftKey;
    if (key === "Control") return !!(event.ctrlKey || event.metaKey);
    if (key === "Alt") return !!event.altKey;
    return false;
  }
  try {
    return game.keyboard?.isModifierActive?.(key) ?? false;
  } catch (e) {
    return false;
  }
}
