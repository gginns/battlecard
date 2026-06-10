import { MODULE_ID, renderTemplateCompat, warn } from "./util.js";
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
    .filter(a => a.attack) // only blocks whose attack has been rolled
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
