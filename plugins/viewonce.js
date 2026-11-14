const { generateMessageIDV2 } = require('@whiskeysockets/baileys');
const sent = require('../lib/sent');
const utils = require('../lib/utils');
const store = require('../lib/store');
const msgcache = require('../lib/msgcache');
const vocache = require('../lib/vocache');

const { findMedia, isViewOnce } = utils;

const EXPIRED_HINT = 'WhatsApp may have already deleted the file, view-once media expires quickly';

/** Fallback: relay the file WhatsApp already holds without the view-once flag (no download needed). */
async function copyMedia(sock, jid, media) {
  const node = { ...media.node, viewOnce: false, contextInfo: undefined };
  const id = generateMessageIDV2(sock.user?.id);
  sent.add(id); // so the bot ignores the echo of its own message
  await sock.relayMessage(jid, { [media.key]: node }, { messageId: id });
}

/** Send the media as a normal message (optionally after a label). Re-upload first, server-side copy as backup. */
async function deliver(sock, jid, media, label, opts = {}) {
  const saved = media.id ? await vocache.read(media.id) : null;
  if (!saved && !media.node.mediaKey?.length) {
    throw new Error('I never received that file. The bot must be online and linked when the view-once arrives (send it again, then reply .vv)');
  }
  let labelSent = false;
  const sendLabel = async () => {
    if (label && !labelSent) {
      labelSent = true;
      await sock.sendMessage(jid, { text: label });
    }
  };
  try {
    const buffer = saved || (await utils.downloadMedia(media));
    if (!buffer.length) throw new Error('the downloaded file is empty');
    await sendLabel();
    const caption = media.node.caption ? { caption: media.node.caption } : {};
    if (media.type === 'image') return await sock.sendMessage(jid, { image: buffer, ...caption }, opts);
    if (media.type === 'video') return await sock.sendMessage(jid, { video: buffer, ...caption }, opts);
    if (media.type === 'audio') {
      const audio = { audio: buffer, mimetype: media.node.mimetype || 'audio/ogg; codecs=opus', ptt: !!media.node.ptt };
      return await sock.sendMessage(jid, audio, opts);
    }
    throw new Error('unsupported media type');
  } catch (e) {
    console.error('view-once re-upload failed, trying a server-side copy:', e.message);
    try {
      await sendLabel();
      await copyMedia(sock, jid, media);
    } catch (e2) {
      console.error('view-once copy failed:', e2.message);
      throw new Error(`${String(e.message).split('\n')[0]} (${EXPIRED_HINT})`);
    }
  }
}

/** The best copy of a replied-to message: the cached original (has the media key) beats WhatsApp's stripped quote. */
function resolveQuoted(ctx) {
  const q = ctx.quoted;
  if (!q) return null;
  const own = q.stanzaId && vocache.get(q.stanzaId);
  if (own) return own;
  const cached = q.stanzaId && (msgcache.get(ctx.jid, q.stanzaId) || msgcache.find(q.stanzaId));
  const original = cached?.message && findMedia(cached.message);
  if (original?.node.mediaKey?.length) return { ...original, id: q.stanzaId };
  const stripped = findMedia(q.message);
  return stripped && { ...stripped, id: q.stanzaId };
}

module.exports = {
  commands: [
    {
      name: 'vv',
      aliases: ['viewonce', 'save', 'reveal', 'retrieve'],
      desc: 'Reply to a view-once photo/video/voice note to save it in this chat. Use .vv me to send it to your own chat privately.',
      async run(ctx) {
        const media = resolveQuoted(ctx);
        if (!media) return ctx.reply('Reply to a view-once photo, video or voice note with .vv');

        const toMe = ctx.args[0] === 'me';
        const dest = toMe ? ctx.sock.user.id.replace(/:\d+/, '') : ctx.jid;
        try {
          await deliver(ctx.sock, dest, media, null, toMe ? {} : { quoted: ctx.msg });
        } catch (e) {
          return ctx.reply(`Could not save that ${media.type}: ${e.message}`);
        }
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

    // The chat id in a reaction can differ from the stored one (phone number vs LID), so fall back to the id alone.
    const target = msgcache.get(ev.target.remoteJid, ev.target.id) || msgcache.find(ev.target.id);
    const own = vocache.get(ev.target.id);
    const found = target?.message && findMedia(target.message);
    const media = own || (found && { ...found, id: ev.target.id });
    if (!media || media.type === 'sticker') {
      if (!target) console.log(`emoji save: message ${ev.target.id} is not in the cache (arrived before the bot started, or too long ago)`);
      return;
    }

    const me = ev.sock.user.id.replace(/:\d+/, '');
    const isStatus = ev.target.remoteJid === 'status@broadcast';
    if (!target) return ev.sock.sendMessage(ev.sock.user.id.replace(/:d+/, ''), { text: `Could not save that ${media.type}: the original message is gone from memory.` });
    const from = (target.key.participant || target.key.remoteJid || '').split('@')[0].split(':')[0];
    const where = isStatus ? 'status' : ev.target.remoteJid.endsWith('@g.us') ? 'a group' : 'a chat';
    const label = `${isViewOnce(target.message) ? 'View-once' : 'Saved'} ${media.type} from ${target.key.fromMe ? 'you' : '+' + from} (${where})`;
    try {
      await deliver(ev.sock, me, media, label);
    } catch (e) {
      await ev.sock.sendMessage(me, { text: `Could not save that ${media.type}: ${e.message}` });
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
    try {
      await deliver(ctx.sock, me, { ...media, id: ctx.msg.key.id }, label);
    } catch (e) {
      console.error('auto-save view-once failed:', e.message);
    }
  },
};
