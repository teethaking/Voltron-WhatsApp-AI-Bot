const store = require('../lib/store');
const config = require('../config');
const { num, sameUser, isAdmin, isBot, botIsAdmin, guard, sleep } = require('../lib/group');

const cfgOf = (jid) => (store.db.groupCfg[jid] ||= {});
const idOf = (p) => (typeof p === 'string' ? p : p?.id || p?.phoneNumber || '');
const digits = (s) => String(s || '').replace(/\D/g, '');

/** The real phone number of a group member, even when WhatsApp shows them as an @lid id. */
function phoneOf(meta, jid) {
  const p = meta?.participants?.find((x) => sameUser(x, jid));
  const candidates = [p?.phoneNumber, p?.id, jid].filter(Boolean);
  const real = candidates.find((c) => String(c).endsWith('@s.whatsapp.net'));
  return real ? num(real) : null;
}

const votes = new Map(); // groupJid -> { question, by, yes: Set, no: Set }

const tally = (v) => {
  const total = v.yes.size + v.no.size;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return `📊 *${v.question}*\n✅ Yes: ${v.yes.size} (${pct(v.yes.size)}%)\n❌ No: ${v.no.size} (${pct(v.no.size)}%)\n👥 ${total} vote${total === 1 ? '' : 's'}`;
};

module.exports = {
  /** Anti-fake numbers on join, and promote / demote alerts. */
  async onGroupUpdate(sock, ev) {
    const cfg = store.db.groupCfg[ev.id];
    if (!cfg) return;

    if (ev.action === 'add' && cfg.antifake?.on && cfg.antifake.codes?.length) {
      const meta = await sock.groupMetadata(ev.id).catch(() => null);
      if (!meta || !botIsAdmin(meta, sock)) return;
      for (const p of ev.participants || []) {
        const jid = idOf(p);
        if (!jid || isBot(sock, { id: jid })) continue;
        const phone = phoneOf(meta, jid);
        if (!phone) continue; // number hidden, cannot judge
        const isOwner = config.ownerNumber && phone === config.ownerNumber;
        if (isOwner || store.db.sudo.includes(phone)) continue;
        if (ev.author && !sameUser({ id: ev.author }, jid) && isAdmin(meta, ev.author)) continue; // an admin added them on purpose
        if (cfg.antifake.codes.some((c) => phone.startsWith(c))) continue;
        await sock.groupParticipantsUpdate(ev.id, [jid], 'remove').catch(() => {});
        await sock.sendMessage(ev.id, { text: `🚫 Removed +${phone}: numbers from that country are not allowed here.` }).catch(() => {});
        await sleep(800);
      }
    }

    if ((ev.action === 'promote' || ev.action === 'demote') && cfg.pdm) {
      const who = (ev.participants || []).map(idOf).filter(Boolean);
      if (!who.length) return;
      const by = ev.author ? ` by @${num(ev.author)}` : '';
      const verb = ev.action === 'promote' ? '👑 promoted to admin' : '⬇️ removed as admin';
      const text = `${who.map((j) => '@' + num(j)).join(', ')} ${verb}${by}`;
      await sock.sendMessage(ev.id, { text, mentions: [...who, ev.author].filter(Boolean) }).catch(() => {});
    }
  },

  commands: [
    {
      name: 'antifake',
      cat: 'Group',
      desc: 'Remove newcomers whose number is not from the allowed countries: .antifake on 234 91 | off | list',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const cfg = (cfgOf(ctx.jid).antifake ||= { on: false, codes: [] });
        const arg = (ctx.args[0] || '').toLowerCase();
        const p = ctx.config.prefix;
        if (arg === 'off') cfg.on = false;
        else if (arg === 'on') {
          const codes = [...new Set(ctx.args.slice(1).map(digits).filter(Boolean))];
          if (codes.length) cfg.codes = codes;
          if (!cfg.codes.length) return ctx.reply(`Give me the allowed country codes, e.g. ${p}antifake on 234 91`);
          cfg.on = true;
        } else if (arg !== 'list') {
          return ctx.reply(`Usage: ${p}antifake on 234 91 (allow only those country codes) | off | list`);
        }
        store.save();
        const warn = cfg.on && !botIsAdmin(meta, ctx.sock) ? '\n⚠️ Make me a group admin or I cannot remove anyone.' : '';
        return ctx.reply(`🛡️ Anti-fake: *${cfg.on ? 'ON' : 'OFF'}*\nAllowed country codes: ${cfg.codes.length ? cfg.codes.map((c) => '+' + c).join(' ') : 'none set'}\nPeople added by an admin, admins, sudo users and the owner are never removed.${warn}`);
      },
    },
    {
      name: 'pdm',
      cat: 'Group',
      desc: 'Announce in the group when someone is promoted or demoted: .pdm on | off',
      async run(ctx) {
        if (!(await guard(ctx, { needBotAdmin: false }))) return;
        const cfg = cfgOf(ctx.jid);
        const arg = (ctx.args[0] || '').toLowerCase();
        if (arg === 'on' || arg === 'off') {
          cfg.pdm = arg === 'on';
          store.save();
        }
        return ctx.reply(`👑 Promote/demote alerts: *${cfg.pdm ? 'ON' : 'OFF'}* (${ctx.config.prefix}pdm on | off)`);
      },
    },
    {
      name: 'vote',
      cat: 'Group',
      public: true,
      desc: 'Group vote. Admins: .vote <question>. Everyone: .vote yes | no. Then .vote result, .vote end',
      async run(ctx) {
        if (!ctx.isGroup) return ctx.reply('Votes only work in groups.');
        const p = ctx.config.prefix;
        const arg = (ctx.args[0] || '').toLowerCase();
        const current = votes.get(ctx.jid);
        const voter = num(ctx.sender);

        if (['yes', 'no', 'y', 'n'].includes(arg)) {
          if (!current) return ctx.reply(`No vote is running. An admin can start one with ${p}vote <question>`);
          const yes = arg.startsWith('y');
          current.yes.delete(voter);
          current.no.delete(voter);
          (yes ? current.yes : current.no).add(voter);
          return ctx.sock.sendMessage(ctx.jid, { react: { text: yes ? '✅' : '❌', key: ctx.msg.key } });
        }
        if (arg === 'result' || arg === 'results') return ctx.reply(current ? tally(current) : 'No vote is running.');

        const meta = await ctx.sock.groupMetadata(ctx.jid);
        const admin = ctx.isOwner || ctx.isSudo || isAdmin(meta, ctx.sender);
        if (arg === 'end') {
          if (!current) return ctx.reply('No vote is running.');
          if (!admin) return ctx.reply('Only group admins can end the vote.');
          votes.delete(ctx.jid);
          return ctx.reply(`🏁 Vote closed.\n\n${tally(current)}`);
        }
        if (!ctx.text.trim()) return ctx.reply(`Usage: ${p}vote <question>  ·  then ${p}vote yes / ${p}vote no  ·  ${p}vote result  ·  ${p}vote end`);
        if (!admin) return ctx.reply('Only group admins can start a vote.');
        votes.set(ctx.jid, { question: ctx.text.trim(), yes: new Set(), no: new Set() });
        return ctx.reply(`🗳️ *VOTE*\n${ctx.text.trim()}\n\nReply with *${p}vote yes* or *${p}vote no*\nAdmins: ${p}vote result · ${p}vote end`);
      },
    },
  ],
};
