const config = require('../config');

/** "2348012345678:12@s.whatsapp.net" / "...@lid" -> "2348012345678" */
const num = (jid) => (jid || '').split('@')[0].split(':')[0];

/** Does this group participant correspond to this jid? (handles phone-number and LID ids) */
function sameUser(participant, jid) {
  const n = num(jid);
  if (!n) return false;
  return [participant.id, participant.lid, participant.phoneNumber].filter(Boolean).some((x) => num(x) === n);
}

const isAdmin = (meta, jid) => meta.participants.some((p) => p.admin && sameUser(p, jid));
const botJids = (sock) => [sock.user?.id, sock.user?.lid].filter(Boolean);
const isBot = (sock, p) => botJids(sock).some((j) => sameUser(p, j));
const botIsAdmin = (meta, sock) => botJids(sock).some((j) => isAdmin(meta, j));

/** Find the participant entry for a jid. */
const findParticipant = (meta, jid) => meta.participants.find((p) => sameUser(p, jid));

/**
 * Targets from @mentions, the replied-to message, or phone numbers in `args`.
 * Returns an array of jids (deduplicated).
 */
function getTargets(ctx, args = ctx.args) {
  const out = new Set();
  const info =
    ctx.content.extendedTextMessage?.contextInfo ||
    ctx.content.imageMessage?.contextInfo ||
    ctx.content.videoMessage?.contextInfo ||
    {};
  for (const j of info.mentionedJid || []) out.add(j);
  if (!out.size && ctx.quoted?.participant) out.add(ctx.quoted.participant);
  for (const a of args) {
    const d = a.replace(/\D/g, '');
    if (d.length >= 7 && d.length <= 15 && !a.startsWith('@lid')) out.add(`${d}@s.whatsapp.net`);
  }
  return [...out];
}

/**
 * Standard checks for group commands. Replies and returns null when the command should stop,
 * otherwise returns the group metadata.
 */
async function guard(ctx, { needBotAdmin = true } = {}) {
  if (!ctx.isGroup) {
    await ctx.reply('This command only works in groups.');
    return null;
  }
  const meta = await ctx.sock.groupMetadata(ctx.jid);
  const allowed = ctx.isOwner || ctx.isSudo || isAdmin(meta, ctx.sender);
  if (!allowed) {
    await ctx.reply('Only group admins can use this.');
    return null;
  }
  if (needBotAdmin && !botIsAdmin(meta, ctx.sock)) {
    await ctx.reply(`Make me a group admin first so I can do that.`);
    return null;
  }
  return meta;
}

/** Why a target must not be removed, or null if it is fine. */
function protectedReason(ctx, meta, participant) {
  if (isBot(ctx.sock, participant)) return `I won't remove myself.`;
  if (config.ownerNumber && sameUser(participant, `${config.ownerNumber}@s.whatsapp.net`)) {
    return `I won't remove my owner.`;
  }
  if (participant.admin && !ctx.isOwner) return 'Only the owner can remove admins.';
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  num,
  sameUser,
  isAdmin,
  isBot,
  botIsAdmin,
  findParticipant,
  getTargets,
  guard,
  protectedReason,
  sleep,
};
