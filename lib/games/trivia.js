const { tag, podium } = require('./engine');
const words = require('../words');

const ROUND_MS = 20_000;
const BETWEEN_MS = 3_000;

const BUILTIN = [
  ['What is the capital of Nigeria?', 'Abuja', ['Lagos', 'Kano', 'Ibadan']],
  ['Which planet is known as the Red Planet?', 'Mars', ['Venus', 'Jupiter', 'Mercury']],
  ['How many continents are there?', '7', ['5', '6', '8']],
  ['What is the largest ocean on Earth?', 'Pacific', ['Atlantic', 'Indian', 'Arctic']],
  ['Who painted the Mona Lisa?', 'Leonardo da Vinci', ['Picasso', 'Van Gogh', 'Michelangelo']],
  ['What gas do plants absorb from the air?', 'Carbon dioxide', ['Oxygen', 'Nitrogen', 'Helium']],
  ['How many players are on a football (soccer) team on the pitch?', '11', ['9', '10', '12']],
  ['What is H2O commonly known as?', 'Water', ['Salt', 'Hydrogen', 'Acid']],
  ['Which is the largest mammal?', 'Blue whale', ['Elephant', 'Giraffe', 'Hippo']],
  ['What is the hardest natural substance?', 'Diamond', ['Gold', 'Iron', 'Quartz']],
  ['Which country has the largest population in Africa?', 'Nigeria', ['Ethiopia', 'Egypt', 'South Africa']],
  ['How many sides does a hexagon have?', '6', ['5', '7', '8']],
  ['What is the fastest land animal?', 'Cheetah', ['Lion', 'Horse', 'Leopard']],
  ['Which language has the most native speakers?', 'Mandarin Chinese', ['English', 'Spanish', 'Hindi']],
  ['What is the chemical symbol for gold?', 'Au', ['Ag', 'Go', 'Gd']],
  ['In which year did World War II end?', '1945', ['1939', '1918', '1950']],
  ['Which planet has the most prominent rings?', 'Saturn', ['Mars', 'Earth', 'Neptune']],
  ['What is the longest river in Africa?', 'Nile', ['Niger', 'Congo', 'Zambezi']],
  ['How many days are in a leap year?', '366', ['365', '364', '367']],
  ['Which organ pumps blood around the body?', 'Heart', ['Liver', 'Lungs', 'Kidney']],
].map(([q, a, w]) => ({ q, a, wrong: w }));

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

async function fetchQuestions(n, difficulty) {
  try {
    const url = `https://opentdb.com/api.php?amount=${n}&type=multiple&encode=url3986${difficulty ? `&difficulty=${difficulty}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.response_code !== 0 || !data.results?.length) throw new Error('no results');
    return data.results.map((r) => ({
      q: decode(r.question),
      a: decode(r.correct_answer),
      wrong: r.incorrect_answers.map(decode),
    }));
  } catch {
    return null;
  }
}

function fallback(n) {
  return words.shuffle([...BUILTIN]).slice(0, n);
}

function startRound(g) {
  const item = g.questions[g.round];
  g.round += 1;
  const options = words.shuffle([item.a, ...item.wrong]);
  g.current = { item, correct: 'abcd'[options.indexOf(item.a)], answered: new Map() };
  g.open = true;
  g.say(
    `❓ *Question ${g.round}/${g.rounds}*\n\n${item.q}\n\n` +
      options.map((o, i) => `*${'ABCD'[i]}.* ${o}`).join('\n') +
      `\n\nReply with A, B, C or D · ⏱️ ${ROUND_MS / 1000}s`
  );
  g.roundTimer = g.later(() => closeRound(g, true), ROUND_MS);
}

function closeRound(g) {
  g.open = false;
  g.cancel(g.roundTimer);
  const { item, correct } = g.current;
  const winners = [...g.current.answered.values()].filter((x) => x.ok);
  g.say(
    `✅ Answer: *${correct.toUpperCase()}. ${item.a}*\n` +
      (winners.length ? `Correct: ${winners.map((w) => w.player.name).join(', ')}` : 'Nobody got it!')
  );
  if (g.round >= g.rounds) return g.later(() => finish(g), 1500);
  g.later(() => startRound(g), BETWEEN_MS);
}

function finish(g) {
  const rows = [...g.points.values()].sort((a, b) => b.pts - a.pts);
  if (!rows.length) {
    g.say('🏁 Trivia over! Nobody scored.');
  } else {
    g.score(rows[0].player, 10, true);
    g.say(`🏁 *Trivia finished!*\n\n${podium(rows)}\n\n🏆 ${tag(rows[0].player)} wins! (+10 bonus)`, [rows[0].player.jid]);
  }
  g.end();
}

module.exports = {
  id: 'trivia',
  title: 'Trivia',
  desc: 'Multiple-choice quiz. First correct answer scores the most.',
  how: 'Reply A, B, C or D. Start with *.trivia 10 hard* (1 to 20 rounds, easy/medium/hard). Any number of players.',
  BUILTIN,

  async start(g, ctx, args) {
    const rounds = Math.min(20, Math.max(1, parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 5));
    const difficulty = args.find((a) => ['easy', 'medium', 'hard'].includes(a?.toLowerCase()))?.toLowerCase();
    g.rounds = rounds;
    g.round = 0;
    g.points = new Map();
    g.say('🧠 *TRIVIA TIME!* Loading questions...');
    g.questions = (await fetchQuestions(rounds, difficulty)) || fallback(rounds);
    g.rounds = Math.min(rounds, g.questions.length);
    if (g.over) return;
    g.later(() => startRound(g), 1500);
  },

  onText(g, ctx, text) {
    if (!g.open) return;
    const t = text.trim().toLowerCase();
    if (!/^[a-d]$/.test(t)) return;
    const cur = g.current;
    if (cur.answered.has(ctx.player.jid)) return; // one try per question

    const ok = t === cur.correct;
    cur.answered.set(ctx.player.jid, { ok, player: ctx.player });
    if (!ok) return g.react(ctx.msg, '❌');

    const first = ![...cur.answered.values()].some((x) => x.ok && x.player.jid !== ctx.player.jid);
    const pts = first ? 5 : 3;
    const row = g.points.get(ctx.player.jid) || { player: ctx.player, name: ctx.player.name, pts: 0 };
    row.pts += pts;
    g.points.set(ctx.player.jid, row);
    g.score(ctx.player, pts);
    g.react(ctx.msg, first ? '🏅' : '✅');
  },

  status(g) {
    return `question ${g.round}/${g.rounds}`;
  },
};
