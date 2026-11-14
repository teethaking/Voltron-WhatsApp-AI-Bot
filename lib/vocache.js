/**
 * Downloads every incoming view-once photo/video/voice note the moment it arrives and keeps the file on disk.
 * WhatsApp deletes the file from its servers once the phone opens it, so fetching it later (on .vv or an
 * emoji reaction) often fails. Having our own copy makes saving reliable.
 */
const fs = require('fs');
const path = require('path');
const { findMedia, downloadMedia } = require('./utils');

const DIR = path.join(__dirname, '..', 'data', 'vo');
const INDEX = path.join(DIR, 'index.json');
const MAX = 40;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 30 * 1024 * 1024;
const map = new Map(); // id -> { file, type, key, node: { mimetype, caption, ptt }, ts }

fs.mkdirSync(DIR, { recursive: true });

const persist = () => {
  try {
    fs.writeFileSync(INDEX, JSON.stringify([...map].map(([id, e]) => [id, { ...e, file: path.basename(e.file) }])));
  } catch (e) {
    console.error('could not save view-once index:', e.message);
  }
};

// survive restarts: reload what was saved before, forget anything missing or too old
try {
  for (const [id, e] of JSON.parse(fs.readFileSync(INDEX, 'utf8'))) {
    const file = path.join(DIR, e.file);
    if (Date.now() - e.ts < MAX_AGE_MS && fs.existsSync(file)) map.set(id, { ...e, file });
  }
} catch {
  /* nothing saved yet */
}
for (const f of fs.readdirSync(DIR)) {
  if (f !== 'index.json' && ![...map.values()].some((e) => path.basename(e.file) === f)) fs.rmSync(path.join(DIR, f), { force: true });
}

function drop(id) {
  const e = map.get(id);
  if (!e) return;
  map.delete(id);
  fs.promises.unlink(e.file).catch(() => {});
}

function trim() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, e] of map) if (e.ts < cutoff) drop(id);
  while (map.size > MAX) drop(map.keys().next().value);
  persist();
}

/** Download and keep the media of an incoming view-once message. */
async function save(msg) {
  const id = msg?.key?.id;
  const media = msg?.message && findMedia(msg.message);
  if (!id || !media || media.type === 'sticker' || map.has(id)) return false;
  if (!media.node.mediaKey?.length) throw new Error('view-once arrived without its media key');
  const buffer = await downloadMedia(media);
  if (!buffer.length || buffer.length > MAX_BYTES) return false;
  const file = path.join(DIR, `${id.replace(/[^\w-]/g, '_')}.bin`);
  await fs.promises.writeFile(file, buffer);
  const { mimetype, caption, ptt } = media.node;
  map.set(id, { file, type: media.type, key: media.key, node: { mimetype, caption, ptt }, ts: Date.now() });
  trim();
  return true;
}

/** Cached entry shaped like a media object, plus `.file` and `.id`. */
function get(id) {
  const e = map.get(id);
  return e ? { ...e, id } : null;
}

const read = (id) => (map.has(id) ? fs.promises.readFile(map.get(id).file).catch(() => null) : Promise.resolve(null));

module.exports = { save, get, read };
