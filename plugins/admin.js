const fs = require('fs');
const store = require('../lib/store');
const { num, getTargets } = require('../lib/group');
const { findMedia, downloadMedia } = require('../lib/utils');
const path = require('path');
const COOKIES = path.join(store.DIR, 'cookies.txt');

const stickerHash = (node) => Buffer.from(node.fileSha256 || []).toString('base64');

module.exports = {
  commands: [
    // ---------- sudo ----------
    {
      name: 'addsudo',
      aliases: ['setsudo'],
      owner: true,
      cat: 'Owner',
      desc: 'Let someone use the bot. Reply to them, @mention, or give a number.',
      async run(ctx) {
        const targets = getTargets(ctx);
        if (!targets.length) return ctx.reply(`Usage: ${ctx.config.prefix}addsudo @user (or reply, or a number)`);
        const added = [];
        for (const jid of targets) {
          const n = num(jid);
          if (!store.db.sudo.includes(n)) store.db.sudo.push(n);
          added.push(jid);
        }
        store.saveNow();
        await ctx.sock.sendMessage(
          ctx.jid,
          { text: `Sudo added: ${added.map((j) => '@' + num(j)).join(', ')}`, mentions: added },
          { quoted: ctx.msg }
        );
      },
    },
    {
      name: 'delsudo',
      aliases: ['remsudo'],
      owner: true,
      cat: 'Owner',
      desc: 'Remove someone from sudo.',
      async run(ctx) {
        const targets = getTargets(ctx);
        if (!targets.length) return ctx.reply(`Usage: ${ctx.config.prefix}delsudo @user (or reply, or a number)`);
        const gone = new Set(targets.map(num));
        const before = store.db.sudo.length;
        store.db.sudo = store.db.sudo.filter((n) => !gone.has(n));
        store.saveNow();
        await ctx.reply(store.db.sudo.length < before ? 'Sudo removed.' : 'That user was not a sudo.');
      },
    },
    {
      name: 'sudolist',
      aliases: ['getsudo'],
      owner: true,
      cat: 'Owner',
      desc: 'Show all sudo users.',
      async run(ctx) {
        if (!store.db.sudo.length) return ctx.reply('No sudo users yet.');
        const jids = store.db.sudo.map((n) => `${n}@s.whatsapp.net`);
        await ctx.sock.sendMessage(
          ctx.jid,
          { text: `*Sudo users*\n${jids.map((j, i) => `${i + 1}. @${num(j)}`).join('\n')}`, mentions: jids },
          { quoted: ctx.msg }
        );
      },
    },

    // ---------- mode ----------
    {
      name: 'mode',
      owner: true,
      cat: 'Owner',
      desc: 'private = only you and sudo can use the bot, public = everyone. Usage: .mode private',
      async run(ctx) {
        const m = (ctx.args[0] || '').toLowerCase();
        if (!['private', 'public'].includes(m)) {
          return ctx.reply(`Current mode: ${store.db.mode || ctx.config.mode}\nUsage: ${ctx.config.prefix}mode private|public`);
        }
        store.db.mode = m;
        store.saveNow();
        await ctx.reply(`Mode set to ${m}.`);
      },
    },

    // ---------- sticker commands ----------
    {
      name: 'setcmd',
      aliases: ['scmd'],
      owner: true,
      cat: 'Owner',
      desc: 'Bind a command to a sticker. Reply to the sticker: .setcmd vv me',
      async run(ctx) {
        const media = ctx.quoted && findMedia(ctx.quoted.message);
        if (!media || media.type !== 'sticker') return ctx.reply(`Reply to a sticker: ${ctx.config.prefix}setcmd vv me`);

        const bound = ctx.text.replace(new RegExp('^' + ctx.config.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').trim();
        const [name] = bound.split(/\s+/);
        const target = ctx.getCommand(name?.toLowerCase());
        if (!target) return ctx.reply(`"${name || ''}" is not a command. Check ${ctx.config.prefix}menu.`);
        if (target.owner && ['setcmd', 'delcmd'].includes(target.name)) return ctx.reply('That one cannot be bound to a sticker.');

        store.db.stickerCmds[stickerHash(media.node)] = bound;
        store.saveNow();
        await ctx.reply(`Done. Sending that sticker now runs: ${ctx.config.prefix}${bound}`);
      },
    },
    {
      name: 'delcmd',
      aliases: ['dcmd'],
      owner: true,
      cat: 'Owner',
      desc: 'Unbind a sticker. Reply to the sticker with .delcmd',
      async run(ctx) {
        const media = ctx.quoted && findMedia(ctx.quoted.message);
        if (!media || media.type !== 'sticker') return ctx.reply('Reply to the sticker you want to unbind.');
        const h = stickerHash(media.node);
        if (!store.db.stickerCmds[h]) return ctx.reply('That sticker has no command.');
        delete store.db.stickerCmds[h];
        store.saveNow();
        await ctx.reply('Sticker command removed.');
      },
    },
    {
      name: 'listcmd',
      aliases: ['lcmd'],
      owner: true,
      cat: 'Owner',
      desc: 'List all sticker commands.',
      async run(ctx) {
        const entries = Object.values(store.db.stickerCmds);
        if (!entries.length) return ctx.reply('No sticker commands set.');
        await ctx.reply(`*Sticker commands*\n${entries.map((c, i) => `${i + 1}. ${ctx.config.prefix}${c}`).join('\n')}`);
      },
    },

    // ---------- YouTube cookies ----------
    {
      name: 'setcookies',
      aliases: ['cookies'],
      owner: true,
      cat: 'Owner',
      desc: 'Save a YouTube cookies.txt so downloads stop asking to "sign in". Send the file with this as the caption, or reply to it.',
      async run(ctx) {
        const media = findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));
        if (!media || media.type !== 'document') {
          return ctx.reply(`Send your cookies.txt file with the caption ${ctx.config.prefix}setcookies, or reply to it with that command.`);
        }
        const text = (await downloadMedia(media)).toString('utf8');
        if (!text.includes('\t') || !/youtube\.com|google\.com/.test(text)) {
          return ctx.reply('That does not look like a cookies.txt (Netscape format) with YouTube/Google cookies.');
        }
        fs.writeFileSync(COOKIES, text, { mode: 0o600 });
        await ctx.reply('Cookies saved. Downloads use them straight away. Delete that file from this chat now, it is your login.');
      },
    },
    {
      name: 'delcookies',
      owner: true,
      cat: 'Owner',
      desc: 'Delete the saved YouTube cookies.',
      async run(ctx) {
        fs.rmSync(COOKIES, { force: true });
        await ctx.reply('Saved cookies deleted.');
      },
    },

    // ---------- menu image ----------
    {
      name: 'setmenu',
      aliases: ['menuimg'],
      owner: true,
      cat: 'Owner',
      desc: 'Set the image shown with the menu. Send/reply to an image (or give a link). ".setmenu reset" removes it.',
      async run(ctx) {
        if (ctx.args[0]?.toLowerCase() === 'reset') {
          fs.rmSync(store.menuPath, { force: true });
          store.db.menuImage = false;
          store.saveNow();
          return ctx.reply('Menu image removed.');
        }

        let buffer;
        const media = findMedia(ctx.msg.message) || (ctx.quoted && findMedia(ctx.quoted.message));
        if (media && media.type === 'image') {
          buffer = await downloadMedia(media);
        } else if (/^https?:\/\//i.test(ctx.args[0] || '')) {
          const res = await fetch(ctx.args[0]);
          if (!res.ok) return ctx.reply(`Could not fetch that link (HTTP ${res.status}).`);
          if (!(res.headers.get('content-type') || '').startsWith('image/')) return ctx.reply('That link is not an image.');
          buffer = Buffer.from(await res.arrayBuffer());
        } else {
          return ctx.reply(`Send an image with the caption ${ctx.config.prefix}setmenu, reply to an image, or pass an image link.`);
        }

        fs.writeFileSync(store.menuPath, buffer);
        store.db.menuImage = true;
        store.saveNow();
        await ctx.reply(`Menu image saved. Try ${ctx.config.prefix}menu`);
      },
    },
  ],
};
