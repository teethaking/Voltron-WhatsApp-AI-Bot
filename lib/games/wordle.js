const words = require('../words');
const { tag } = require('./engine');

/** Standard Wordle colouring (handles repeated letters correctly). */
function colour(guess, answer) {
  const res = Array(guess.length).fill('⬛');
  const left = {};
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) res[i] = '🟩';
    else left[answer[i]] = (left[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < guess.length; i++) {
    if (res[i] !== '🟩' && left[guess[i]] > 0) {
      res[i] = '🟨';
      left[guess[i]]--;
    }
  }
  return res.join('');
}

function board(g) {
  const rows = g.guesses.map((x) => `${x.pattern}  *${x.word.toUpperCase()}*  ${x.name}`);
  const known = [...g.answer].map((c, i) => (g.greens[i] ? c.toUpperCase() : '_')).join(' ');
  const absent = [...g.absent].sort().join(' ').toUpperCase();
  return (
    rows.join('\n') +
    `\n\n🔤 ${known}` +
    (absent ? `\n🚫 Not in word: ${absent}` : '') +
    `\n🎟️ Guesses left: ${g.max - g.guesses.length}`
  );
}

module.exports = {
  id: 'wordle',
  title: 'Word Guess',
  desc: 'Everyone guesses the same hidden word. 🟩 right spot, 🟨 wrong spot, ⬛ not in the word.',
  how: 'Just type a word of the right length to guess. Start with *.wordle 6* for a 6-letter word (4 to 7). Any number of players share the guesses.',

  start(g, ctx, args) {
    const len = Math.min(7, Math.max(4, parseInt(args[0], 10) || 5));
    g.len = len;
    g.answer = words.pick(len);
    g.max = len + 4;
    g.guesses = [];
    g.absent = new Set();
    g.greens = Array(len).fill(false);
    g.say(
      `🟩 *WORD GUESS* 🟨\n\nI picked a *${len}-letter* word. Everyone can guess, just type a word!\n` +
        `🟩 right letter, right spot\n🟨 right letter, wrong spot\n⬛ not in the word\n\n` +
        `🎟️ ${g.max} guesses shared by the whole chat. Good luck!\n\n🔤 ${'_ '.repeat(len).trim()}`
    );
  },

  onText(g, ctx, text) {
    const word = text.trim().toLowerCase();
    if (word.length !== g.len || !/^[a-z]+$/.test(word)) return; // normal chat, ignore

    if (!words.isWord(word)) return g.react(ctx.msg, '❌');
    if (g.guesses.some((x) => x.word === word)) return g.react(ctx.msg, '🔁');

    const pattern = colour(word, g.answer);
    g.guesses.push({ word, pattern, name: ctx.player.name });
    for (let i = 0; i < word.length; i++) {
      if (word[i] === g.answer[i]) g.greens[i] = true;
      if (!g.answer.includes(word[i])) g.absent.add(word[i]);
    }

    if (word === g.answer) {
      g.score(ctx.player, 15, true);
      g.say(
        `🎉 *${ctx.player.name} got it!* ${tag(ctx.player)}\n\n${board(g)}\n\nThe word was *${g.answer.toUpperCase()}* · +15 points`,
        [ctx.player.jid]
      );
      return g.end();
    }
    if (g.guesses.length >= g.max) {
      g.say(`💀 Out of guesses! The word was *${g.answer.toUpperCase()}*.\n\n${board(g)}`);
      return g.end();
    }
    g.say(board(g));
  },

  reveal(g) {
    return g.answer.toUpperCase();
  },

  status(g) {
    return `${g.len} letters, ${g.guesses.length}/${g.max} guesses used`;
  },
};
