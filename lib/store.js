const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
const menuPath = path.join(DIR, 'menu.jpg');

const defaults = {
  sudo: [], // phone numbers (digits) allowed to use the bot
  stickerCmds: {}, // sticker sha256 (base64) -> command string, e.g. "vv me"
  menuImage: false, // true when data/menu.jpg exists
  mode: null, // "private" | "public" (null = use .env MODE)
  timers: [], // pending close/open/re-add jobs (survive restarts)
  activity: {}, // groupJid -> { number: lastMessageMs }
  antiDelete: false, // forward deleted messages to the owner DM
  antiEdit: false, // forward edited messages (before/after) to the owner DM
  gameScores: {}, // chatJid -> { number: { name, points, wins } }
  reactSave: true, // react to a photo/video/voice note/status with a save emoji to get it in your DM
  saveEmojis: ['😍', '🔥', '💾', '📥', '👍'],
  groupCfg: {}, // groupJid -> { welcome, goodbye, antilink, antiword, warns, filters }
  afk: null, // { since, reason } while the owner is away
  aiChats: {}, // chatJid -> true when the AI assistant is on in that chat
  aiGrants: {}, // chatJid -> { number: expiresAtMs } standing permission for AI actions
};

fs.mkdirSync(DIR, { recursive: true });

let db = { ...defaults };
try {
  db = { ...defaults, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  /* first run */
}

function saveNow() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('store save failed:', e.message);
  }
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 1500);
}

process.on('exit', saveNow);

module.exports = { db, save, saveNow, DIR, menuPath };
