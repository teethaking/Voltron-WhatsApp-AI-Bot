const words = require('../words');
const { tag } = require('./engine');

const MAX_WRONG = 7;

const STAGES = [
  ['  +---+', '  |   |', '      |', '      |', '      |', '=========='],
  ['  +---+', '  |   |', '  O   |', '      |', '      |', '=========='],
  ['  +---+', '  |   |', '  O   |', '  |   |', '      |', '=========='],
  ['  +---+', '  |   |', '  O   |', ' /|   |', '      |', '=========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', '      |', '=========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' /    |', '=========='],
  ['  +---+', '  |   |', '  O   |', ' /|\\  |', ' / \\  |', '=========='],
  ['  +---+', '  |   |', '  X   |', ' /|\\  |', ' / \\  |', '=========='],
];

function render(g) {
  const shown = [...g.word].map((c) => (g.right.has(c) ? c.toUpperCase() : '_')).join(' ');
  const wrong = [...g.wrong].map((c) => c.toUpperCase()).join(' ') || '-';
  return (
    '```' + STAGES[g.wrong.size].join('\n') + '```\n' +
    `*${shown}*\n\n❌ Wrong (${g.wrong.size}/${MAX_WRONG}): ${wrong}`
  );
}

module.exports = {
  id: 'hangman',
  title: 'Hangman',
  desc: 'Guess the hidden word one letter at a time before the drawing is finished.',
  how: 'Type a single letter to guess it, or the whole word if you know it. Any number of players share the same board.',

  start(g) {
    g.word = words.pickBetween(5, 9);
    g.right = new Set();
    g.wrong = new Set();
    g.say(`🪢 *HANGMAN*\n\nThe word has *${g.word.length}* letters. Type a letter, or the full word, to guess!\n\n${render(g)}`);
  },

  onText(g, ctx, text) {
    const t = text.trim().toLowerCase();
    if (!/^[a-z]+$/.test(t)) return;

    // whole-word guess
    if (t.length === g.word.length && t.length > 1) {
      if (t === g.word) {
        const left = [...g.word].filter((c) => !g.right.has(c)).length;
        g.score(ctx.player, 5 + left * 2, true);
        g.say(`🎉 *${ctx.player.name} solved it!* ${tag(ctx.player)}\nThe word was *${g.word.toUpperCase()}*\n+${5 + left * 2} points`, [ctx.player.jid]);
        return g.end();
      }
      if (g.wrong.has(t)) return g.react(ctx.msg, '🔁');
      g.wrong.add(t); // a wrong full-word guess costs a life
      return afterWrong(g, ctx, `❌ *${t.toUpperCase()}* is not the word`);
    }
    if (t.length !== 1) return; // ignore normal chat

    if (g.right.has(t) || g.wrong.has(t)) return g.react(ctx.msg, '🔁');

    if (g.word.includes(t)) {
      g.right.add(t);
      const hits = [...g.word].filter((c) => c === t).length;
      g.score(ctx.player, hits * 2);
      if ([...g.word].every((c) => g.right.has(c))) {
        g.score(ctx.player, 10, true);
        g.say(`🎉 *${ctx.player.name} finished it!* ${tag(ctx.player)}\nThe word was *${g.word.toUpperCase()}* · +10 bonus`, [ctx.player.jid]);
        return g.end();
      }
      g.react(ctx.msg, '✅');
      return g.say(render(g));
    }
    g.wrong.add(t);
    afterWrong(g, ctx, null);
  },

  reveal(g) {
    return g.word.toUpperCase();
  },

  status(g) {
    return `${g.wrong.size}/${MAX_WRONG} wrong`;
  },
};

function afterWrong(g, ctx, note) {
  if (g.wrong.size >= MAX_WRONG) {
    g.say(`💀 *Game over!* The word was *${g.word.toUpperCase()}*\n\n${render(g)}`);
    return g.end();
  }
  g.say(`${note ? note + '\n\n' : ''}${render(g)}`);
}
