const music = require('../lib/music');
const { getText } = require('../lib/utils');

/** Song name from the command text, or from the message being replied to. */
function queryOf(ctx) {
  const own = ctx.text.trim();
  if (own) return own;
  return ctx.quoted ? getText(ctx.quoted.message).trim().slice(0, 200) : '';
}

const playCmd = (name, aliases, desc, opts) => ({
  name,
  aliases,
  desc,
  async run(ctx) {
    const q = queryOf(ctx);
    if (!q) {
      return ctx.reply(
        `🎵 Usage: *${ctx.config.prefix}${name} <song name>*\n` +
          `Examples:\n• ${ctx.config.prefix}${name} calm down rema\n• ${ctx.config.prefix}${name} https://youtu.be/...`
      );
    }
    await ctx.reply(`🔎 Searching for *${q}*...`);
    await music.playSong(ctx.sock, ctx.jid, q, ctx.msg, opts);
  },
});

module.exports = {
  commands: [
    playCmd('play', ['song', 'music', 'p'], 'Play any song by name or link, sent as audio. Usage: .play <song>', {}),
    playCmd('playdoc', ['songdoc', 'pdoc'], 'Same as .play but sends the mp3 as a file (keeps it in your downloads)', { asDocument: true }),
    {
      name: 'yts',
      aliases: ['ytsearch', 'search'],
      desc: 'Search YouTube and list the top results. Usage: .yts <query>',
      async run(ctx) {
        const q = queryOf(ctx);
        if (!q) return ctx.reply(`Usage: ${ctx.config.prefix}yts <what to search>`);
        const hits = (await music.search(q, 8)).filter((v) => v.seconds > 0);
        if (!hits.length) return ctx.reply(`No results for *${q}*.`);
        const p = ctx.config.prefix;
        const rows = hits.map(
          (v, i) =>
            `*${i + 1}. ${v.title}*\n` +
            `   👤 ${v.author || 'unknown'} · ⏱️ ${music.fmtTime(v.seconds)} · 👁️ ${music.fmtViews(v.views)}\n` +
            `   🔗 ${v.url}`
        );
        return ctx.reply(
          `╭──『 🔎 *ʏᴏᴜᴛᴜʙᴇ sᴇᴀʀᴄʜ* 』\n│ _${q}_\n╰────────────\n\n${rows.join('\n\n')}\n\n` +
            `_${p}play <link> for the audio · ${p}dl <link> for the video_`
        );
      },
    },
    {
      name: 'lyrics',
      aliases: ['lyric', 'ly'],
      desc: 'Get the lyrics of a song. Usage: .lyrics <artist - title>',
      async run(ctx) {
        const q = queryOf(ctx);
        if (!q) return ctx.reply(`Usage: ${ctx.config.prefix}lyrics <artist - title>`);
        const hit = await music.lyrics(q);
        if (!hit) return ctx.reply(`😕 No lyrics found for *${q}*. Try "artist - title".`);
        let body = hit.plainLyrics.trim();
        if (body.length > 3500) body = body.slice(0, 3500) + '\n...';
        return ctx.reply(
          `╭──『 📝 *ʟʏʀɪᴄs* 』\n│ 🎵 *${hit.trackName}*\n│ 👤 ${hit.artistName}${hit.albumName ? `\n│ 💿 ${hit.albumName}` : ''}\n╰────────────\n\n${body}`
        );
      },
    },
  ],
};
