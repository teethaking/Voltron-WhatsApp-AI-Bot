const actions = require('../lib/actions');
const { findTrack } = require('../lib/music');
const { URL_RE, getText } = require('../lib/utils');

function findUrl(ctx) {
  const own = ctx.text.match(URL_RE);
  if (own) return own[0];
  if (ctx.quoted) {
    const q = getText(ctx.quoted.message).match(URL_RE);
    if (q) return q[0];
  }
  return null;
}

/** A link from the message, or the top YouTube hit when the user typed a name instead. */
async function resolveUrl(ctx) {
  const url = findUrl(ctx);
  if (url || !ctx.text.trim()) return url;
  const hit = await findTrack(ctx.text.trim());
  if (!hit) throw new Error(`No results for "${ctx.text.trim()}".`);
  await ctx.reply(`🎬 Found *${hit.title}*\n🔗 ${hit.url}`);
  return hit.url;
}

module.exports = {
  commands: [
    {
      name: 'dl',
      aliases: ['video', 'download', 'yt', 'ytv', 'tiktok', 'tt', 'ig', 'insta', 'fb', 'twitter', 'x'],
      desc: 'Download a video from a link (YouTube, TikTok, Instagram, Facebook, X, Reddit...) or a YouTube search',
      async run(ctx) {
        const url = await resolveUrl(ctx);
        if (!url) return ctx.reply(`Usage: ${ctx.config.prefix}dl <link or video name>  (or reply to a message with a link)`);
        await ctx.reply('⬇️ Downloading...');
        await actions.downloadVideo(ctx.sock, ctx.jid, url, ctx.msg);
      },
    },
    {
      name: 'audio',
      aliases: ['mp3', 'yta'],
      desc: 'Download just the audio of a link (or a YouTube search) as mp3',
      async run(ctx) {
        const url = await resolveUrl(ctx);
        if (!url) return ctx.reply(`Usage: ${ctx.config.prefix}audio <link or song name>`);
        await ctx.reply('🎧 Extracting audio...');
        await actions.downloadAudio(ctx.sock, ctx.jid, url, ctx.msg);
      },
    },
  ],
};
