const { generateMessageIDV2 } = require('@whiskeysockets/baileys');
const sent = require('../lib/sent');
const utils = require('../lib/utils');
const store = require('../lib/store');
const msgcache = require('../lib/msgcache');

const { findMedia, isViewOnce } = utils;

/**
 * Re-send the same media without the view-once flag. This reuses the file WhatsApp already
 * holds (no download + re-upload), which is lighter and avoids malformed re-uploaded media
 * that some phones show as "Waiting for this message".
 */
async function copyMedia(sock, jid, media) {
  const node = { ...media.node, viewOnce: false, contextInfo: undefined };
  const id = generateMessageIDV2(sock.user?.id);
  sent.add(id); // so the bot ignores the echo of its own message
  await sock.relayMessage(jid, { [media.key]: node }, { messageId: id });
}

/** Fallback: download the media and upload it again. */
async function reuploadMedia(sock, jid, media, caption, opts = {}) {
  const buffer = await utils.downloadMedia(media);
  const base = caption ? { caption } : {};
  if (media.type === 'image') return sock.sendMessage(jid, { image: buffer, ...base }, opts);
  if (media.type === 'video') return sock.sendMessage(jid, { video: buffer, ...base }, opts);
  if (media.type === 'audio') {
    return sock.sendMessage(
      jid,
      { audio: buffer, mimetype: media.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.node.ptt },
      opts
    );
  }
  throw new Error('Unsupported media type');
}

/** Copy the media to `jid` (optionally with a label message first), falling back to re-upload. */
async function deliver(sock, jid, media, label, opts = {}) {
  try {
    if (label) await sock.sendMessage(jid, { text: label });
    await copyMedia(sock, jid, media);
  } catch (e) {
    console.error('view-once copy failed, re-uploading:', e.message);
    const caption = [label, media.node.caption].filter(Boolean).join('\n');
    await reuploadMedia(sock, jid, media, caption, opts);
  }
}

module.exports = {
  commands: [
    {
      name: 'vv',
      aliases: ['viewonce', 'save', 'reveal', 'retrieve'],
      desc: 'Reply to a view-once photo/video/voice note to save it in this chat. Use .vv me to send it to your own chat privately.',
      async run(ctx) {
        const target = ctx.quoted;
        const media = target && findMedia(target.message);
        if (!media) return ctx.reply('Reply to a view-once photo, video or voice note with .vv');

        const toMe = ctx.args[0] === 'me';
        const dest = toMe ? ctx.sock.user.id.replace(/:\d+/, '') : ctx.jid;
        await deliver(ctx.sock, dest, media, null, toMe ? {} : { quoted: ctx.msg });
        if (toMe && dest !== ctx.jid) await ctx.reply('Saved to your DM.');
      },
    },
    {
      name: 'reactsave',
      aliases: ['emojisave'],
      owner: true,
      desc: 'Turn emoji-reaction saving on/off. React to a photo, video, voice note, view-once or status with a save emoji to get it in your DM.',
      async run(ctx) {
        const arg = (ctx.args[0] || '').toLowerCase();
        if (arg === 'on' || arg === 'off') {
          store.db.reactSave = arg === 'on';
          store.save();
        }
        return ctx.reply(`Emoji saving is *${store.db.reactSave ? 'ON' : 'OFF'}*.\nSave emojis: ${store.db.saveEmojis.join(' ')}\nChange them with ${ctx.config.prefix}setreact 😍 🔥 💾`);
      },
    },
    {
      name: 'setreact',
      owner: true,
      desc: 'Choose which emojis save media when you react with them. Example: .setreact 😍 🔥 💾',
      async run(ctx) {
        const emojis = [...new Set(ctx.text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu) || [])];
        if (!emojis.length) return ctx.reply(`Give me one or more emojis, e.g. ${ctx.config.prefix}setreact 😍 🔥 💾`);
        store.db.saveEmojis = emojis.slice(0, 10);
        store.save();
        return ctx.reply(`Done. Reacting with ${store.db.saveEmojis.join(' ')} now saves media to your DM.`);
      },
    },
  ],

  /**
   * Emoji save: the owner (or a sudo user) reacts to any photo / video / voice note / status with
   * one of the save emojis and the file lands in the owner's DM. Works on view-once too.
   */
  async onReaction(ev) {
    const norm = (e) => e.replace(/\uFE0F/g, '');
    if (!store.db.reactSave || !store.db.saveEmojis.some((e) => norm(e) === norm(ev.emoji))) return;
    const target = msgcache.get(ev.target.remoteJid, ev.target.id);
    const media = target && findMedia(target.message);
    if (!media || media.type === 'sticker') return;

    const me = ev.sock.user.id.replace(/:\d+/, '');
    const isStatus = ev.target.remoteJid === 'status@broadcast';
    const from = (target.key.participant || target.key.remoteJid || '').split('@')[0].split(':')[0];
    const where = isStatus ? 'status' : ev.target.remoteJid.endsWith('@g.us') ? 'a group' : 'a chat';
    const label = `${isViewOnce(target.message) ? 'View-once' : 'Saved'} ${media.type} from ${target.key.fromMe ? 'you' : '+' + from} (${where})`;
    try {
      await deliver(ev.sock, me, media, label);
    } catch (e) {
      await ev.sock.sendMessage(me, { text: `Could not save that ${media.type}: ${e.message.split('\n')[0]}` });
    }
  },

  /** Optional auto-save: forward every incoming view-once to your own chat. */
  async onMessage(ctx) {
    if (!ctx.config.autoSaveViewOnce || ctx.fromMe) return;
    if (!isViewOnce(ctx.msg.message)) return;

    const media = findMedia(ctx.msg.message);
    if (!media) return;

    const me = ctx.sock.user.id.replace(/:\d+/, '');
    const from = ctx.sender.split('@')[0];
    const label = `View-once from +${from}${ctx.isGroup ? ' (in a group)' : ''}`;
    await deliver(ctx.sock, me, media, label);
  },
};
