const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('./store');
const sent = require('./sent');
const { getText, getQuoted, unwrap } = require('./utils');

const commands = new Map(); // name/alias -> command
const unique = new Set(); // unique command objects (for the menu)
const listeners = []; // plugins that want every message
const groupListeners = []; // plugins that want join/leave/promote events
const reactionListeners = []; // plugins that want emoji reactions

const num = (jid) => (jid || '').split('@')[0].split(':')[0];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function loadPlugins() {
  const dir = path.join(__dirname, '..', 'plugins');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    let plugin;
    try {
      plugin = require(path.join(dir, file));
    } catch (e) {
      console.error(`Plugin ${file} failed to load, skipping it: ${e.message.split('\n')[0]}`);
      continue;
    }
    const category = cap(path.basename(file, '.js'));
    for (const cmd of [].concat(plugin.commands || [])) {
      cmd.cat = cmd.cat || category;
      unique.add(cmd);
      commands.set(cmd.name, cmd);
      for (const a of cmd.aliases || []) commands.set(a, cmd);
    }
    if (typeof plugin.onMessage === 'function') listeners.push(plugin.onMessage);
    if (typeof plugin.onGroupUpdate === 'function') groupListeners.push(plugin.onGroupUpdate);
    if (typeof plugin.onReaction === 'function') reactionListeners.push(plugin.onReaction);
  }
  console.log(`Loaded ${unique.size} commands`);
}

const getCommand = (name) => commands.get(name);

function isOwnerJid(jid) {
  return !!config.ownerNumber && num(jid) === config.ownerNumber;
}

async function handle(sock, msg) {
  if (!msg.message) return;
  const jid = msg.key.remoteJid;
  if (jid === 'status@broadcast') return;
  if (sent.has(msg.key.id)) return; // our own bot message echoing back

  const sender = msg.key.participant || jid;
  const fromMe = !!msg.key.fromMe;
  const isOwner = fromMe || isOwnerJid(sender);
  const isSudo = !isOwner && store.db.sudo.includes(num(sender));

  const ctx = {
    sock,
    msg,
    jid,
    sender,
    isOwner,
    isSudo,
    fromMe,
    // who is speaking, even for messages sent from the owner's own phone (no participant on those)
    player: {
      jid: fromMe ? `${num(sock.user?.id)}@s.whatsapp.net` : sender,
      name: msg.pushName || (fromMe ? config.ownerName : num(sender)),
    },
    isGroup: jid.endsWith('@g.us'),
    quoted: getQuoted(msg.message),
    content: unwrap(msg.message),
    reply: (text) => sock.sendMessage(jid, { text }, { quoted: msg }),
    commands: unique,
    getCommand,
    config,
  };

  // Passive listeners (activity tracking, auto view-once save) run for everyone.
  for (const fn of listeners) {
    try {
      await fn(ctx);
    } catch (e) {
      console.error('listener error:', e.message);
    }
  }

  let text = getText(msg.message).trim();

  // A sticker bound to a command (.setcmd) runs that command, for owner/sudo only.
  if (!text && ctx.content.stickerMessage && (isOwner || isSudo)) {
    const hash = Buffer.from(ctx.content.stickerMessage.fileSha256 || []).toString('base64');
    const bound = hash && store.db.stickerCmds[hash];
    if (bound) text = config.prefix + bound;
  }

  if (!text.startsWith(config.prefix)) return;

  const [rawName, ...rest] = text.slice(config.prefix.length).split(/\s+/);
  const cmd = commands.get((rawName || '').toLowerCase());
  if (!cmd) return;

  // Private mode: only the owner and sudo users can run commands, except `public` ones (games).
  const mode = store.db.mode || config.mode;
  if (mode === 'private' && !isOwner && !isSudo && !cmd.public) return;

  if (cmd.owner && !isOwner) return ctx.reply('This command is for the bot owner only.');

  ctx.args = rest;
  ctx.text = rest.join(' ');

  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await cmd.run(ctx);
  } catch (e) {
    console.error(`[${cmd.name}]`, e);
    await ctx.reply(`Something went wrong with ${config.prefix}${cmd.name}: ${e.message.split('\n')[0]}`);
  }
}

/** Someone joined / left / was promoted / demoted in a group. */
async function handleGroupParticipants(sock, ev) {
  for (const fn of groupListeners) {
    try {
      await fn(sock, ev);
    } catch (e) {
      console.error('group listener error:', e.message);
    }
  }
}

/** An emoji reaction. Only the owner / sudo users (or the owner's own phone) can trigger actions. */
async function handleReaction(sock, msg, reaction) {
  if (sent.has(msg.key.id)) return;
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || jid;
  const fromMe = !!msg.key.fromMe;
  const isOwner = fromMe || isOwnerJid(sender);
  const isSudo = !isOwner && store.db.sudo.includes(num(sender));
  if (!reaction.text || !(isOwner || isSudo)) return;
  const ev = { sock, msg, jid, sender, fromMe, isOwner, isSudo, emoji: reaction.text, target: reaction.key, config };
  for (const fn of reactionListeners) {
    try {
      await fn(ev);
    } catch (e) {
      console.error('reaction listener error:', e.message);
    }
  }
}

module.exports = { loadPlugins, handle, handleGroupParticipants, handleReaction, commands: unique };
