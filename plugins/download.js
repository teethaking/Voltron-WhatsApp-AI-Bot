const actions = require('../lib/actions');
const music = require('../lib/music');
const { findTrack } = music;
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

const SPOTIFY = /https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/\w+/i;
const meta = (html, prop) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'))?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

/** "Song Artist" for a Spotify track link, read from the public page (no API key needed). */
async function spotifyQuery(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
  if (!res.ok) throw new Error(`Spotify answered ${res.status}`);
  const html = await res.text();
  const title = meta(html, 'og:title');
  if (!title) throw new Error('Could not read that Spotify link.');
  const artist = (meta(html, 'og:description') || '').split(' · ')[0];
  return `${title} ${artist}`.trim();
}

module.exports = {
  commands: [
    {
      name: 'dl',
      aliases: ['video', 'download', 'yt', 'ytv', 'tiktok', 'tt', 'ig', 'insta', 'fb', 'twitter', 'x', 'reddit', 'pin', 'pinterest'],
      desc: 'Download a video from a link (YouTube, TikTok, Instagram, Facebook, X, Reddit...) or a YouTube search',
      async run(ctx) {
        const url = await resolveUrl(ctx);
        if (!url) return ctx.reply(`Usage: ${ctx.config.prefix}dl <link or video name>  (or reply to a message with a link)`);
        await ctx.reply('⬇️ Downloading...');
        await actions.downloadVideo(ctx.sock, ctx.jid, url, ctx.msg);
      },
    },
    {
      name: 'spotify',
      aliases: ['sp'],
      desc: 'Send a Spotify track as audio: .spotify <track link>',
      async run(ctx) {
        const link = (ctx.text.match(URL_RE) || [])[0] || (ctx.quoted && (getText(ctx.quoted.message).match(URL_RE) || [])[0]);
        if (!link || !SPOTIFY.test(link)) return ctx.reply(`Usage: ${ctx.config.prefix}spotify <open.spotify.com/track/... link>
(Albums and playlists are not supported, use ${ctx.config.prefix}play with a song name.)`);
        const q = await spotifyQuery(link.match(SPOTIFY)[0]);
        await ctx.reply(`🔎 Spotify track found: *${q}*. Fetching the audio...`);
        await music.playSong(ctx.sock, ctx.jid, q, ctx.msg, {});
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
