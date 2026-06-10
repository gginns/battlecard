import { MODULE_ID, SOCKET_NAME, warn } from "./util.js";

/**
 * Cross-client card updates. Players can update chat messages they authored;
 * anything else (e.g. a GM-authored card touched by a player after Resume) is
 * routed through this socket and executed by the active GM client.
 * The update function is caller-agnostic: callers always go through
 * requestMessageUpdate and never care who executes it.
 */

export function registerSocket() {
  game.socket.on(SOCKET_NAME, onSocketMessage);
}

async function onSocketMessage(data) {
  try {
    if (data?.action !== "updateMessage") return;
    // Exactly one client executes: the deterministic active GM.
    if (!game.users.activeGM?.isSelf) return;
    const message = game.messages.get(data.messageId);
    if (!message) return warn(`Socket update for unknown message ${data.messageId}`);
    await message.update(data.update);
  } catch (e) {
    warn("Socket message handling failed", e);
  }
}

/**
 * Update a chat message, locally if permitted, otherwise via the GM socket.
 * @param {string} messageId
 * @param {object} update  Differential update data.
 */
export async function requestMessageUpdate(messageId, update) {
  const message = game.messages.get(messageId);
  if (!message) return warn(`Cannot update unknown message ${messageId}`);

  let permitted;
  try {
    permitted = message.canUserModify(game.user, "update");
  } catch (e) {
    permitted = game.user.isGM;
  }
  if (permitted) return message.update(update);

  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("BATTLECARD.Notifications.NoGMForUpdate"));
    return null;
  }
  game.socket.emit(SOCKET_NAME, { action: "updateMessage", messageId, update });
  return null;
}
