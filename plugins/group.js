const store = require('../lib/store');
const scheduler = require('../lib/scheduler');
const { parseDuration, formatDuration } = require('../lib/time');
const {
  num,
  isBot,
  getTargets,
  guard,
  findParticipant,
  protectedReason,
  sleep,
} = require('../lib/group');

const DAY = 86400000;

module.exports = {
  /** Track the last time each member spoke, used by .sort */
  async onMessage(ctx) {
    if (!ctx.isGroup || ctx.fromMe) return;
    const g = (store.db.activity[ctx.jid] ||= {});
    g[num(ctx.sender)] = Date.now();
    store.save();
  },

  commands: [
    {
      name: 'kick',
      aliases: ['remove'],
      cat: 'Group',
      desc: 'Remove someone from the group. Reply to them, @mention them, or give a number.',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const targets = getTargets(ctx);
        if (!targets.length) return ctx.reply(`Reply to someone or @mention them: ${ctx.config.prefix}kick @user`);

        const done = [];
        for (const jid of targets) {
          const p = findParticipant(meta, jid);
          if (!p) continue;
          const why = protectedReason(ctx, meta, p);
          if (why) {
            await ctx.reply(why);
            continue;
          }
          await ctx.sock.groupParticipantsUpdate(ctx.jid, [p.id], 'remove');
          done.push(p.id);
          if (targets.length > 1) await sleep(1200);
        }
        if (done.length) {
          await ctx.sock.sendMessage(
            ctx.jid,
            { text: `Removed ${done.map((j) => '@' + num(j)).join(', ')}`, mentions: done },
            { quoted: ctx.msg }
          );
        }
      },
    },

    {
      name: 'tempkick',
      aliases: ['tkick'],
      cat: 'Group',
      desc: 'Remove someone temporarily, then add them back. Usage: .tempkick 10m @user (s/m/h/d)',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const ms = parseDuration(ctx.args[0]);
        if (!ms) {
          return ctx.reply(`Usage: ${ctx.config.prefix}tempkick <time> @user\nExamples: 30s, 10m, 2h, 1d (max 7 days)`);
        }
        const targets = getTargets(ctx, ctx.args.slice(1));
        if (!targets.length) return ctx.reply('Reply to someone or @mention them.');

        const done = [];
        for (const jid of targets) {
          const p = findParticipant(meta, jid);
          if (!p) continue;
          const why = protectedReason(ctx, meta, p);
          if (why) {
            await ctx.reply(why);
            continue;
          }
          await ctx.sock.groupParticipantsUpdate(ctx.jid, [p.id], 'remove');
          scheduler.add('readd', ctx.jid, ms, { user: p.id });
          done.push(p.id);
          await sleep(1200);
        }
        if (done.length) {
          await ctx.sock.sendMessage(
            ctx.jid,
            {
              text: `Removed ${done.map((j) => '@' + num(j)).join(', ')} for ${formatDuration(ms)}. I will add them back after that.`,
              mentions: done,
            },
            { quoted: ctx.msg }
          );
        }
      },
    },

    {
      name: 'close',
      aliases: ['mute', 'lock'],
      cat: 'Group',
      desc: 'Close the group (admins only can chat). Optional time, then it reopens by itself: .close 10m',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const raw = ctx.args[0];
        const ms = raw ? parseDuration(raw) : null;
        if (raw && !ms) return ctx.reply('Time looks wrong. Use something like 30s, 10m, 2h or 1d.');

        scheduler.cancelGroup(ctx.jid, ['open', 'close']);
        await ctx.sock.groupSettingUpdate(ctx.jid, 'announcement');
        if (ms) {
          scheduler.add('open', ctx.jid, ms);
          await ctx.reply(`Group closed for ${formatDuration(ms)}. It will open automatically after that.`);
        } else {
          await ctx.reply('Group closed. Only admins can send messages.');
        }
      },
    },

    {
      name: 'open',
      aliases: ['unmute', 'unlock'],
      cat: 'Group',
      desc: 'Open the group for everyone. Optional time, then it closes again: .open 5m',
      async run(ctx) {
        const meta = await guard(ctx);
        if (!meta) return;
        const raw = ctx.args[0];
        const ms = raw ? parseDuration(raw) : null;
        if (raw && !ms) return ctx.reply('Time looks wrong. Use something like 30s, 10m, 2h or 1d.');

        scheduler.cancelGroup(ctx.jid, ['open', 'close']);
        await ctx.sock.groupSettingUpdate(ctx.jid, 'not_announcement');
        if (ms) {
          scheduler.add('close', ctx.jid, ms);
          await ctx.reply(`Group open for ${formatDuration(ms)}. It will close automatically after that.`);
        } else {
          await ctx.reply('Group open. Everyone can send messages.');
        }
      },
    },

    {
      name: 'sort',
      aliases: ['inactive'],
      cat: 'Group',
      desc: 'List members with no messages in N days (default 7): .sort 14. Owner can remove them: .sort kick 14',
      async run(ctx) {
        const wantKick = ctx.args[0]?.toLowerCase() === 'kick';
        const meta = await guard(ctx, { needBotAdmin: wantKick });
        if (!meta) return;
        if (wantKick && !ctx.isOwner) return ctx.reply('Only the owner can remove inactive members.');

        const days = Number(ctx.args.find((a) => /^\d+$/.test(a))) || 7;
        const cutoff = Date.now() - days * DAY;
        const seen = store.db.activity[ctx.jid] || {};

        const lastSeen = (p) => {
          const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(num);
          return Math.max(0, ...ids.map((n) => seen[n] || 0));
        };

        const inactive = meta.participants
          .filter((p) => !p.admin && !isBot(ctx.sock, p))
          .map((p) => ({ p, last: lastSeen(p) }))
          .filter((x) => x.last < cutoff)
          .sort((a, b) => a.last - b.last);

        if (!inactive.length) return ctx.reply(`Everyone has been active in the last ${days} day(s).`);

        if (!wantKick) {
          const shown = inactive.slice(0, 40);
          const lines = shown.map(
            (x, i) =>
              `${i + 1}. @${num(x.p.id)} - ${x.last ? Math.floor((Date.now() - x.last) / DAY) + 'd ago' : 'no messages seen'}`
          );
          const more = inactive.length > shown.length ? `\n...and ${inactive.length - shown.length} more` : '';
          return ctx.sock.sendMessage(
            ctx.jid,
            {
              text:
                `*Inactive for ${days}+ days: ${inactive.length}*\n\n${lines.join('\n')}${more}\n\n` +
                `Activity is only tracked while I am running in this group.\n` +
                `Owner: ${ctx.config.prefix}sort kick ${days} removes them (40 at a time).`,
              mentions: shown.map((x) => x.p.id),
            },
            { quoted: ctx.msg }
          );
        }

        const batch = inactive.slice(0, 40);
        await ctx.reply(`Removing ${batch.length} inactive member(s)...`);
        let removed = 0;
        for (const { p } of batch) {
          try {
            await ctx.sock.groupParticipantsUpdate(ctx.jid, [p.id], 'remove');
            removed++;
          } catch (e) {
            console.error('sort kick failed:', e.message);
          }
          await sleep(1500);
        }
        await ctx.reply(`Removed ${removed}/${batch.length}.${inactive.length > 40 ? ' Run it again for the rest.' : ''}`);
      },
    },
  ],
};
