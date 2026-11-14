const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../lib/store');
const utils = require('../lib/utils');
const { num } = require('../lib/group');

/**
 * Anti-delete / anti-edit. WhatsApp does not keep deleted or old versions of messages, so the
 * bot remembers what it sees (text in memory, small media on disk) while either feature is on.
 * Only messages the bot saw AFTER the feature was switched on can be recovered.
 */

const CACHE_DIR = path.join(utils.TMP, 'anti');
fs.rmSync(CACHE_DIR, { recursive: true, force: true }); // cache never survives a restart
fs.mkdirSync(CACHE_DIR, { recursive: true });

const MAX_MESSAGES = 1500;
const MAX_MEDIA_FILES = 100;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const cache = new Map(); // message id -> entry (insertion order = age)
const mediaIds = [];
const groupNames = new Map();

const enabled = () => store.db.antiDelete || store.db.antiEdit;

function dropEntry(id) {
  const e = cache.get(id);
  if (e?.file) fs.promises.unlink(e.file).catch(() => {});
  cache.delete(id);
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, e] of cache) {
    if (cache.size <= MAX_MESSAGES && e.ts > cutoff) break; // oldest first, so we can stop here
    dropEntry(id);
  }
  while (mediaIds.length > MAX_MEDIA_FILES) {
    const old = cache.get(mediaIds.shift());
    if (old?.file) {
      fs.promises.unlink(old.file).catch(() => {});
      old.file = null;
    }
  }
}

function remember(ctx) {
  const msg = ctx.msg;
  const text = utils.getText(msg.message);
  const media = utils.findMedia(msg.message);
  const viewOnce = utils.isViewOnce(msg.message);
  if (!text && (!media || viewOnce)) return; // never keep view-once media here

  const entry = {
    id: msg.key.id,
    chat: ctx.jid,
    sender: ctx.sender,
    name: msg.pushName || '',
    ts: Date.now(),
    text,
    isGroup: ctx.isGroup,
  };

  if (media && !viewOnce) {
    entry.mediaType = media.type;
    entry.mimetype = media.node.mimetype;
    entry.fileName = media.node.fileName;
    entry.ptt = !!media.node.ptt;
    entry.gif = !!media.node.gifPlayback;
    if (Number(media.node.fileLength || 0) <= MAX_MEDIA_BYTES) {
      entry.ready = utils
        .downloadMedia(media)
        .then((buf) => {
          if (!cache.has(entry.id)) return;
          entry.file = path.join(CACHE_DIR, entry.id.replace(/[^\w-]/g, '_'));
          fs.writeFileSync(entry.file, buf);
          mediaIds.push(entry.id);
          prune();
        })
        .catch(() => {});
    }
  }

  cache.set(entry.id, entry);
  prune();
}

async function describeChat(ctx, entry) {
  if (!entry.isGroup) return 'private chat';
  if (!groupNames.has(entry.chat)) {
    try {
      groupNames.set(entry.chat, (await ctx.sock.groupMetadata(entry.chat)).subject);
    } catch {
      groupNames.set(entry.chat, 'a group');
    }
  }
  return `group "${groupNames.get(entry.chat)}"`;
}

const when = (ts) =>
  new Date(ts).toLocaleString('en-GB', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'medium' });

/** Send a text or media message to the owner's DM. */
async function deliver(ctx, entry, header, body) {
  const to = utils.ownerJid(ctx.sock);
  const mentions = [entry.sender];

  if (entry.ready) await entry.ready;
  if (entry.mediaType && entry.file && fs.existsSync(entry.file)) {
    const buf = fs.readFileSync(entry.file);
    const caption = [header, body].filter(Boolean).join('\n\n');
    const t = entry.mediaType;
    if (t === 'image') return ctx.sock.sendMessage(to, { image: buf, caption, mentions });
    if (t === 'video') return ctx.sock.sendMessage(to, { video: buf, caption, mentions, gifPlayback: entry.gif });
    if (t === 'document') {
      return ctx.sock.sendMessage(to, {
        document: buf,
        mimetype: entry.mimetype || 'application/octet-stream',
        fileName: entry.fileName || 'file',
        caption,
        mentions,
      });
    }
    // audio and stickers cannot carry a caption: header first, then the file
    await ctx.sock.sendMessage(to, { text: caption, mentions });
    if (t === 'audio') return ctx.sock.sendMessage(to, { audio: buf, mimetype: entry.mimetype || 'audio/ogg; codecs=opus', ptt: entry.ptt });
    if (t === 'sticker') return ctx.sock.sendMessage(to, { sticker: buf });
    return;
  }

  const note = entry.mediaType ? `\n\n(${entry.mediaType} could not be recovered)` : '';
  return ctx.sock.sendMessage(to, { text: [header, body].filter(Boolean).join('\n\n') + note, mentions });
}

