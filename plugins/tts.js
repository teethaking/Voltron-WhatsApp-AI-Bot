const actions = require('../lib/actions');
const { getText } = require('../lib/utils');

module.exports = {
  commands: [
    {
      name: 'tts',
      aliases: ['say', 'speak'],
      desc: 'Text to speech voice note. Usage: .tts hello there  |  .tts fr: bonjour  |  reply to a message with .tts',
      async run(ctx) {
        let text = ctx.text;
        let lang = ctx.config.ttsLang;

        // optional language prefix like "fr:" or "pt-BR:"
        const m = text.match(/^([a-z]{2,3}(?:-[A-Za-z]{2,4})?):\s*/);
        if (m) {
          lang = m[1];
          text = text.slice(m[0].length);
        }
        if (!text && ctx.quoted) text = getText(ctx.quoted.message);
        if (!text.trim()) return ctx.reply(`Usage: ${ctx.config.prefix}tts <text>  (or reply to a message)`);

        await actions.tts(ctx.sock, ctx.jid, text, lang, ctx.msg);
      },
    },
  ],
};
