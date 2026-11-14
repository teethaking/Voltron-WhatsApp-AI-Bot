const store = require('../lib/store');
const config = require('../config');
const { downloadMedia, findMedia, getText } = require('../lib/utils');
const { num, sameUser, isAdmin, isBot, botIsAdmin, getTargets, guard, findParticipant, protectedReason, sleep } = require('../lib/group');

const cfgOf = (jid) => (store.db.groupCfg[jid] ||= {});
const idOf = (p) => (typeof p === 'string' ? p : p?.id || p?.phoneNumber || '');
const GROUP_LINK = /(chat\.whatsapp\.com\/[A-Za-z0-9]{8,}|whatsapp\.com\/(channel|invite)\/\S+)/i;
const ANY_LINK = /((https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|me|co|xyz|ng|link|app|site|online|info)\b\S*)/i;
const say = (ctx, text, mentions = []) => ctx.sock.sendMessage(ctx.jid, { text, mentions }, { quoted: ctx.msg });

const fill = (tpl, { user, group, count }) =>
  tpl.replace(/@user|\{user\}/gi, `@${num(user)}`).replace(/\{group\}/gi, group).replace(/\{count\}/gi, String(count));

const DEFAULT_WELCOME = 'Welcome @user 👋 to *{group}*! You are member #{count}. Read the rules and enjoy.';
const DEFAULT_GOODBYE = 'Goodbye @user 👋';

/** Add a warning. Kicks at the limit (when the bot is admin). Returns text to send. */
async function addWarn(sock, jid, user, reason, meta) {
  const warns = ((cfgOf(jid).warns ||= {}));
  const n = (warns[num(user)] = (warns[num(user)] || 0) + 1);
  store.save();
  if (n >= config.warnLimit) {
    delete warns[num(user)];
    store.save();
    if (meta && botIsAdmin(meta, sock)) {
      await sock.groupParticipantsUpdate(jid, [user], 'remove').catch(() => {});
      return `🚫 @${num(user)} reached ${config.warnLimit} warnings and was removed. (${reason})`;
    }
    return `🚫 @${num(user)} reached ${config.warnLimit} warnings (${reason}) but I am not an admin so I can't remove them.`;
  }
  return `⚠️ Warning ${n}/${config.warnLimit} for @${num(user)}: ${reason}`;
}

