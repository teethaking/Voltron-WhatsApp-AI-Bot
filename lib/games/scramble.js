const words = require('../words');
const { tag, podium } = require('./engine');

const ROUND_MS = 30_000;
const HINT_MS = 15_000;
const BETWEEN_MS = 3_000;

const sortLetters = (w) => [...w].sort().join('');

function scramble(word) {
  let s = word;
  for (let i = 0; i < 10 && s === word; i++) s = words.shuffle([...word]).join('');
  return s;
}

function startRound(g) {
  g.round += 1;
  g.word = words.pickBetween(5, 8);
  g.scrambled = scramble(g.word);
  g.hinted = false;
  g.open = true;
  g.say(
    `🔀 *Round ${g.round}/${g.rounds}*\n\nUnscramble this word:\n\n*${[...g.scrambled].join(' ').toUpperCase()}*\n\n` +
      `First to type it wins! ⏱️ ${ROUND_MS / 1000}s`
  );
  g.hintTimer = g.later(() => {
    g.hinted = true;
    g.say(`💡 Hint: starts with *${g.word[0].toUpperCase()}* and has ${g.word.length} letters`);
  }, HINT_MS);
  g.roundTimer = g.later(() => {
    g.open = false;
    g.say(`⌛ Time's up! The word was *${g.word.toUpperCase()}*`);
    advance(g);
  }, ROUND_MS);
}

function advance(g) {
  if (g.round >= g.rounds) return finish(g);
  g.later(() => startRound(g), BETWEEN_MS);
}

function finish(g) {
  const rows = [...g.points.values()].sort((a, b) => b.pts - a.pts);
  if (!rows.length) {
    g.say('🏁 Game over! Nobody scored this time.');
  } else {
    const winner = rows[0];
    g.score(winner.player, 10, true);
    g.say(`🏁 *Scramble finished!*\n\n${podium(rows)}\n\n🏆 ${tag(winner.player)} wins! (+10 bonus)`, [winner.player.jid]);
  }
  g.end();
}

module.exports = {
  id: 'scramble',
  title: 'Word Scramble',
  desc: 'Race to unscramble the word. Fastest wins the round.',
  how: 'Type the unscrambled word. Start with *.scramble 10* for 10 rounds (1 to 20). Any number of players.',

  start(g, ctx, args) {
    g.rounds = Math.min(20, Math.max(1, parseInt(args[0], 10) || 5));
    g.round = 0;
    g.points = new Map();
    g.say(`🔀 *WORD SCRAMBLE* — ${g.rounds} rounds. Get ready...`);
    g.later(() => startRound(g), 2000);
  },

  onText(g, ctx, text) {
    if (!g.open) return;
    const t = text.trim().toLowerCase();
    if (!/^[a-z]+$/.test(t) || t.length !== g.word.length) return;
    // any real anagram counts (e.g. "melon" and "lemon")
    if (!(t === g.word || (sortLetters(t) === sortLetters(g.word) && words.isWord(t)))) return;

    g.open = false;
    g.cancel(g.roundTimer);
    g.cancel(g.hintTimer);
    const pts = g.hinted ? 3 : 5;
    const row = g.points.get(ctx.player.jid) || { player: ctx.player, name: ctx.player.name, pts: 0 };
    row.pts += pts;
    g.points.set(ctx.player.jid, row);
    g.score(ctx.player, pts);
    g.react(ctx.msg, '🎉');
    g.say(`✅ ${tag(ctx.player)} got it: *${t.toUpperCase()}* (+${pts})`, [ctx.player.jid]);
    advance(g);
  },

  status(g) {
    return `round ${g.round}/${g.rounds}`;
  },
};
