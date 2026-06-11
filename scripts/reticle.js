import { MODULE_ID, warn } from "./util.js";

/**
 * Pulsing target reticle (§8a): "double ripple" — two rings expanding outward
 * from the token edge (scale ~0.95 → 1.45) while fading to alpha 0, staggered
 * half a cycle apart, ease-out, driven by canvas.app.ticker.
 *
 * Renders only for the LOCAL user's own targets (a personal-awareness aid,
 * not a broadcast), built on the native targetToken hook.
 */

const overlays = new Map(); // tokenId -> { token, container, rings }
let tickerFn = null;
let anim = { period: 1800 };

export function registerReticle() {
  Hooks.on("targetToken", (user, token, targeted) => {
    if (user !== game.user) return;
    if (targeted) addOverlay(token);
    else removeOverlay(token?.id);
  });
  // Scene changes destroy all token objects; rebuild from current targets.
  Hooks.on("canvasReady", rebuild);
  Hooks.on("deleteToken", doc => removeOverlay(doc.id));
  // A token re-draw (texture/size change) discards foreign children.
  Hooks.on("drawToken", token => {
    if (overlays.has(token.id)) addOverlay(token);
  });
  // Settings changed: rebuild with new color/speed/enabled state.
  Hooks.on(`${MODULE_ID}.refreshTargetUI`, rebuild);
  if (canvas?.ready) rebuild();
}

/* -------------------------------------------- */

function currentSettings() {
  let enabled = true;
  let colorSetting = "#E24B4A";
  let speed = "medium";
  try {
    enabled = game.settings.get(MODULE_ID, "reticleEnabled");
    colorSetting = game.settings.get(MODULE_ID, "reticleColor");
    speed = game.settings.get(MODULE_ID, "reticleSpeed");
  } catch (e) { /* settings not registered yet */ }
  const parsed = Number(`0x${String(colorSetting).replace("#", "").trim()}`);
  return {
    enabled,
    color: Number.isFinite(parsed) ? parsed : 0xE24B4A,
    period: { slow: 2600, medium: 1800, fast: 1100 }[speed] ?? 1800
  };
}

function rebuild() {
  clearAll();
  if (!canvas?.ready) return;
  const { enabled, period } = currentSettings();
  anim.period = period;
  if (!enabled) return;
  for (const token of game.user?.targets ?? []) addOverlay(token);
}

function addOverlay(token) {
  if (!token || token.destroyed) return;
  const { enabled, color, period } = currentSettings();
  anim.period = period;
  if (!enabled) return;
  removeOverlay(token.id);
  try {
    const radius = Math.max(token.w, token.h) / 2;
    const container = new PIXI.Container();
    container.eventMode = "none";
    container.interactiveChildren = false;
    const rings = [makeRing(color, radius), makeRing(color, radius)];
    container.addChild(...rings);
    container.position.set(token.w / 2, token.h / 2);
    token.addChild(container);
    overlays.set(token.id, { token, container, rings });
    ensureTicker();
  } catch (e) {
    warn("Failed to draw target reticle", e);
  }
}

/** Draw a ring, compatible with both the PIXI v7 and v8 Graphics APIs. */
function makeRing(color, radius) {
  const g = new PIXI.Graphics();
  const width = Math.max(2, radius * 0.07);
  if (typeof g.lineStyle === "function") {
    g.lineStyle({ width, color, alpha: 1 });
    g.drawCircle(0, 0, radius);
  } else {
    g.circle(0, 0, radius).stroke({ width, color });
  }
  return g;
}

function removeOverlay(tokenId) {
  const overlay = overlays.get(tokenId);
  if (!overlay) return;
  overlays.delete(tokenId);
  try {
    if (!overlay.container.destroyed) overlay.container.destroy({ children: true });
  } catch (e) { /* token already destroyed it */ }
}

function clearAll() {
  for (const id of [...overlays.keys()]) removeOverlay(id);
}

/* -------------------------------------------- */

function ensureTicker() {
  if (tickerFn || !canvas?.app?.ticker) return;
  tickerFn = () => {
    if (!overlays.size) return;
    const now = performance.now();
    for (const [id, overlay] of overlays) {
      if (!overlay.token || overlay.token.destroyed || overlay.container.destroyed) {
        overlays.delete(id);
        continue;
      }
      overlay.rings.forEach((ring, i) => {
        const t = ((now / anim.period) + i * 0.5) % 1;
        const eased = 1 - (1 - t) ** 2; // ease-out
        ring.scale.set(0.95 + eased * 0.5); // 0.95 → 1.45
        ring.alpha = 1 - eased;
      });
    }
  };
  canvas.app.ticker.add(tickerFn);
}
