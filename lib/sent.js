/**
 * IDs of messages the bot itself sent. Because the bot runs as a linked device, its own
 * messages can echo back as "fromMe" events; this lets us ignore them (and lets the AI
 * recognise when someone replies to one of the bot's messages).
 */
const ids = new Set();

function add(id) {
  ids.add(id);
  if (ids.size > 1000) ids.delete(ids.values().next().value);
}

module.exports = { add, has: (id) => ids.has(id) };
