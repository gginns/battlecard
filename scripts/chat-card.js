import { MODULE_ID, fromUuidSyncCompat, renderTemplateCompat, warn } from "./util.js";
import { requestMessageUpdate } from "./sockets.js";
import { BattlecardDialog } from "./attack-dialog.js";

const CARD_TEMPLATE = `modules/${MODULE_ID}/templates/chat-card.hbs`;

/**
 * One ChatMessage per attack sequence, updated in place as it progresses.
 * The full sequence state lives in flags.battlecard.state — the source of
 * truth for Resume and for re-rendering the card on any client.
 */

export async function renderCardContent(state) {
  return renderTemplateCompat(CARD_TEMPLATE, prepareCardContext(state));
}

function prepareCardContext(state) {
  const attacks = (state.attacks ?? [])
    .map((a, index) => ({ ...a, index })) // index into state.attacks, pre-filter
    .filter(a => a.attack)                // only blocks whose attack has been rolled
    .map((a, i) => ({ ...a, num: i + 1 }));
  return {
    ...state,
    attacks,
    multiple: attacks.length > 1
  };
}

/** Create the sequence card. Visibility obeys the chosen roll mode wholesale. */
export async function createSequenceMessage(state, { speaker }) {
  const content = await renderCardContent(state);
  const data = {
    content,
    speaker,
    flags: { [MODULE_ID]: { state } }
  };
  if (state.rollMode === "whisper") {
    // Custom recipient list; the owner is always included so they can see
    // their own card.
    data.whisper = [...new Set([...(state.whisperIds ?? []), state.ownerUserId].filter(Boolean))];
  } else {
    ChatMessage.implementation.applyRollMode(data, state.rollMode);
  }
  return ChatMessage.implementation.create(data);
}

/** Re-render one message's HTML locally (e.g. to toggle its Resume button). */
export function refreshMessageDisplay(message) {
  try {
    ui.chat?.updateMessage?.(message);
  } catch (e) { /* chat log not ready */ }
}

/** Re-render and update the card in place (locally or via the GM socket). */
export async function updateSequenceMessage(messageId, state) {
  const content = await renderCardContent(state);
  return requestMessageUpdate(messageId, {
    content,
    [`flags.${MODULE_ID}.state`]: state
  });
}

/* -------------------------------------------- */
/*  Per-client card rendering                   */
/* -------------------------------------------- */

export function registerChatCardHooks() {
  Hooks.on("renderChatMessageHTML", onRenderChatMessage);
}

/**
 * Per-user affordances (the GM-only "Reveal to all" button, the owner/GM
 * Resume button) are injected at render time on each client — never stored
 * in message content, so cards degrade to clean static text if the module
 * is disabled (§11).
 */
function onRenderChatMessage(message, html) {
  let state;
  try {
    state = message.getFlag(MODULE_ID, "state");
  } catch (e) {
    return;
  }
  if (!state) return;
  html.classList?.add("battlecard-message");
  const card = html.querySelector(".battlecard-card");
  if (!card) return;

  const buttons = [];

  const hidden = (message.whisper?.length ?? 0) > 0 || message.blind;
  if (game.user.isGM && hidden) {
    buttons.push(makeButton("fa-solid fa-eye", "BATTLECARD.Card.RevealToAll", () => revealToAll(message)));
  }

  // Resume (§7): sequence owner and GM only, on incomplete sequences, unless
  // this client's dialog is already showing this very sequence.
  const mayResume = game.user.isGM || game.user.id === state.ownerUserId;
  const dialogOpenHere = BattlecardDialog.current?.messageId === message.id;
  if (!state.complete && mayResume && !dialogOpenHere) {
    buttons.push(makeButton("fa-solid fa-play", "BATTLECARD.Card.Resume", () => BattlecardDialog.resume(message)));
  }

  // Apply Damage: GM-only, per damage block with typed parts. Applies to the
  // GM's selected tokens, or to the block's recorded target if none selected.
  if (game.user.isGM) {
    for (const blockEl of card.querySelectorAll(".bc-card-block[data-bc-index]")) {
      const index = Number(blockEl.dataset.bcIndex);
      const damage = state.attacks?.[index]?.damage;
      if (!damage || damage.miss || !damage.parts?.length) continue;
      const line = blockEl.querySelector(".bc-card-damage-line");
      if (!line) continue;
      const apply = makeButton("fa-solid fa-heart-crack", "BATTLECARD.Card.Apply",
        () => applyDamageFromBlock(message, index));
      apply.classList.add("bc-apply-button");
      apply.dataset.tooltip = game.i18n.localize("BATTLECARD.Card.ApplyHint");
      line.append(apply);
    }
  }

  if (!buttons.length) return;
  const footer = document.createElement("footer");
  footer.className = "bc-card-footer";
  footer.append(...buttons);
  card.append(footer);
}

function makeButton(iconClass, labelKey, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  const icon = document.createElement("i");
  icon.className = iconClass;
  button.append(icon, ` ${game.i18n.localize(labelKey)}`);
  button.addEventListener("click", onClick);
  return button;
}

/** GM one-click republish of a hidden card to everyone. */
async function revealToAll(message) {
  try {
    await message.update({ whisper: [], blind: false });
  } catch (e) {
    warn("Reveal to all failed", e);
  }
}

/* -------------------------------------------- */
/*  Apply damage (GM only)                      */
/* -------------------------------------------- */

/**
 * Apply a damage block through the system's own Actor5e#applyDamage, which
 * handles each creature's resistances/immunities/vulnerabilities per damage
 * type. Targets: the GM's currently selected tokens, falling back to the
 * block's recorded target. Results are appended to the card itself — no new
 * chat messages.
 */
async function applyDamageFromBlock(message, index) {
  const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "state"));
  const damage = state?.attacks?.[index]?.damage;
  if (!damage?.parts?.length) return;

  // Resolve recipients: selection first, recorded target as fallback.
  let recipients = (canvas.tokens?.controlled ?? [])
    .map(t => ({ name: t.name, actor: t.actor }))
    .filter(r => r.actor);
  if (!recipients.length) {
    const target = state.attacks[index].target;
    const tokenDoc = target?.uuid ? fromUuidSyncCompat(target.uuid) : null;
    if (tokenDoc?.actor) recipients = [{ name: target.name, actor: tokenDoc.actor }];
  }
  if (!recipients.length) {
    ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.ApplyNoTargets"));
    return;
  }

  const damages = damage.parts.map(p => ({
    value: p.amount,
    type: p.type ?? "",
    properties: new Set(p.properties ?? [])
  }));

  const results = [];
  for (const { name, actor } of recipients) {
    try {
      const before = effectiveHP(actor);
      await actor.applyDamage(damages);
      const after = effectiveHP(actor);
      results.push({ name, amount: Math.max(0, before - after) });
    } catch (e) {
      warn(`Apply damage to "${name}" failed`, e);
      ui.notifications.error(game.i18n.format("BATTLECARD.Notifications.ApplyFailed", { name }));
    }
  }
  if (!results.length) return;

  // The note shows the per-creature applied amount only when it differs from
  // the rolled total (resistance/vulnerability/immunity at work).
  state.attacks[index].damage.applied = results.map(r => ({
    name: r.name,
    amount: r.amount,
    adjusted: r.amount !== damage.total
  }));
  await updateSequenceMessage(message.id, state);
}

function effectiveHP(actor) {
  const hp = actor?.system?.attributes?.hp ?? {};
  return (hp.value ?? 0) + (hp.temp ?? 0);
}