function headerFor(title, entry, chatLabel, extra = '') {
  const who = entry.name ? `@${num(entry.sender)} (${entry.name})` : `@${num(entry.sender)}`;
  return `*${title}*\nFrom: ${who}\nChat: ${chatLabel}\nSent: ${when(entry.ts)}${extra}`;
}

async function onRevoke(ctx, targetId) {
  const entry = cache.get(targetId);
  if (!entry) return; // we never saw it, nothing to recover
  const chatLabel = await describeChat(ctx, entry);
  const deletedBy = ctx.sender && num(ctx.sender) !== num(entry.sender) ? `\nDeleted by: @${num(ctx.sender)}` : '';
  const header = headerFor('Deleted message', entry, chatLabel, deletedBy);
  await deliver(ctx, entry, header, entry.text);
  dropEntry(targetId);
}

async function onEdit(ctx, pm) {
  const targetId = pm.key?.id;
  const newText = utils.getText(pm.editedMessage || {});
  if (!targetId || !newText) return;

  const entry = cache.get(targetId);
  if (entry && entry.text === newText) return; // link-preview refresh, not a real edit

  const base = entry || { id: targetId, chat: ctx.jid, sender: ctx.sender, name: ctx.msg.pushName || '', ts: Date.now(), isGroup: ctx.isGroup };
  const chatLabel = await describeChat(ctx, base);
  const header = headerFor('Edited message', base, chatLabel);
  const before = entry ? entry.text || '(no text)' : '(not seen before the edit)';
  const to = utils.ownerJid(ctx.sock);
  await ctx.sock.sendMessage(to, {
    text: `${header}\n\n*Before:*\n${before}\n\n*After:*\n${newText}`,
    mentions: [base.sender],
  });
  if (entry) entry.text = newText; // next edit compares against this version
}

const toggle = (key, label, what) => ({
  async run(ctx) {
    const sub = (ctx.args[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      store.db[key] = sub === 'on';
      store.saveNow();
      return ctx.reply(
        store.db[key]
          ? `${label} is ON. ${what} will be sent to your DM. It can only recover messages I see from now on.`
          : `${label} is OFF.`
      );
    }
    await ctx.reply(`${label} is ${store.db[key] ? 'ON' : 'OFF'}.\nUsage: ${ctx.config.prefix}${ctx.command} on | off`);
  },
});

module.exports = {
  async onMessage(ctx) {
    if (!enabled() || ctx.fromMe) return;

    const pm = ctx.content.protocolMessage;
    if (pm) {
      const type = pm.type ?? 0;
      const isRevoke = type === 0 || type === 'REVOKE';
      const isEdit = type === 14 || type === 'MESSAGE_EDIT' || !!pm.editedMessage;
      if (isRevoke && store.db.antiDelete) await onRevoke(ctx, pm.key?.id);
      else if (isEdit && store.db.antiEdit) await onEdit(ctx, pm);
      return;
    }
    remember(ctx);
  },

  commands: [
    {
      name: 'antidelete',
      aliases: ['antidel'],
      owner: true,
      cat: 'Privacy',
      desc: 'Send messages people delete (text, photos, videos, voice notes...) to your DM: .antidelete on / off',
      async run(ctx) {
        ctx.command = 'antidelete';
        return toggle('antiDelete', 'Anti-delete', 'Deleted messages').run(ctx);
      },
    },
    {
      name: 'antiedit',
      owner: true,
      cat: 'Privacy',
      desc: 'Send the before and after of messages people edit to your DM: .antiedit on / off',
      async run(ctx) {
        ctx.command = 'antiedit';
        return toggle('antiEdit', 'Anti-edit', 'Edited messages (before and after)').run(ctx);
      },
    },
  ],
};
