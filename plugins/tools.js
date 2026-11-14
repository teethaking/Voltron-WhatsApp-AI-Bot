const fs = require('fs');
const store = require('../lib/store');
const config = require('../config');
const { downloadMedia, findMedia, getText, ownerJid } = require('../lib/utils');
const { getTargets, num } = require('../lib/group');

const startedAt = Date.now();

async function fetchOk(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'VoltBot/1.0' }, ...opts });
  if (!res.ok) throw new Error(`The service answered ${res.status}. Try again later.`);
  return res;
}
const getJSON = async (url) => (await fetchOk(url)).json();
const getBuffer = async (url) => Buffer.from(await (await fetchOk(url)).arrayBuffer());

const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'd ' : ''}${h ? h + 'h ' : ''}${m}m ${s % 60}s`;
};

// ---------- text styles (offline) ----------
function styleMap(upper, lower, digits) {
  const map = {};
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].forEach((c, i) => (map[c] = String.fromCodePoint(upper + i)));
  [...'abcdefghijklmnopqrstuvwxyz'].forEach((c, i) => (map[c] = String.fromCodePoint(lower + i)));
  if (digits) [...'0123456789'].forEach((c, i) => (map[c] = String.fromCodePoint(digits + i)));
  return map;
}
const STYLES = {
  bold: styleMap(0x1d5d4, 0x1d5ee, 0x1d7ec),
  italic: styleMap(0x1d608, 0x1d622),
  mono: styleMap(0x1d670, 0x1d68a, 0x1d7f6),
  script: styleMap(0x1d4d0, 0x1d4ea),
  gothic: styleMap(0x1d56c, 0x1d586),
  double: styleMap(0x1d538, 0x1d552, 0x1d7d8),
  bubble: { ...styleMap(0x24b6 - 0, 0x24d0), },
};
const apply = (map, text) => [...text].map((c) => map[c] || c).join('');
const SMALLCAPS = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, 'ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ'[i]]));

// ---------- safe calculator ----------
function calc(expr) {
  const e = expr.replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**').replace(/,/g, '');
  if (!/^[0-9+\-*/().%\s*]+$/.test(e) || e.length > 120) throw new Error('Only numbers and + - * / % ^ ( ) are allowed.');
  const v = Function(`"use strict"; return (${e});`)();
  if (typeof v !== 'number' || !isFinite(v)) throw new Error('That does not compute.');
  return v;
}

const WEATHER = {
  0: 'Clear sky ☀️', 1: 'Mostly clear 🌤️', 2: 'Partly cloudy ⛅', 3: 'Overcast ☁️', 45: 'Fog 🌫️', 48: 'Fog 🌫️',
  51: 'Light drizzle 🌦️', 53: 'Drizzle 🌦️', 55: 'Heavy drizzle 🌧️', 61: 'Light rain 🌧️', 63: 'Rain 🌧️', 65: 'Heavy rain 🌧️',
  71: 'Light snow 🌨️', 73: 'Snow 🌨️', 75: 'Heavy snow ❄️', 80: 'Rain showers 🌦️', 81: 'Rain showers 🌧️', 82: 'Violent showers ⛈️',
  95: 'Thunderstorm ⛈️', 96: 'Thunderstorm with hail ⛈️', 99: 'Thunderstorm with hail ⛈️',
};

const COINS = { btc: 'bitcoin', eth: 'ethereum', xlm: 'stellar', sol: 'solana', usdt: 'tether', usdc: 'usd-coin', bnb: 'binancecoin', xrp: 'ripple', ada: 'cardano', doge: 'dogecoin', ton: 'the-open-network', trx: 'tron', matic: 'matic-network', dot: 'polkadot', ltc: 'litecoin' };

const mentionsOwner = (ctx) => {
  const info = ctx.content.extendedTextMessage?.contextInfo || {};
  const owner = [config.ownerNumber, num(ctx.sock.user?.id), num(ctx.sock.user?.lid)].filter(Boolean);
  const ids = [...(info.mentionedJid || []), info.participant].filter(Boolean).map(num);
  return ids.some((i) => owner.includes(i));
};
const afkSeen = new Map(); // chat -> last auto-reply time

module.exports = {
  /** AFK: tell people the owner is away. Switches itself off when the owner writes again. */
  async onMessage(ctx) {
    const afk = store.db.afk;
    if (!afk) return;
    if (ctx.fromMe) {
      const t = getText(ctx.msg.message);
      if (t && !t.startsWith(config.prefix) && Date.now() - afk.since > 15000) {
        store.db.afk = null;
        store.save();
        await ctx.sock.sendMessage(ownerJid(ctx.sock), { text: '✅ AFK mode turned off, welcome back.' });
      }
      return;
    }
    if (ctx.isOwner) return;
    if (!(ctx.isGroup ? mentionsOwner(ctx) : true)) return;
    if (Date.now() - (afkSeen.get(ctx.jid) || 0) < 15 * 60 * 1000) return;
    afkSeen.set(ctx.jid, Date.now());
    await ctx.sock.sendMessage(
      ctx.jid,
      { text: `😴 *${config.ownerName} is away* (${fmtDur(Date.now() - afk.since)})${afk.reason ? `\n📝 ${afk.reason}` : ''}\nThey will get back to you soon.` },
      { quoted: ctx.msg }
    );
  },

  commands: [
    {
      name: 'alive',
      aliases: ['status'],
      desc: 'Show that the bot is online, with uptime',
      async run(ctx) {
        await ctx.reply(`⚡ *${config.botName}* is alive\n⏱️ Uptime: ${fmtDur(Date.now() - startedAt)}\n🧠 Memory: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n👑 Owner: ${config.ownerName}`);
      },
    },
    {
      name: 'runtime',
      aliases: ['uptime'],
      desc: 'How long the bot has been running',
      async run(ctx) {
        await ctx.reply(`⏱️ Running for ${fmtDur(Date.now() - startedAt)}`);
      },
    },
    {
      name: 'jid',
      desc: 'Show the id of this chat (or the replied / mentioned person)',
      async run(ctx) {
        const t = getTargets(ctx);
        await ctx.reply(t.length ? t.join('\n') : ctx.jid);
      },
    },
    {
      name: 'getpp',
      aliases: ['pp'],
      desc: 'Get someone\'s profile picture (reply / @mention), or the group\'s picture',
      async run(ctx) {
        const [t] = getTargets(ctx);
        const target = t || (ctx.isGroup ? ctx.jid : ctx.jid);
        let url;
        try {
          url = await ctx.sock.profilePictureUrl(target, 'image');
        } catch {
          return ctx.reply('No profile picture, or their privacy settings hide it.');
        }
        await ctx.sock.sendMessage(ctx.jid, { image: await getBuffer(url) }, { quoted: ctx.msg });
      },
    },
    {
      name: 'setpp',
      owner: true,
      desc: 'Reply to a photo to set it as the bot\'s profile picture',
      async run(ctx) {
        const media = findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));
        if (!media || media.type !== 'image') return ctx.reply('Reply to a photo with .setpp');
        await ctx.sock.updateProfilePicture(ctx.sock.user.id.replace(/:\d+/, ''), await downloadMedia(media));
        await ctx.reply('✅ Profile picture updated.');
      },
    },
    {
      name: 'setbio',
      owner: true,
      desc: 'Change the bot account\'s About text',
      async run(ctx) {
        if (!ctx.text) return ctx.reply('.setbio your new about text');
        await ctx.sock.updateProfileStatus(ctx.text.slice(0, 139));
        await ctx.reply('✅ Bio updated.');
      },
    },
    {
      name: 'block',
      owner: true,
      desc: 'Block someone (reply / @mention / number) or this DM',
      async run(ctx) {
        const [t] = getTargets(ctx);
        const target = t || (!ctx.isGroup ? ctx.jid : null);
        if (!target) return ctx.reply('Reply to someone or give a number.');
        await ctx.sock.updateBlockStatus(target, 'block');
        await ctx.reply(`🚫 Blocked +${num(target)}`);
      },
    },
    {
      name: 'unblock',
      owner: true,
      desc: 'Unblock someone (reply / @mention / number)',
      async run(ctx) {
        const [t] = getTargets(ctx);
        const target = t || (!ctx.isGroup ? ctx.jid : null);
        if (!target) return ctx.reply('Reply to someone or give a number.');
        await ctx.sock.updateBlockStatus(target, 'unblock');
        await ctx.reply(`✅ Unblocked +${num(target)}`);
      },
    },
    {
      name: 'afk',
      owner: true,
      desc: 'Away mode: .afk gone to sleep. The bot tells people you are away. Writing a normal message turns it off',
      async run(ctx) {
        if (store.db.afk && !ctx.text) {
          store.db.afk = null;
          store.save();
          return ctx.reply('✅ AFK mode is off.');
        }
        store.db.afk = { since: Date.now(), reason: ctx.text.slice(0, 200) };
        store.save();
        afkSeen.clear();
        await ctx.reply(`😴 AFK mode is on${ctx.text ? `: ${ctx.text}` : ''}. Send any normal message to turn it off.`);
      },
    },
    {
      name: 'exportsession',
      aliases: ['getsession'],
      owner: true,
      desc: 'Get a SESSION_ID for hosts with no persistent disk (sent only to your own chat)',
      async run(ctx) {
        if (ctx.isGroup) return ctx.reply('Use this in your own private chat with the bot.');
        const file = 'session/creds.json';
        if (!fs.existsSync(file)) return ctx.reply('No saved session found.');
        const id = 'VOLTRON:~' + Buffer.from(fs.readFileSync(file)).toString('base64');
        await ctx.sock.sendMessage(ctx.jid, { text: `🔐 *SESSION_ID* (this is your WhatsApp login, never share it). Put it in your host's SESSION_ID variable, then delete this message.\n\n${id}` });
      },
    },

    // ---------- everyday tools ----------
    {
      name: 'calc',
      aliases: ['calculate'],
      desc: 'Calculator: .calc (12+8)*3/4',
      async run(ctx) {
        if (!ctx.text) return ctx.reply('.calc 12*(3+4)');
        await ctx.reply(`🧮 ${ctx.text} = *${Number(calc(ctx.text).toFixed(10))}*`);
      },
    },
    {
      name: 'weather',
      desc: 'Weather for a city: .weather Lagos',
      async run(ctx) {
        if (!ctx.text) return ctx.reply('.weather Lagos');
        const geo = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(ctx.text)}`);
        const place = geo.results?.[0];
        if (!place) return ctx.reply('I could not find that place.');
        const w = (await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto`)).current;
        await ctx.reply(`🌍 *${place.name}, ${place.country || ''}*\n${WEATHER[w.weather_code] || 'Unknown'}\n🌡️ ${w.temperature_2m}°C (feels ${w.apparent_temperature}°C)\n💧 Humidity ${w.relative_humidity_2m}%\n💨 Wind ${w.wind_speed_10m} km/h`);
      },
    },
    {
      name: 'wiki',
      aliases: ['wikipedia'],
      desc: 'Wikipedia summary: .wiki Stellar blockchain',
      async run(ctx) {
        if (!ctx.text) return ctx.reply('.wiki something');
        const s = await getJSON(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&search=${encodeURIComponent(ctx.text)}`);
        const title = s[1]?.[0];
        if (!title) return ctx.reply('Nothing found on Wikipedia.');
        const d = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
        await ctx.reply(`📚 *${d.title}*\n\n${(d.extract || '').slice(0, 1200)}\n\n${d.content_urls?.desktop?.page || ''}`);
      },
    },
    {
      name: 'define',
      aliases: ['dict', 'meaning'],
      desc: 'Dictionary: .define serendipity',
      async run(ctx) {
        const word = ctx.args[0];
        if (!word) return ctx.reply('.define word');
        let d;
        try {
          d = await getJSON(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
        } catch {
          return ctx.reply(`No definition found for "${word}".`);
        }
        const e = d[0];
        const lines = (e.meanings || []).slice(0, 3).map((m) => `_${m.partOfSpeech}_: ${m.definitions[0]?.definition}`);
        await ctx.reply(`📖 *${e.word}* ${e.phonetic || ''}\n\n${lines.join('\n\n')}`);
      },
    },
    {
      name: 'translate',
      aliases: ['tr', 'trt'],
      desc: 'Translate: .tr fr good morning  (or reply to a message with .tr yo)',
      async run(ctx) {
        let lang = 'en';
        let text = ctx.text;
        if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(ctx.args[0] || '') && (ctx.args.length > 1 || ctx.quoted)) {
          lang = ctx.args[0];
          text = ctx.args.slice(1).join(' ');
        }
        if (!text && ctx.quoted) text = getText(ctx.quoted.message);
        if (!text) return ctx.reply('.tr fr hello there  (or reply to a message: .tr yo)');
        const d = await getJSON(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`);
        const out = (d[0] || []).map((x) => x[0]).join('');
        await ctx.reply(`🌐 *${d[2] || '?'} ➜ ${lang}*\n\n${out}`);
      },
    },
    {
      name: 'short',
      aliases: ['shorten', 'tinyurl'],
      desc: 'Shorten a link: .short https://example.com/very/long',
      async run(ctx) {
        const url = ctx.args[0];
        if (!/^https?:\/\//i.test(url || '')) return ctx.reply('.short https://example.com');
        const res = await (await fetchOk(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`)).text();
        await ctx.reply(`🔗 ${res.trim()}`);
      },
    },
    {
      name: 'qr',
      desc: 'Make a QR code: .qr any text or link',
      async run(ctx) {
        if (!ctx.text) return ctx.reply('.qr https://example.com');
        const img = await getBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=600x600&margin=10&data=${encodeURIComponent(ctx.text)}`);
        await ctx.sock.sendMessage(ctx.jid, { image: img, caption: ctx.text.slice(0, 200) }, { quoted: ctx.msg });
      },
    },
    {
      name: 'ss',
      aliases: ['screenshot'],
      desc: 'Screenshot of a website: .ss https://example.com',
      async run(ctx) {
        const url = ctx.args[0];
        if (!/^https?:\/\//i.test(url || '')) return ctx.reply('.ss https://example.com');
        const img = await getBuffer(`https://image.thum.io/get/width/1280/crop/800/noanimate/${url}`);
        await ctx.sock.sendMessage(ctx.jid, { image: img, caption: url }, { quoted: ctx.msg });
      },
    },
    {
      name: 'github',
      aliases: ['gh'],
      desc: 'GitHub profile: .github teethaking',
      async run(ctx) {
        const u = ctx.args[0];
        if (!u) return ctx.reply('.github username');
        let d;
        try {
          d = await getJSON(`https://api.github.com/users/${encodeURIComponent(u)}`);
        } catch {
          return ctx.reply('GitHub user not found.');
        }
        const caption = `🐙 *${d.name || d.login}* (@${d.login})\n${d.bio || ''}\n\n📦 Repos: ${d.public_repos}  👥 Followers: ${d.followers}  ➡️ Following: ${d.following}\n🔗 ${d.html_url}`;
        try {
          await ctx.sock.sendMessage(ctx.jid, { image: await getBuffer(d.avatar_url), caption }, { quoted: ctx.msg });
        } catch {
          await ctx.reply(caption);
        }
      },
    },
    {
      name: 'price',
      aliases: ['crypto'],
      desc: 'Crypto price: .price btc  (also eth, xlm, sol, usdt...)',
      async run(ctx) {
        const q = (ctx.args[0] || '').toLowerCase();
        if (!q) return ctx.reply('.price btc');
        const id = COINS[q] || q;
        const d = (await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,ngn&include_24hr_change=true`))[id];
        if (!d) return ctx.reply(`I do not know "${q}". Try btc, eth, xlm, sol or a CoinGecko id.`);
        const ch = d.usd_24h_change;
        await ctx.reply(`💰 *${q.toUpperCase()}*\n💵 $${d.usd.toLocaleString('en-US')}\n🇳🇬 ₦${(d.ngn || 0).toLocaleString('en-US')}\n${ch >= 0 ? '📈' : '📉'} 24h: ${ch?.toFixed(2)}%`);
      },
    },
    {
      name: 'quote',
      desc: 'A random quote',
      async run(ctx) {
        const [q] = await getJSON('https://zenquotes.io/api/random');
        await ctx.reply(`💬 _${q.q}_\n— *${q.a}*`);
      },
    },
    {
      name: 'joke',
      desc: 'A random joke',
      async run(ctx) {
        const j = await getJSON('https://official-joke-api.appspot.com/random_joke');
        await ctx.reply(`😂 ${j.setup}\n\n${j.punchline}`);
      },
    },
    {
      name: 'fact',
      desc: 'A random fact',
      async run(ctx) {
        const f = await getJSON('https://uselessfacts.jsph.pl/api/v2/facts/random?language=en');
        await ctx.reply(`🧠 ${f.text}`);
      },
    },
    {
      name: 'dice',
      aliases: ['roll'],
      desc: 'Roll a dice: .dice or .dice 20',
      async run(ctx) {
        const sides = Math.min(1000, Math.max(2, parseInt(ctx.args[0], 10) || 6));
        await ctx.reply(`🎲 You rolled *${1 + Math.floor(Math.random() * sides)}* (d${sides})`);
      },
    },
    {
      name: 'flip',
      aliases: ['coin'],
      desc: 'Flip a coin',
      async run(ctx) {
        await ctx.reply(`🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}!`);
      },
    },
    {
      name: 'pick',
      aliases: ['choose'],
      desc: 'Pick one: .pick pizza, rice, burger',
      async run(ctx) {
        const opts = ctx.text.split(/,|\||\bor\b/i).map((s) => s.trim()).filter(Boolean);
        if (opts.length < 2) return ctx.reply('.pick pizza, rice, burger');
        await ctx.reply(`🎯 I pick: *${opts[Math.floor(Math.random() * opts.length)]}*`);
      },
    },
    {
      name: 'password',
      aliases: ['pass'],
      desc: 'Generate a strong password: .password 16',
      async run(ctx) {
        const len = Math.min(64, Math.max(8, parseInt(ctx.args[0], 10) || 16));
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
        const bytes = require('crypto').randomBytes(len);
        await ctx.reply(`🔐 ${[...bytes].map((b) => chars[b % chars.length]).join('')}`);
      },
    },
    {
      name: 'time',
      desc: 'Current time: .time or .time Asia/Tokyo',
      async run(ctx) {
        const tz = ctx.args[0] || config.timezone;
        try {
          const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' }).format(new Date());
          await ctx.reply(`🕒 *${tz}*\n${d}`);
        } catch {
          await ctx.reply('Unknown timezone. Use names like Africa/Lagos, Europe/London, America/New_York.');
        }
      },
    },
    {
      name: 'fancy',
      aliases: ['font'],
      desc: 'Stylish text: .fancy your text',
      async run(ctx) {
        const t = ctx.text || (ctx.quoted && getText(ctx.quoted.message));
        if (!t) return ctx.reply('.fancy your text');
        const out = Object.entries(STYLES).map(([, m]) => apply(m, t));
        out.push([...t.toLowerCase()].map((c) => SMALLCAPS[c] || c).join(''));
        out.push([...t].reverse().join(''));
        await ctx.reply(out.join('\n\n'));
      },
    },
    {
      name: 'base64',
      aliases: ['b64'],
      desc: 'Encode or decode: .base64 enc hello  |  .base64 dec aGVsbG8=',
      async run(ctx) {
        const [mode, ...rest] = ctx.args;
        const t = rest.join(' ');
        if (!['enc', 'dec'].includes(mode) || !t) return ctx.reply('.base64 enc text  |  .base64 dec text');
        await ctx.reply(mode === 'enc' ? Buffer.from(t).toString('base64') : Buffer.from(t, 'base64').toString('utf8'));
      },
    },
  ],
};
