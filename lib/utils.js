const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  downloadContentFromMessage,
  normalizeMessageContent,
} = require('@whiskeysockets/baileys');

const TMP = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  stickerMessage: 'sticker',
  documentMessage: 'document',
};

/** Unwrap ephemeral / view-once / edited wrappers into the real content. */
function unwrap(message) {
  return normalizeMessageContent(message) || {};
}

/** Returns { key, node, type } for the first media node in a message, or null. */
function findMedia(message) {
  const content = unwrap(message);
  for (const key of Object.keys(MEDIA_TYPES)) {
    if (content[key]) return { key, node: content[key], type: MEDIA_TYPES[key] };
  }
  return null;
}

/** Is this message (or wrapper) a view-once message? */
function isViewOnce(message) {
  if (!message) return false;
  if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) {
    return true;
  }
  const media = findMedia(message);
  return !!(media && media.node.viewOnce);
}

/** Download a media node into a Buffer. */
async function downloadMedia(media) {
  const stream = await downloadContentFromMessage(media.node, media.type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Text of a message (conversation, extended text, or media caption). */
function getText(message) {
  const c = unwrap(message);
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    ''
  );
}

/** The message being replied to, as a plain message object (or null). */
function getQuoted(message) {
  const c = unwrap(message);
  const ctx =
    c.extendedTextMessage?.contextInfo ||
    c.imageMessage?.contextInfo ||
    c.videoMessage?.contextInfo ||
    c.audioMessage?.contextInfo ||
    c.stickerMessage?.contextInfo ||
    null;
  if (!ctx?.quotedMessage) return null;
  return { message: ctx.quotedMessage, participant: ctx.participant, stanzaId: ctx.stanzaId };
}

/** Run a binary and resolve with stdout. */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 1024 * 1024 * 20, timeout: opts.timeout || 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = String(stdout || '');
          if (err.code === 'ENOENT') err.message = `${bin} is not installed on the server.`;
          else {
            // surface yt-dlp / ffmpeg's own last error line instead of the whole command line
            const line = (stderr || '').trim().split('\n').filter(Boolean).pop();
            if (line) err.message = line.replace(/^ERROR:\s*/, '');
          }
          return reject(err);
        }
        resolve(stdout.toString());
      }
    );
  });
}

function tmpName(ext) {
  return path.join(TMP, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

function cleanup(...files) {
  for (const f of files) fs.promises.unlink(f).catch(() => {});
}

const URL_RE = /https?:\/\/[^\s]+/i;

/** The owner's DM: OWNER_NUMBER if set, otherwise the linked account itself. */
function ownerJid(sock) {
  const me = (sock.user?.id || '').split('@')[0].split(':')[0];
  return `${require('../config').ownerNumber || me}@s.whatsapp.net`;
}

module.exports = {
  TMP,
  unwrap,
  findMedia,
  isViewOnce,
  downloadMedia,
  getText,
  getQuoted,
  run,
  tmpName,
  cleanup,
  URL_RE,
  ownerJid,
};
