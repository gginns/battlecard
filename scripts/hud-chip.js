import { MODULE_ID, renderTemplateCompat, snapshotToken, warn } from "./util.js";
import { clearAllTargets } from "./targeting.js";

const CHIP_TEMPLATE = `modules/${MODULE_ID}/templates/hud-chip.hbs`;

/**
 * Current-target HUD chip (§8b): a small persistent floating element near the
 * top of the screen showing the local user's current target with a ✕ clear
 * button. Solves the off-screen stale-target problem. Multiple targets show
 * the first plus "+N".
 */

let chip = null;
let pending = false;

export function registerHudChip() {
  Hooks.on("targetToken", user => {
    if (user === game.user) refresh();
  });
  Hooks.on("canvasReady", refresh);
  Hooks.on(`${MODULE_ID}.refreshTargetUI`, refresh);
  refresh();
}

async function refresh() {
  // Collapse bursts of targetToken events into one re-render.
  if (pending) return;
  pending = true;
  await Promise.resolve();
  pending = false;

  let enabled = true;
  try {
    enabled = game.settings.get(MODULE_ID, "hudChipEnabled");
  } catch (e) { /* settings not registered yet */ }

  chip?.remove();
  chip = null;

  const targets = [...(game.user?.targets ?? [])];
  if (!enabled || !targets.length) return;

  try {
    const html = await renderTemplateCompat(CHIP_TEMPLATE, {
      target: snapshotToken(targets[0]),
      extra: targets.length - 1
    });
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    chip = wrapper.firstElementChild;
    chip.querySelector('[data-action="clear"]')?.addEventListener("click", () => clearAllTargets());
    document.body.append(chip);
  } catch (e) {
    warn("Failed to render target HUD chip", e);
  }
}
