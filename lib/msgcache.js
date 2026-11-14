/**
 * Short-lived cache of recent messages (incoming and outgoing).
 *  - Baileys asks for it (getMessage) when a phone requests a retry of a message the bot sent;
 *    without it those messages show "Waiting for this message".
 *  - The emoji-reaction saver looks the reacted message up here (view-once media, statuses).
 */
const MAX = 4000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const map = new Map(); // `${chat}|${id}` -> { msg, ts }

const k = (chat, id) => `${chat}|${id}`;

function set(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  const key = k(msg.key.remoteJid, id);
  map.delete(key); // refresh insertion order
  map.set(key, { msg, ts: Date.now() });
  if (map.size > MAX) {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [kk, v] of map) {
      if (map.size <= MAX * 0.9 && v.ts > cutoff) break;
      map.delete(kk);
    }
  }
}

const get = (chat, id) => map.get(k(chat, id))?.msg || null;

/** Lookup by id only (used when the chat is not known, e.g. getMessage). */
function find(id) {
  for (const [kk, v] of map) if (kk.endsWith(`|${id}`)) return v.msg;
  return null;
}

module.exports = { set, get, find, size: () => map.size };
