const store = require('../lib/store');
const { getText } = require('../lib/utils');
const { active, Game, num, sameUser } = require('../lib/games/engine');

const MODS = {
  wcg: require('../lib/games/wcg'),
  wordle: require('../lib/games/wordle'),
  hangman: require('../lib/games/hangman'),
  scramble: require('../lib/games/scramble'),
  trivia: require('../lib/games/trivia'),
};

async function launch(ctx, id) {
  const { jid, sock } = ctx;
  const running = active.get(jid);
  if (running) {
    return ctx.reply(
      `A *${running.mod.title}* game is already running here (${running.mod.status(running)}).\n` +
        `Finish it or use *${ctx.config.prefix}endgame*.`
    );
  }
  const mod = MODS[id];
  const g = new Game(sock, jid, mod, ctx.player);
  active.set(jid, g);
  try {
    await mod.start(g, ctx, ctx.args || []);
  } catch (e) {
    g.end();
    throw e;
  }
}

const gameCmd = (id, aliases, desc) => ({
  name: id,
  aliases,
  desc,
  public: true,
  async run(ctx) {
    if (id === 'wcg') {
      const g = active.get(ctx.jid);
      const sub = (ctx.args[0] || '').toLowerCase();
      if (g && g.mod.id === 'wcg') {
        if (sub === 'go' || sub === 'start') return g.mod.go(g, ctx);
        return g.mod.join(g, ctx); // .wcg while a lobby is open = join
      }
    }
    return launch(ctx, id);
  },
});

async function canStop(ctx, g) {
  if (ctx.isOwner || ctx.isSudo || sameUser(ctx.player.jid, g.host.jid)) return true;
  if (!ctx.isGroup) return true;
  try {
    const meta = await ctx.sock.groupMetadata(ctx.jid);
    return meta.participants.some((p) => p.admin && [p.id, p.lid, p.phoneNumber].some((x) => x && num(x) === num(ctx.player.jid)));
  } catch {
    return false;
  }
}

module.exports = {
  commands: [
    gameCmd('wcg', ['wordchain', 'chain'], 'Word Chain: last letter starts the next word, last player standing wins'),
    gameCmd('wordle', ['wordguess', 'wg'], 'Word Guess: everyone cracks the same hidden word (.wordle 4-7)'),
    gameCmd('hangman', ['hm'], 'Hangman: guess letters together'),
    gameCmd('scramble', ['unscramble'], 'Word Scramble: race to unscramble (.scramble 10)'),
    gameCmd('trivia', ['quiz'], 'Trivia: multiple choice quiz (.trivia 10 hard)'),
    {
      name: 'join',
      desc: 'Join a Word Chain lobby',
      public: true,
      async run(ctx) {
        const g = active.get(ctx.jid);
        if (!g || !g.mod.join) return ctx.reply('There is no game to join right now.');
        return g.mod.join(g, ctx);
      },
    },
    {
      name: 'leave',
      desc: 'Leave a Word Chain lobby',
      public: true,
      async run(ctx) {
        const g = active.get(ctx.jid);
        if (!g || !g.mod.leave) return ctx.reply('There is no game to leave.');
        return g.mod.leave(g, ctx);
      },
    },
    {
      name: 'endgame',
      aliases: ['stopgame'],
      desc: 'Stop the running game (host, group admin or owner)',
      public: true,
      async run(ctx) {
        const g = active.get(ctx.jid);
        if (!g) return ctx.reply('No game is running here.');
        if (!(await canStop(ctx, g))) return ctx.reply('Only the host, a group admin or the owner can stop the game.');
        const answer = g.mod.reveal ? `\nThe answer was *${g.mod.reveal(g)}*.` : '';
        g.end();
        return ctx.reply(`🛑 ${g.mod.title} stopped.${answer}`);
      },
    },
    {
      name: 'games',
      desc: 'List the available games',
      public: true,
      async run(ctx) {
        const p = ctx.config.prefix;
        const lines = [
          '🎮 *VOLTRON ARCADE*',
          '',
          ...Object.values(MODS).map((m) => `*${p}${m.id}*  ${m.title}\n   ${m.desc}\n   _${m.how}_`),
          '',
          `🏆 *${p}lb* leaderboard · 🛑 *${p}endgame* stop the game`,
          'One game runs per chat. Any number of players can join in.',
        ];
        return ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'lb',
      aliases: ['leaderboard', 'top'],
      desc: 'Game leaderboard for this chat',
      public: true,
      async run(ctx) {
        const rows = Object.entries(store.db.gameScores[ctx.jid] || {})
          .map(([n, r]) => ({ n, ...r }))
          .sort((a, b) => b.points - a.points || b.wins - a.wins)
          .slice(0, 10);
        if (!rows.length) return ctx.reply(`No scores yet. Start a game with ${ctx.config.prefix}games`);
        const medals = ['🥇', '🥈', '🥉'];
        const text =
          '🏆 *LEADERBOARD*\n\n' +
          rows.map((r, i) => `${medals[i] || `${i + 1}.`} @${r.n} — ${r.points} pts · ${r.wins} win${r.wins === 1 ? '' : 's'}`).join('\n');
        return ctx.sock.sendMessage(ctx.jid, { text, mentions: rows.map((r) => `${r.n}@s.whatsapp.net`) }, { quoted: ctx.msg });
      },
    },
  ],

  /** Route plain (non-command) chat messages into the running game. */
  async onMessage(ctx) {
    const g = active.get(ctx.jid);
    if (!g || g.over || !g.mod.onText) return;
    const text = getText(ctx.msg.message).trim();
    if (!text || text.startsWith(ctx.config.prefix)) return;
    await g.mod.onText(g, ctx, text);
  },
};
