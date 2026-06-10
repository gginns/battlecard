import { MODULE_ID } from "./util.js";

/**
 * Target pick mode and target QoL helpers.
 * Everything here builds ON the native Foundry targeting system
 * (token.setTarget / game.user.updateTokenTargets / the targetToken hook) —
 * never a parallel one.
 */

/**
 * Enter pick mode: the next token the user targets (by clicking it, or via
 * any native targeting interaction like the T key) resolves the pick.
 * Escape cancels.
 *
 * @param {object} callbacks
 * @param {(token: Token) => void} callbacks.onPick
 * @param {() => void} [callbacks.onCancel]
 * @returns {() => void} A function that cancels pick mode (idempotent).
 */
export function startTargetPick({ onPick, onCancel }) {
  const board = document.getElementById("board");
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    Hooks.off("targetToken", onTargetToken);
    board?.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    document.body.classList.remove("battlecard-picking");
  };

  // Resolves the pick for ANY native targeting action by the local user,
  // including T-key targeting — not just our click handler below.
  const onTargetToken = (user, token, targeted) => {
    if (done || user !== game.user || !targeted) return;
    cleanup();
    onPick(token);
  };

  // Make a plain left-click on a token act as a native targeting action.
  const onPointerDown = event => {
    if (done || event.button !== 0) return;
    const pos = canvas.mousePosition
      ?? canvas.canvasCoordinatesFromClient?.({ x: event.clientX, y: event.clientY });
    if (!pos) return;
    const token = canvas.tokens?.placeables?.find(t => t.visible && t.bounds?.contains(pos.x, pos.y));
    if (!token) return; // empty canvas click: leave panning etc. alone
    event.preventDefault();
    event.stopPropagation();
    token.setTarget(true, { user: game.user, releaseOthers: true, groupSelection: false });
    // The targetToken hook above completes the pick.
  };

  const onKeyDown = event => {
    if (event.key !== "Escape" || done) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup();
    onCancel?.();
  };

  Hooks.on("targetToken", onTargetToken);
  board?.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  document.body.classList.add("battlecard-picking");

  ui.notifications.info(game.i18n.localize("BATTLECARD.Notifications.PickTarget"));
  return cleanup;
}

/** Clear the user's targets after a sequence ends, if the setting is on. */
export function autoClearTargets() {
  if (!game.settings.get(MODULE_ID, "autoClearTargets")) return;
  clearAllTargets();
}

/**
 * Clear all of the local user's targets across Foundry generations:
 * v14 replaced User#updateTokenTargets (now internal) with
 * TokensLayer#setTargets (foundryvtt#10613); v13 still has the User method.
 */
export function clearAllTargets() {
  try {
    if (typeof canvas.tokens?.setTargets === "function") {
      canvas.tokens.setTargets([]);
    } else if (typeof game.user.updateTokenTargets === "function") {
      game.user.updateTokenTargets([]);
      game.user.broadcastActivity?.({ targets: [] });
    } else {
      for (const token of [...(game.user.targets ?? [])]) {
        token.setTarget(false, { user: game.user, releaseOthers: false });
      }
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to clear targets`, e);
  }
}
