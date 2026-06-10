import { MODULE_ID, renderTemplateCompat, warn } from "./util.js";
import { requestMessageUpdate } from "./sockets.js";

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
  ChatMessage.implementation.applyRollMode(data, state.rollMode);
  return ChatMessage.implementation.create(data);
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
 * Card content is shared across clients, so per-user affordances (the GM-only
 * "Reveal to all" button, the owner/GM Resume button) are trimmed and wired
 * here at render time on each client.
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

  const reveal = html.querySelector('[data-bc-action="reveal"]');
  if (reveal) {
    const hidden = (message.whisper?.length ?? 0) > 0 || message.blind;
    if (!game.user.isGM || !hidden) reveal.remove();
    else reveal.addEventListener("click", () => revealToAll(message));
  }

  // Resume (M2): visible only to the sequence owner and GM, on incomplete
  // sequences. Hidden entirely for now; the state plumbing already exists.
  const resume = html.querySelector('[data-bc-action="resume"]');
  if (resume) resume.remove();
}

/** GM one-click republish of a hidden card to everyone. */
async function revealToAll(message) {
  try {
    await message.update({ whisper: [], blind: false });
  } catch (e) {
    warn("Reveal to all failed", e);
  }
}
