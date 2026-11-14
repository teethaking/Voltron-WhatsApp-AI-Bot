const fs = require('fs');
const store = require('../lib/store');

const started = Date.now();

function uptime() {
  let s = Math.floor((Date.now() - started) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

// Menu sections: display name, icon, and which command categories (cmd.cat) belong to it.
const SECTIONS = [
  { name: 'Stickers', icon: '🎨', cats: ['Sticker'] },
  { name: 'Downloader', icon: '📥', cats: ['Download'] },
  { name: 'Music', icon: '🎵', cats: ['Music'] },
  { name: 'Games', icon: '🎮', cats: ['Games'] },
  { name: 'Voice', icon: '🗣️', cats: ['Tts'] },
  { name: 'AI', icon: '🤖', cats: ['AI'] },
  { name: 'Group', icon: '👥', cats: ['Group'] },
  { name: 'Media', icon: '🎛️', cats: ['Media'] },
  { name: 'Tools', icon: '🧰', cats: ['Tools'] },
  { name: 'Privacy', icon: '🔐', cats: ['Viewonce', 'Privacy'] },
  { name: 'General', icon: '⚙️', cats: ['General'] },
  { name: 'Owner', icon: '👑', cats: ['Owner'] },
];

const SMALL = Object.fromEntries(
  [...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, [...'ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ'][i]])
);
const sc = (s) => String(s).toLowerCase().replace(/[a-z]/g, (c) => SMALL[c]);

// WhatsApp folds long messages behind "Read more" after an invisible run like this one.
const READ_MORE = '\u200e'.repeat(4001);
const END = '╰━━━━━━━━━━━━━━━⊷';

function greeting(tz) {
  const hour = Number(new Date().toLocaleString('en-GB', { timeZone: tz, hour: 'numeric', hour12: false })) % 24;
  if (hour < 5) return 'Burning the midnight oil';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 22) return 'Good evening';
  return 'Good night';
}

/** Commands the current user may see, grouped into ordered sections. */
function buildSections(ctx) {
  const visible = [...ctx.commands].filter((c) => !c.owner || ctx.isOwner);
  const sections = SECTIONS.map((s) => ({ ...s, cmds: visible.filter((c) => s.cats.includes(c.cat)) }));
  // any plugin category we do not know about still gets a section
  const known = new Set(SECTIONS.flatMap((s) => s.cats));
  for (const cat of new Set(visible.map((c) => c.cat).filter((c) => !known.has(c)))) {
    sections.push({ name: cat, icon: '✨', cats: [cat], cmds: visible.filter((c) => c.cat === cat) });
  }
  return sections.filter((s) => s.cmds.length);
}

function header(ctx, total) {
  const { botName, ownerName, prefix, timezone } = ctx.config;
  const mode = store.db.mode || ctx.config.mode;
  const who = ctx.msg.pushName || 'there';
  const date = new Date().toLocaleString('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const time = new Date().toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const row = (icon, label, value) => `┃ ${icon} ${sc(label)} : ${value}`;

  return [
    `╭━━━〔 ⚡ *${sc(botName)}* ⚡ 〕━━━⊷`,
    row('👤', 'user', who),
    row('👑', 'owner', ownerName),
    row('⌨️', 'prefix', `[ ${prefix} ]`),
    row('🌐', 'mode', sc(mode)),
    row('⏱️', 'uptime', uptime()),
    row('💾', 'ram', `${mem} MB`),
    row('🧩', 'commands', total),
    row('📅', 'date', date),
    row('🕒', 'time', time),
    END,
    `> 👋 _${greeting(timezone)}, ${who}!_`,
  ].join('\n');
}

function footer(ctx) {
  const p = ctx.config.prefix;
  return [
    `╭━━〔 💡 *${sc('tips')}* 〕━━⊷`,
    `┃ ${p}menu music  ➜ one category`,
    `┃ ${p}menu play   ➜ one command`,
    END,
    `> ⚡ _${sc(ctx.config.botName)} · ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${ctx.config.ownerName}_`,
  ].join('\n');
}

const sectionTop = (s) => `╭━━〔 ${s.icon} *${sc(s.name)}* 〕━━⊷`;

function mainList(ctx, sections) {
  const p = ctx.config.prefix;
  return sections
    .map((s) => [sectionTop(s), ...s.cmds.map((c) => `┃ ◈ ${p}${c.name}`), END].join('\n'))
    .join('\n\n');
}

function sectionDetail(ctx, s) {
  const p = ctx.config.prefix;
  const rows = s.cmds.flatMap((c) => {
    const alias = (c.aliases || []).length ? ` _(${c.aliases.slice(0, 3).map((a) => p + a).join(', ')})_` : '';
    return [`┃ ◈ *${p}${c.name}*${alias}`, `┃    ${c.desc}`, `┃`];
  });
  rows.pop(); // no trailing empty line
  return [sectionTop(s), ...rows, END].join('\n');
}

function commandDetail(ctx, c) {
  const p = ctx.config.prefix;
  const rows = [`┃ 📝 ${c.desc}`];
  if ((c.aliases || []).length) rows.push(`┃ 🔁 ${sc('also')} : ${c.aliases.map((a) => p + a).join('  ')}`);
  if (c.owner) rows.push(`┃ 👑 ${sc('owner only')}`);
  return [`╭━━〔 ◈ *${p}${c.name}* 〕━━⊷`, ...rows, END].join('\n');
}

module.exports = {
  commands: [
    {
      name: 'menu',
      aliases: ['help', 'cmds', 'start'],
      desc: 'Show this menu. Use .menu <category> or .menu <command> for details',
      async run(ctx) {
        const sections = buildSections(ctx);
        const total = sections.reduce((n, s) => n + s.cmds.length, 0);
        const arg = ctx.text.trim().toLowerCase().replace(ctx.config.prefix, '');

        // .menu <category> or .menu <command>
        if (arg) {
          const section = sections.find((s) => s.name.toLowerCase() === arg || s.name.toLowerCase().startsWith(arg));
          if (section) return ctx.reply(`${sectionDetail(ctx, section)}\n\n${footer(ctx)}`);

          const cmd = ctx.getCommand(arg);
          if (cmd && (!cmd.owner || ctx.isOwner)) return ctx.reply(commandDetail(ctx, cmd));

          const names = sections.map((s) => s.name.toLowerCase()).join(', ');
          return ctx.reply(`❌ No category or command called *${arg}*.\nCategories: ${names}`);
        }

        const head = header(ctx, total);
        const list = `${mainList(ctx, sections)}\n\n${footer(ctx)}`;

        // Image captions are limited (~1000 chars), so with a menu image: image + header, then the list.
        if (store.db.menuImage && fs.existsSync(store.menuPath)) {
          await ctx.sock.sendMessage(
            ctx.jid,
            { image: fs.readFileSync(store.menuPath), caption: head },
            { quoted: ctx.msg }
          );
          return ctx.sock.sendMessage(ctx.jid, { text: list });
        }
        await ctx.reply(`${head}\n${READ_MORE}\n${list}`);
      },
    },
    {
      name: 'ping',
      desc: 'Check the bot is alive',
      async run(ctx) {
        const t = Date.now();
        const sent = await ctx.sock.sendMessage(ctx.jid, { text: 'Pong' }, { quoted: ctx.msg });
        await ctx.sock.sendMessage(ctx.jid, { text: `🏓 Pong: ${Date.now() - t}ms`, edit: sent.key });
      },
    },
  ],
};
