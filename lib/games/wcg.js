const words = require('../words');
const { tag, sameUser } = require('./engine');

const START_LETTERS = 'abcdefghilmnoprstw';
const LOBBY_MS = 60_000;

function turnLimit(g) {
  return Math.max(15, 40 - Math.floor(g.words / 2)); // seconds, shrinks as the chain grows
}
function minLength(g) {
  return Math.min(3 + Math.floor(g.words / 8), 7); // longer words required as it goes on
}

function begin(g) {
  g.clearLobby();
  if (g.players.size < 2) {
    g.say('😴 Not enough players for Word Chain (need at least 2). Game cancelled.');
    return g.end();
  }
  g.phase = 'play';
  g.alive = words.shuffle([...g.players.values()]);
  g.used = new Set();
  g.words = 0;
  g.turn = 0;
  g.longest = '';
  g.last = START_LETTERS[Math.floor(Math.random() * START_LETTERS.length)];
  g.say(
    `🔥 *WORD CHAIN STARTS!* ${g.alive.length} players\n\n` +
      g.alive.map((p, i) => `${i + 1}. ${tag(p)}`).join('\n') +
      `\n\nSay a word that starts with the *last letter* of the previous word.\n` +
      `No repeats. Miss your turn and you're out. Last one standing wins!`,
    g.alive.map((p) => p.jid)
  );
  nextTurn(g);
}

function nextTurn(g) {
  g.turn %= g.alive.length;
  const cur = g.alive[g.turn];
  const secs = turnLimit(g);
  const minLen = minLength(g);
  g.say(
    `🎯 ${tag(cur)} your turn!\nWord starting with *${g.last.toUpperCase()}* · at least ${minLen} letters · ⏱️ ${secs}s`,
    [cur.jid]
  );
  g.turnTimer = g.later(() => timeout(g), secs * 1000);
}

function timeout(g) {
  const [out] = g.alive.splice(g.turn, 1);
  g.say(`⏰ ${tag(out)} ran out of time and is *OUT*! (${g.alive.length} left)`, [out.jid]);
  if (g.alive.length === 1) return win(g, g.alive[0]);
  nextTurn(g); // the next player now sits at the same index
}

function win(g, winner) {
  g.score(winner, 10, true);
  g.say(
    `🏆 *${winner.name} wins Word Chain!* ${tag(winner)}\n` +
      `Words played: ${g.words}${g.longest ? ` · longest: ${g.longest.toUpperCase()}` : ''}\n+10 points`,
    [winner.jid]
  );
  g.end();
}

module.exports = {
  id: 'wcg',
  title: 'Word Chain',
  desc: 'Say a word starting with the last letter of the previous one. Run out of time and you are out.',
  how: 'Join with *.join* (or *.wcg*) during the 60s lobby. The host can start early with *.wcg go*. Any number of players.',

  start(g, ctx) {
    g.phase = 'lobby';
    g.players = new Map();
    g.players.set(g.host.jid, g.host);
    g.clearLobby = () => g.timers.forEach((t) => g.cancel(t));
    g.say(
      `🔗 *WORD CHAIN* lobby open!\n\nType *${ctx.config.prefix}join* to play (no player limit).\n` +
        `Host ${tag(g.host)} can start early with *${ctx.config.prefix}wcg go*.\nStarting in 60s...`,
      [g.host.jid]
    );
    g.later(() => g.say(`⏳ 30s left to join! Type *${ctx.config.prefix}join*. Players so far: ${g.players.size}`), LOBBY_MS / 2);
    g.later(() => begin(g), LOBBY_MS);
  },

  join(g, ctx) {
    if (g.phase !== 'lobby') return ctx.reply('The game already started. Join the next one!');
    if (g.players.has(ctx.player.jid)) return ctx.reply('You are already in.');
    g.players.set(ctx.player.jid, ctx.player);
    g.say(`✅ ${tag(ctx.player)} joined (${g.players.size} players)`, [ctx.player.jid]);
  },

  leave(g, ctx) {
    if (g.phase !== 'lobby') return ctx.reply('Too late to leave, play on or lose on time!');
    if (g.players.delete(ctx.player.jid)) g.say(`👋 ${ctx.player.name} left (${g.players.size} players)`);
  },

  go(g, ctx) {
    if (g.phase !== 'lobby') return;
    if (!(sameUser(ctx.player.jid, g.host.jid) || ctx.isOwner || ctx.isSudo)) return ctx.reply('Only the host can start early.');
    begin(g);
  },

  onText(g, ctx, text) {
    if (g.phase !== 'play') return;
    const cur = g.alive[g.turn];
    if (!sameUser(ctx.player.jid, cur.jid)) return;

    const word = text.trim().toLowerCase();
    if (!/^[a-z]+$/.test(word)) return; // ignore normal chat

    if (word[0] !== g.last) return g.say(`❌ ${tag(cur)} must start with *${g.last.toUpperCase()}*`, [cur.jid]);
    if (word.length < minLength(g)) return g.say(`❌ At least ${minLength(g)} letters, ${tag(cur)}`, [cur.jid]);
    if (g.used.has(word)) return g.say(`❌ *${word.toUpperCase()}* was already used`);
    if (!words.isWord(word)) return g.say(`❌ *${word.toUpperCase()}* is not in my dictionary`);

    g.cancel(g.turnTimer);
    g.used.add(word);
    g.words += 1;
    if (word.length > g.longest.length) g.longest = word;
    g.last = word[word.length - 1];
    g.score(cur, word.length);
    g.react(ctx.msg, '✅');
    g.turn = (g.turn + 1) % g.alive.length;
    nextTurn(g);
  },

  status(g) {
    return g.phase === 'lobby' ? `lobby, ${g.players.size} players` : `${g.alive.length} players left, ${g.words} words`;
  },
};