module.exports = {
  /** Anti-link, anti-word and auto-reply filters. */
  async onMessage(ctx) {
    if (!ctx.isGroup || ctx.fromMe) return;
    const cfg = store.db.groupCfg[ctx.jid];
    if (!cfg) return;
    const text = getText(ctx.msg.message);
    if (!text) return;

    const wantsLink = cfg.antilink && cfg.antilink.mode !== 'off';
    const words = (cfg.antiword?.words || []).filter(Boolean);
    const hit = words.length && words.find((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text));
    const linkHit = wantsLink && (cfg.antilink.all ? ANY_LINK.test(text) || GROUP_LINK.test(text) : GROUP_LINK.test(text));

    if (linkHit || hit) {
      if (ctx.isOwner || ctx.isSudo) return;
      const meta = await ctx.sock.groupMetadata(ctx.jid).catch(() => null);
      if (!meta || isAdmin(meta, ctx.sender)) return;
      if (!botIsAdmin(meta, ctx.sock)) return; // cannot enforce without admin rights
      await ctx.sock.sendMessage(ctx.jid, { delete: ctx.msg.key }).catch(() => {});
      const reason = linkHit ? 'links are not allowed here' : `banned word "${hit}"`;
      const mode = linkHit ? cfg.antilink.mode : 'warn';
      if (mode === 'kick') {
        await ctx.sock.groupParticipantsUpdate(ctx.jid, [ctx.sender], 'remove').catch(() => {});
        return ctx.sock.sendMessage(ctx.jid, { text: `🚫 @${num(ctx.sender)} was removed: ${reason}.`, mentions: [ctx.sender] });
      }
      if (mode === 'warn') {
        const t = await addWarn(ctx.sock, ctx.jid, ctx.sender, reason, meta);
        return ctx.sock.sendMessage(ctx.jid, { text: t, mentions: [ctx.sender] });
      }
      return ctx.sock.sendMessage(ctx.jid, { text: `🗑️ @${num(ctx.sender)}, ${reason}.`, mentions: [ctx.sender] });
    }

    // auto-reply filters
    const filters = cfg.filters;
    if (filters && !text.startsWith(config.prefix)) {
      const low = text.toLowerCase();
      for (const [k, reply] of Object.entries(filters)) {
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(low)) {
          await ctx.sock.sendMessage(ctx.jid, { text: reply }, { quoted: ctx.msg });
          break;
        }
      }
    }
  },

  /** Welcome / goodbye messages. */
  async onGroupUpdate(sock, ev) {
    if (ev.action !== 'add' && ev.action !== 'remove') return;
    const cfg = store.db.groupCfg[ev.id];
    const which = ev.action === 'add' ? cfg?.welcome : cfg?.goodbye;
    if (!which?.on) return;
    const meta = await sock.groupMetadata(ev.id).catch(() => null);
    const group = meta?.subject || 'the group';
    const count = meta?.participants?.length || 0;
    for (const p of ev.participants || []) {
      const user = idOf(p);
      if (!user || [sock.user?.id, sock.user?.lid].some((j) => j && num(j) === num(user))) continue;
      const text = fill(which.text || (ev.action === 'add' ? DEFAULT_WELCOME : DEFAULT_GOODBYE), { user, group, count });
      await sock.sendMessage(ev.id, { text, mentions: [user] }).catch(() => {});
      await sleep(800);
    }
  },

  commands: [
    {
      name: 'promote',
      desc: 'Make someone a group admin (reply / @mention)',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const targets = getTargets(ctx).map((j) => findParticipant(meta, j)).filter(Boolean);
        if (!targets.length) return ctx.reply(`Reply to someone or @mention them: ${ctx.config.prefix}promote @user`);
        await ctx.sock.groupParticipantsUpdate(ctx.jid, targets.map((p) => p.id), 'promote');
        await say(ctx, `👑 Promoted ${targets.map((p) => '@' + num(p.id)).join(', ')}`, targets.map((p) => p.id));
      },
    },
    {
      name: 'demote',
      desc: 'Remove someone\'s admin rights (reply / @mention)',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const targets = getTargets(ctx).map((j) => findParticipant(meta, j)).filter(Boolean).filter((p) => !isBot(ctx.sock, p));
        if (!targets.length) return ctx.reply(`Reply to someone or @mention them: ${ctx.config.prefix}demote @user`);
        await ctx.sock.groupParticipantsUpdate(ctx.jid, targets.map((p) => p.id), 'demote');
        await say(ctx, `⬇️ Demoted ${targets.map((p) => '@' + num(p.id)).join(', ')}`, targets.map((p) => p.id));
      },
    },
    {
      name: 'add',
      desc: 'Add a number to the group: .add 2348012345678',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const numbers = ctx.args.map((a) => a.replace(/\D/g, '')).filter((d) => d.length >= 7 && d.length <= 15);
        if (!numbers.length) return ctx.reply(`Give a number with country code: ${ctx.config.prefix}add 2348012345678`);
        const res = await ctx.sock.groupParticipantsUpdate(ctx.jid, numbers.map((n) => `${n}@s.whatsapp.net`), 'add');
        const lines = res.map((r) => `${String(r.status) === '200' ? '✅' : '❌'} +${num(r.jid || '')} ${String(r.status) === '200' ? 'added' : String(r.status) === '403' ? '(privacy: send them the invite link instead)' : `(code ${r.status})`}`);
        await ctx.reply(lines.join('\n'));
      },
    },
    {
      name: 'tagall',
      aliases: ['everyone'],
      desc: 'Mention every member. Add a message: .tagall meeting at 5',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const ids = meta.participants.map((p) => p.id);
        const text = `📢 *${ctx.text || 'Attention everyone'}*\n\n` + ids.map((j) => `• @${num(j)}`).join('\n');
        await ctx.sock.sendMessage(ctx.jid, { text, mentions: ids }, { quoted: ctx.msg });
      },
    },
    {
      name: 'hidetag',
      aliases: ['tag', 'announce'],
      desc: 'Mention everyone silently with your text (or the replied message)',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const text = ctx.text || (ctx.quoted && getText(ctx.quoted.message));
        if (!text) return ctx.reply(`Type a message or reply to one: ${ctx.config.prefix}hidetag hello all`);
        await ctx.sock.sendMessage(ctx.jid, { text, mentions: meta.participants.map((p) => p.id) });
      },
    },
    {
      name: 'tagadmins',
      aliases: ['admins'],
      desc: 'Mention the group admins',
      async run(ctx) {
        if (!ctx.isGroup) return ctx.reply('This only works in groups.');
        const meta = await ctx.sock.groupMetadata(ctx.jid);
        const ids = meta.participants.filter((p) => p.admin).map((p) => p.id);
        await say(ctx, `👑 *Admins*\n\n${ctx.text ? ctx.text + '\n\n' : ''}${ids.map((j) => `• @${num(j)}`).join('\n')}`, ids);
      },
    },
    {
      name: 'link',
      aliases: ['invite', 'grouplink'],
      desc: 'Get the group invite link',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        await ctx.reply(`https://chat.whatsapp.com/${await ctx.sock.groupInviteCode(ctx.jid)}`);
      },
    },
    {
      name: 'resetlink',
      aliases: ['revokelink'],
      desc: 'Reset the group invite link (the old one stops working)',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        await ctx.sock.groupRevokeInvite(ctx.jid);
        await ctx.reply(`✅ Link reset:\nhttps://chat.whatsapp.com/${await ctx.sock.groupInviteCode(ctx.jid)}`);
      },
    },
    {
      name: 'gname',
      desc: 'Change the group name',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        if (!ctx.text) return ctx.reply(`${ctx.config.prefix}gname New Name`);
        await ctx.sock.groupUpdateSubject(ctx.jid, ctx.text.slice(0, 100));
      },
    },
    {
      name: 'gdesc',
      desc: 'Change the group description',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        if (!ctx.text) return ctx.reply(`${ctx.config.prefix}gdesc New description`);
        await ctx.sock.groupUpdateDescription(ctx.jid, ctx.text.slice(0, 2000));
      },
    },
    {
      name: 'setgpp',
      desc: 'Reply to a photo to set it as the group picture',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const media = findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));
        if (!media || media.type !== 'image') return ctx.reply('Reply to a photo with .setgpp');
        await ctx.sock.updateProfilePicture(ctx.jid, await downloadMedia(media));
        await ctx.reply('✅ Group picture updated.');
      },
    },

    // ---------- welcome / goodbye ----------
    ...['welcome', 'goodbye'].map((kind) => ({
      name: kind,
      desc: `${kind === 'welcome' ? 'Greet new members' : 'Say bye to leavers'}: .${kind} on | off | <custom text>  (use @user {group} {count})`,
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const cfg = cfgOf(ctx.jid);
        const arg = ctx.text.trim();
        const cur = (cfg[kind] ||= { on: false, text: '' });
        if (arg.toLowerCase() === 'on' || arg.toLowerCase() === 'off') cur.on = arg.toLowerCase() === 'on';
        else if (arg.toLowerCase() === 'reset') cur.text = '';
        else if (arg) {
          cur.text = arg;
          cur.on = true;
        }
        store.save();
        await ctx.reply(`${kind === 'welcome' ? '👋' : '🚪'} *${kind}* is ${cur.on ? 'ON' : 'OFF'}\nText: ${cur.text || (kind === 'welcome' ? DEFAULT_WELCOME : DEFAULT_GOODBYE)}`);
      },
    })),

    // ---------- moderation ----------
    {
      name: 'antilink',
      desc: 'Delete links: .antilink off | delete | warn | kick, and .antilink all to block every link (default: only WhatsApp group links)',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const cfg = cfgOf(ctx.jid);
        const cur = (cfg.antilink ||= { mode: 'off', all: false });
        const arg = (ctx.args[0] || '').toLowerCase();
        if (['off', 'delete', 'warn', 'kick'].includes(arg)) cur.mode = arg;
        else if (arg === 'on') cur.mode = 'delete';
        else if (arg === 'all') cur.all = !cur.all;
        store.save();
        const warn = cur.mode !== 'off' && !botIsAdmin(meta, ctx.sock) ? '\n⚠️ Make me a group admin or I cannot delete links.' : '';
        await ctx.reply(`🔗 Anti-link: *${cur.mode.toUpperCase()}* · blocking ${cur.all ? 'ALL links' : 'WhatsApp group links only'}${warn}`);
      },
    },
    {
      name: 'antiword',
      desc: 'Banned words (deleted + warning): .antiword add <word> | del <word> | list | off',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const cfg = cfgOf(ctx.jid);
        const cur = (cfg.antiword ||= { words: [] });
        const [sub, ...rest] = ctx.args;
        const w = rest.join(' ').toLowerCase().trim();
        if (sub === 'add' && w) cur.words = [...new Set([...cur.words, w])];
        else if (sub === 'del' && w) cur.words = cur.words.filter((x) => x !== w);
        else if (sub === 'off') cur.words = [];
        store.save();
        await ctx.reply(`🧼 Banned words: ${cur.words.length ? cur.words.join(', ') : 'none'}`);
      },
    },
    {
      name: 'warn',
      desc: 'Warn a member (3 warnings = removed): .warn @user reason',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const [t] = getTargets(ctx);
        if (!t) return ctx.reply(`Reply to someone or @mention them: ${ctx.config.prefix}warn @user reason`);
        const p = findParticipant(meta, t);
        if (!p) return ctx.reply('That person is not in this group.');
        const why = protectedReason(ctx, meta, p);
        if (why) return ctx.reply(why);
        const reason = ctx.args.filter((a) => !a.startsWith('@') && !/^\d{7,}$/.test(a)).join(' ') || 'no reason given';
        await say(ctx, await addWarn(ctx.sock, ctx.jid, p.id, reason, meta), [p.id]);
      },
    },
    {
      name: 'warnings',
      aliases: ['warns'],
      desc: 'Show warnings in this group',
      async run(ctx) {
        if (!ctx.isGroup) return ctx.reply('This only works in groups.');
        const w = Object.entries(cfgOf(ctx.jid).warns || {});
        if (!w.length) return ctx.reply('Nobody has warnings here. 🎉');
        await say(ctx, `⚠️ *Warnings* (limit ${config.warnLimit})\n\n${w.map(([n, c]) => `• @${n}: ${c}`).join('\n')}`, w.map(([n]) => `${n}@s.whatsapp.net`));
      },
    },
    {
      name: 'resetwarn',
      desc: 'Clear someone\'s warnings (reply / @mention), or everyone with .resetwarn all',
      async run(ctx) {
        const meta = await guard(ctx, { needBotAdmin: false });
        if (!meta) return;
        const cfg = cfgOf(ctx.jid);
        if ((ctx.args[0] || '').toLowerCase() === 'all') cfg.warns = {};
        else {
          const [t] = getTargets(ctx);
          if (!t) return ctx.reply('Reply to someone, @mention them, or use .resetwarn all');
          delete (cfg.warns ||= {})[num(t)];
        }
        store.save();
        await ctx.reply('✅ Warnings cleared.');
      },
    },

    // ---------- auto-reply filters ----------
    {
      name: 'filter',
      desc: 'Auto-reply when a word is said: .filter price => Check our pinned message',
      async run(ctx) {
        if (ctx.isGroup) {
          if (!(await guard(ctx, { needBotAdmin: false }))) return;
        } else if (!ctx.isOwner && !ctx.isSudo) return;
        const [k, ...v] = ctx.text.split('=>');
        const key = (k || '').trim().toLowerCase();
        const reply = v.join('=>').trim();
        if (!key || !reply) return ctx.reply(`Format: ${ctx.config.prefix}filter hello => Hi there!`);
        (cfgOf(ctx.jid).filters ||= {})[key] = reply;
        store.save();
        await ctx.reply(`✅ I will reply to "${key}" now.`);
      },
    },
    {
      name: 'stop',
      aliases: ['delfilter'],
      desc: 'Remove an auto-reply filter: .stop hello',
      async run(ctx) {
        if (ctx.isGroup) {
          if (!(await guard(ctx, { needBotAdmin: false }))) return;
        } else if (!ctx.isOwner && !ctx.isSudo) return;
        const key = ctx.text.trim().toLowerCase();
        const f = cfgOf(ctx.jid).filters || {};
        if (!f[key]) return ctx.reply('No filter with that word. See .filters');
        delete f[key];
        store.save();
        await ctx.reply('✅ Filter removed.');
      },
    },
    {
      name: 'filters',
      desc: 'List auto-reply filters in this chat',
      async run(ctx) {
        const f = Object.entries(cfgOf(ctx.jid).filters || {});
        await ctx.reply(f.length ? `🤖 *Filters*\n\n${f.map(([k, v]) => `• ${k} ➜ ${v.slice(0, 60)}`).join('\n')}` : 'No filters here yet. Add one with .filter word => reply');
      },
    },
    {
      name: 'poll',
      desc: 'Create a poll: .poll Best food? | Rice | Beans | Yam',
      async run(ctx) {
        const [name, ...values] = ctx.text.split('|').map((s) => s.trim()).filter(Boolean);
        if (!name || values.length < 2) return ctx.reply(`Format: ${ctx.config.prefix}poll Question | option 1 | option 2`);
        await ctx.sock.sendMessage(ctx.jid, { poll: { name, values: values.slice(0, 12), selectableCount: 1 } });
      },
    },
  ],
};

for (const c of module.exports.commands) c.cat = 'Group';
