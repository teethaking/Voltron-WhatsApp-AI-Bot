const { makeSticker, toImage } = require('../lib/sticker');
const { findMedia, downloadMedia } = require('../lib/utils');

/** Find media on the message itself or on the message it replies to. */
function pickMedia(ctx) {
  return findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));
}

module.exports = {
  commands: [
    {
      name: 'sticker',
      aliases: ['s', 'stik'],
      desc: 'Reply to (or send with caption) an image/video/gif to make a sticker. Add "crop" for a square crop. Usage: .s [pack|author]',
      async run(ctx) {
        const media = pickMedia(ctx);
        if (!media || !['image', 'video', 'sticker'].includes(media.type)) {
          return ctx.reply('Reply to an image, short video or GIF with .s');
        }
        if (media.type === 'video' && (media.node.seconds || 0) > 20) {
          return ctx.reply('Video is too long. Keep it under 20 seconds.');
        }

        const crop = /\bcrop\b/i.test(ctx.text);
        const names = ctx.text.replace(/\bcrop\b/i, '').trim();
        const [pack, author] = names.includes('|') ? names.split('|').map((s) => s.trim()) : [];

        const sticker = await makeSticker(await downloadMedia(media), {
          kind: media.type,
          crop,
          pack: pack || ctx.config.stickerPack,
          author: author || ctx.config.stickerAuthor,
        });
        await ctx.sock.sendMessage(ctx.jid, { sticker }, { quoted: ctx.msg });
      },
    },
    {
      name: 'toimg',
      aliases: ['img', 'photo'],
      desc: 'Reply to a sticker to turn it into an image',
      async run(ctx) {
        const media = ctx.quoted && findMedia(ctx.quoted.message);
        if (!media || media.type !== 'sticker') return ctx.reply('Reply to a sticker with .toimg');
        const png = await toImage(await downloadMedia(media));
        await ctx.sock.sendMessage(ctx.jid, { image: png }, { quoted: ctx.msg });
      },
    },
  ],
};
