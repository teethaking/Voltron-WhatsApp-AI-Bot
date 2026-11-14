const fs = require('fs');
const { makeSticker, toVideo } = require('../lib/sticker');
const { findMedia, downloadMedia, run, tmpName, cleanup } = require('../lib/utils');

const pick = (ctx) => findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));

/** Download the replied audio/video, run ffmpeg with `args(in,out)`, return the output buffer. */
async function ffmpeg(media, outExt, args) {
  const input = tmpName(media.type === 'audio' ? 'ogg' : 'mp4');
  const output = tmpName(outExt);
  try {
    fs.writeFileSync(input, await downloadMedia(media));
    await run('ffmpeg', ['-y', '-i', input, ...args, output], { timeout: 3 * 60 * 1000 });
    return fs.readFileSync(output);
  } finally {
    cleanup(input, output);
  }
}

const needAudio = (ctx) => {
  const m = pick(ctx);
  if (!m || !['audio', 'video'].includes(m.type)) {
    ctx.reply('Reply to a voice note, audio or video with this command.');
    return null;
  }
  return m;
};

const effect = (name, desc, filter) => ({
  name,
  desc,
  async run(ctx) {
    const m = needAudio(ctx);
    if (!m) return;
    const out = await ffmpeg(m, 'mp3', ['-vn', '-af', filter, '-c:a', 'libmp3lame', '-b:a', '128k']);
    await ctx.sock.sendMessage(ctx.jid, { audio: out, mimetype: 'audio/mpeg' }, { quoted: ctx.msg });
  },
});

module.exports = {
  commands: [
    {
      name: 'tomp3',
      aliases: ['toaudio', 'extract'],
      desc: 'Turn a video or voice note into an mp3 audio file',
      async run(ctx) {
        const m = needAudio(ctx);
        if (!m) return;
        const out = await ffmpeg(m, 'mp3', ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k']);
        await ctx.sock.sendMessage(ctx.jid, { audio: out, mimetype: 'audio/mpeg' }, { quoted: ctx.msg });
      },
    },
    {
      name: 'voice',
      aliases: ['ptt', 'tovoice'],
      desc: 'Turn audio / video into a voice note',
      async run(ctx) {
        const m = needAudio(ctx);
        if (!m) return;
        const out = await ffmpeg(m, 'ogg', ['-vn', '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1']);
        await ctx.sock.sendMessage(ctx.jid, { audio: out, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: ctx.msg });
      },
    },
    effect('bass', 'Boost the bass of an audio / voice note', 'bass=g=14,volume=1.5'),
    effect('fast', 'Speed an audio up', 'atempo=1.5'),
    effect('slow', 'Slow an audio down', 'atempo=0.75'),
    effect('nightcore', 'Nightcore (faster and higher)', 'asetrate=44100*1.25,aresample=44100'),
    effect('reverse', 'Play an audio backwards', 'areverse'),
    effect('echo', 'Add an echo to an audio', 'aecho=0.8:0.88:60:0.4'),
    {
      name: 'tovideo',
      aliases: ['mp4', 'togif'],
      desc: 'Turn an animated sticker or GIF into a video',
      async run(ctx) {
        const m = pick(ctx);
        if (!m || !['sticker', 'video'].includes(m.type)) return ctx.reply('Reply to an animated sticker with .tovideo');
        const buf = await downloadMedia(m);
        const video = m.type === 'sticker' ? await toVideo(buf) : buf;
        await ctx.sock.sendMessage(ctx.jid, { video, gifPlayback: true }, { quoted: ctx.msg });
      },
    },
    {
      name: 'take',
      aliases: ['steal', 'wm'],
      desc: 'Re-pack a sticker with your own name: reply to a sticker with .take Pack | Author',
      async run(ctx) {
        const m = ctx.quoted && findMedia(ctx.quoted.message);
        if (!m || m.type !== 'sticker') return ctx.reply('Reply to a sticker with .take Pack | Author');
        const [pack, author] = ctx.text.includes('|') ? ctx.text.split('|').map((s) => s.trim()) : [ctx.text.trim(), ''];
        const sticker = await makeSticker(await downloadMedia(m), {
          kind: 'sticker',
          pack: pack || ctx.config.stickerPack,
          author: author || ctx.config.stickerAuthor,
        });
        await ctx.sock.sendMessage(ctx.jid, { sticker }, { quoted: ctx.msg });
      },
    },
  ],
};
