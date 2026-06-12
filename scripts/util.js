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

/** Resolve a typed word ("fire", "Fire", localized label) to a damage type key. */
export function damageTypeKey(word) {
  if (!word) return null;
  const types = CONFIG.DND5E?.damageTypes ?? {};
  const lower = word.toLowerCase();
  if (lower in types) return lower;
  for (const [key, cfg] of Object.entries(types)) {
    const label = game.i18n.localize(cfg.label ?? cfg.name ?? String(cfg));
    if (label.toLowerCase() === lower) return key;
  }
  return null;
}

/** Localized label for a damage type key; falls back to the key itself. */
export function damageTypeLabel(type) {
  if (!type) return "";
  const cfg = CONFIG.DND5E?.damageTypes?.[type];
  return game.i18n.localize(cfg?.label ?? cfg?.name ?? type);
}

/**
 * Parse a damage bonus string into typed and untyped pieces (§ typed bonus
 * damage). Comma-separated entries, each "formula [type]":
 *   "+1d6 fire, 1d8 psychic, +2"
 * → { untyped: "2", typed: [{formula:"1d6", type:"fire"}, {formula:"1d8", type:"psychic"}] }
 * Untyped entries are folded into the weapon's first damage part.
 */
export function parseTypedBonus(input) {
  const result = { untyped: "", typed: [] };
  const segments = (input ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const untypedParts = [];
  for (const segment of segments) {
    const s = segment.replace(/^\+\s*/, "");
    if (!s) continue;
    const m = s.match(/^(.*?)\s+([a-zA-Z']+)$/);
    const type = m ? damageTypeKey(m[2]) : null;
    const formula = type ? m[1].trim() : s;
    // A formula needs at least a digit or @-reference ("fire" alone is not one).
    if (!formula || !/[\d@]/.test(formula)) continue;
    if (type) result.typed.push({ formula, type });
    else untypedParts.push(formula);
  }
  result.untyped = untypedParts.join(" + ");
  return result;
}

/**
 * Parse a manual (physical dice) damage entry into typed totals:
 *   "14"  or  "10 slashing, 4 fire"
 * → [{amount: 10, type: "slashing"}, {amount: 4, type: "fire"}] — type null
 * when omitted (caller substitutes the weapon's primary type).
 * Returns null when any segment is invalid.
 */
export function parseTypedManualDamage(input) {
  const segments = (input ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  const parts = [];
  for (const segment of segments) {
    const m = segment.match(/^(\d+)\s*([a-zA-Z']+)?$/);
    if (!m) return null;
    const type = m[2] ? damageTypeKey(m[2]) : null;
    if (m[2] && !type) return null; // unknown damage type word
    parts.push({ amount: Number(m[1]), type });
  }
  return parts;
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
