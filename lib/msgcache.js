/**
 * Short-lived cache of recent messages (incoming and outgoing).
 *  - Baileys asks for it (getMessage) when a phone requests a retry of a message the bot sent;
 *    without it those messages show "Waiting for this message".
 *  - .vv and the emoji-reaction saver look the original message up here (view-once media, statuses).
 *    A quoted view-once only carries a stripped copy, so the cached original is the one that can be downloaded.
 *  - Messages with media are also written to data/msgcache.json, so a restart does not forget them.
 */
const fs = require('fs');
const path = require('path');
const { BufferJSON } = require('@whiskeysockets/baileys');
const { isViewOnce, findMedia } = require('./utils');

const MAX = 6000;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const map = new Map(); // `${chat}|${id}` -> { msg, ts }

// View-once and status media are kept apart and longer, so busy chats cannot push them out.
const KEEP_MAX = 400;
const KEEP_AGE_MS = 24 * 60 * 60 * 1000;
const keep = new Map();

const k = (chat, id) => `${chat}|${id}`;

function trim(m, max, age) {
  if (m.size <= max) return;
  const cutoff = Date.now() - age;
  for (const [kk, v] of m) {
    if (m.size <= max * 0.9 && v.ts > cutoff) break;
    m.delete(kk);
  }
}

function set(msg) {
  const id = msg?.key?.id;
  if (!id || !msg.message) return;
  const key = k(msg.key.remoteJid, id);
  const entry = { msg, ts: Date.now() };
  map.delete(key); // refresh insertion order
  map.set(key, entry);
  trim(map, MAX, MAX_AGE_MS);
  if (findMedia(msg.message)) scheduleFlush();

  if (isViewOnce(msg.message) || (msg.key.remoteJid === 'status@broadcast' && findMedia(msg.message))) {
    keep.delete(key);
    keep.set(key, entry);
    trim(keep, KEEP_MAX, KEEP_AGE_MS);
  }
}

const get = (chat, id) => (map.get(k(chat, id)) || keep.get(k(chat, id)))?.msg || null;

/** Lookup by id only (chat unknown, or the chat id differs between phone-number and LID form). */
function find(id) {
  const tail = `|${id}`;
  for (const m of [map, keep]) {
    for (const [kk, v] of m) if (kk.endsWith(tail)) return v.msg;
  }
  return null;
}

const FILE = path.join(__dirname, '..', 'data', 'msgcache.json');
const DISK_MAX = 1500;
let dirty = false;
let timer = null;

const scheduleFlush = () => {
  dirty = true;
  if (timer) return;
  timer = setTimeout(flush, 20_000);
  timer.unref();
};

/** Write the newest media messages to disk (called on a timer, and before the process exits). */
function flush() {
  clearTimeout(timer);
  timer = null;
  if (!dirty) return;
  dirty = false;
  try {
    const seen = new Set();
    const rows = [];
    for (const m of [keep, map]) {
      for (const [kk, v] of m) {
        if (!seen.has(kk) && findMedia(v.msg.message)) {
          seen.add(kk);
          rows.push([kk, v.ts, v.msg]);
        }
      }
    }
    rows.sort((a, b) => b[1] - a[1]);
    const json = JSON.stringify(rows.slice(0, DISK_MAX), (key, val) => (key === 'jpegThumbnail' ? undefined : BufferJSON.replacer(key, val)));
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', json);
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.error('could not save message cache:', e.message);
  }
}

function load() {
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'), BufferJSON.reviver);
    const now = Date.now();
    for (const [kk, ts, msg] of rows.reverse()) {
      if (!msg?.message) continue;
      const viewOnce = isViewOnce(msg.message) || (msg.key.remoteJid === 'status@broadcast' && findMedia(msg.message));
      if (now - ts > (viewOnce ? KEEP_AGE_MS : MAX_AGE_MS)) continue;
      const entry = { msg, ts };
      map.set(kk, entry);
      if (viewOnce) keep.set(kk, entry);
    }
  } catch {
    /* no cache file yet */
  }
}
load();

module.exports = { set, get, find, flush, size: () => map.size + keep.size };
