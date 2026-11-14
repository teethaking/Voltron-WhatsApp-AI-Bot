const store = require('../store');

const num = (jid) => (jid || '').split('@')[0].split(':')[0];

/** One running game per chat. */
const active = new Map(); // chatJid -> Game

class Game {
  constructor(sock, jid, mod, host) {
    this.sock = sock;
    this.jid = jid;
    this.mod = mod;
    this.host = host; // { jid, name } of whoever started it
    this.timers = new Set();
    this.over = false;
    this.startedAt = Date.now();
  }

  /** Send a message to the chat, mentioning the given jids. */
  say(text, mentions = []) {
    return this.sock.sendMessage(this.jid, { text, mentions }).catch((e) => console.error('game say failed:', e.message));
  }

  react(msg, emoji) {
    return this.sock.sendMessage(this.jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
  }

  /** Run `fn` after `ms` unless the game ended. Returns a handle for cancel(). */
  later(fn, ms) {
    const t = setTimeout(async () => {
      this.timers.delete(t);
      if (this.over) return;
      try {
        await fn();
      } catch (e) {
        console.error('game timer error:', e);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  cancel(t) {
    clearTimeout(t);
    this.timers.delete(t);
  }

  /** Add points to a player's all-time tally for this chat. */
  score(player, points, win = false) {
    const chat = (store.db.gameScores[this.jid] ||= {});
    const row = (chat[num(player.jid)] ||= { name: player.name, points: 0, wins: 0 });
    row.name = player.name || row.name;
    row.points += points;
    if (win) row.wins += 1;
    store.save();
  }

  end() {
    this.over = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (active.get(this.jid) === this) active.delete(this.jid);
  }
}

const tag = (p) => `@${num(p.jid)}`;
const sameUser = (a, b) => num(a) === num(b);

/** Medal list for a Map/array of { name, pts }. */
function podium(rows) {
  const medals = ['🥇', '🥈', '🥉'];
  return rows.map((r, i) => `${medals[i] || '▫️'} ${r.name} — ${r.pts} pts`).join('\n');
}

module.exports = { active, Game, tag, num, sameUser, podium };
