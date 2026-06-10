/**
 * Shared constants and version-compat helpers.
 * Foundry v13+ moved several globals under the `foundry.*` namespace; the
 * helpers here prefer the namespaced form and fall back to the legacy global
 * so the module keeps working across v13/v14.
 */

export const MODULE_ID = "battlecard";
export const SOCKET_NAME = `module.${MODULE_ID}`;

export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

/* -------------------------------------------- */
/*  Namespace compat                            */
/* -------------------------------------------- */

export function renderTemplateCompat(path, data) {
  const fn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return fn(path, data);
}

export function loadTemplatesCompat(paths) {
  const fn = foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  return fn(paths);
}

export function getRollClass() {
  return foundry.dice?.Roll ?? globalThis.Roll;
}

export function fromUuidCompat(uuid) {
  const fn = foundry.utils?.fromUuid ?? globalThis.fromUuid;
  return fn(uuid);
}

export function fromUuidSyncCompat(uuid) {
  const fn = foundry.utils?.fromUuidSync ?? globalThis.fromUuidSync;
  return fn(uuid);
}

/** The dnd5e system API object. */
export function dnd5eApi() {
  return game.dnd5e ?? globalThis.dnd5e ?? game.system?.api ?? null;
}

/** dnd5e D20Roll advantage-mode constants, with a safe fallback. */
export function advModes() {
  return dnd5eApi()?.dice?.D20Roll?.ADV_MODE ?? { NORMAL: 0, ADVANTAGE: 1, DISADVANTAGE: -1 };
}

/* -------------------------------------------- */
/*  Targeting helpers                           */
/* -------------------------------------------- */

/** First token in the local user's native target set, or null. */
export function firstTarget() {
  const targets = game.user?.targets;
  if (!targets?.size) return null;
  return targets.first?.() ?? [...targets][0];
}

export function targetCount() {
  return game.user?.targets?.size ?? 0;
}

/** Plain-data snapshot of a targeted token for storage in flags. */
export function snapshotToken(token) {
  if (!token) return null;
  return {
    name: token.name ?? token.document?.name ?? "?",
    img: token.document?.texture?.src ?? token.actor?.img ?? null,
    uuid: token.document?.uuid ?? null
  };
}

/* -------------------------------------------- */
/*  Formula helpers                             */
/* -------------------------------------------- */

/**
 * Normalize a user-typed situational bonus ("+2", "1d4", "+ 1d4 - 1") into a
 * formula fragment safe to append as a roll part.
 */
export function normalizeBonus(str) {
  let s = (str ?? "").trim();
  if (!s) return "";
  if (s.startsWith("+")) s = s.slice(1).trim();
  return s;
}

/** True if a bonus fragment is a plain number (no dice). */
export function isNumericBonus(str) {
  return /^[+-]?\s*\d+$/.test((str ?? "").trim());
}

/**
 * Parse the flat to-hit modifier from an activity's label (e.g. "+ 9" -> 9).
 * Display/manual-math only — never used for actual rolls.
 */
export function parseToHit(activity) {
  const label = activity?.labels?.toHit ?? activity?.labels?.modifier ?? "";
  const m = String(label).replace(/\s+/g, "").match(/^([+-]?\d+)$/);
  return m ? Number(m[1]) : null;
}

/* -------------------------------------------- */
/*  Roll modes                                  */
/* -------------------------------------------- */

/**
 * Options for the roll-mode dropdown: the core modes (handling both the v12
 * string-label and v13+ {label, icon} shapes of CONFIG.Dice.rollModes) plus
 * Battlecard's "Whisper to specific players..." mode (§4).
 */
export function rollModeOptions(selected) {
  const options = Object.entries(CONFIG.Dice.rollModes).map(([value, cfg]) => ({
    value,
    label: game.i18n.localize(typeof cfg === "string" ? cfg : cfg.label),
    selected: value === selected
  }));
  options.push({
    value: "whisper",
    label: game.i18n.localize("BATTLECARD.Dialog.WhisperOption"),
    selected: selected === "whisper"
  });
  return options;
}

/** Whisper recipient user ids for Dice So Nice, mirroring a roll mode. */
export function dsnWhisperIds(rollMode) {
  if (rollMode === "gmroll" || rollMode === "blindroll") {
    return game.users.filter(u => u.isGM).map(u => u.id);
  }
  if (rollMode === "selfroll") return [game.user.id];
  return null;
}

/** Show 3D dice for a roll if Dice So Nice is active. Never throws. */
export async function showDice(roll, rollMode, whisperIds = null) {
  if (!game.dice3d) return;
  try {
    let whisper = dsnWhisperIds(rollMode);
    if (rollMode === "whisper") whisper = [...new Set([...(whisperIds ?? []), game.user.id])];
    await game.dice3d.showForRoll(roll, game.user, true, whisper, rollMode === "blindroll" && !game.user.isGM);
  } catch (e) {
    warn("Dice So Nice display failed", e);
  }
}
