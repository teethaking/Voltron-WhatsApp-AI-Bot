const scheduler = require('./scheduler');
const { parseDuration, formatDuration } = require('./time');
const { num, botIsAdmin, findParticipant, protectedReason, isBot, sleep } = require('./group');

/**
 * Group operations used by the AI assistant. Callers must already have verified that the
 * request comes from the bot owner: these functions do no permission checks of their own.
 */

const MAX_TARGETS = 10;

async function prepare(sock, jid) {
  if (!jid.endsWith('@g.us')) throw new Error('That only works in a group chat.');
  const meta = await sock.groupMetadata(jid);
  if (!botIsAdmin(meta, sock)) throw new Error('I am not a group admin, so I cannot do that.');
  return meta;
}

/** Remove members; with `tempMs` they are added back after that time. */
async function kick(sock, jid, targets, tempMs = 0) {
  const meta = await prepare(sock, jid);
  const ownerCtx = { sock, isOwner: true };
  const done = [];
  const skipped = [];

  for (const t of targets.slice(0, MAX_TARGETS)) {
    const p = findParticipant(meta, t);
    if (!p) {
      skipped.push(`+${num(t)} is not in this group`);
      continue;
    }
    const why = protectedReason(ownerCtx, meta, p);
    if (why) {
      skipped.push(`+${num(p.id)}: ${why}`);
      continue;
    }
    try {
      await sock.groupParticipantsUpdate(jid, [p.id], 'remove');
      if (tempMs) scheduler.add('readd', jid, tempMs, { user: p.id });
      done.push(p.id);
    } catch (e) {
      skipped.push(`+${num(p.id)}: ${e.message}`);
    }
    await sleep(1200);
  }

  const verb = tempMs ? `Removed for ${formatDuration(tempMs)} (will be added back)` : 'Removed';
  return `${verb}: ${done.map((j) => '+' + num(j)).join(', ') || 'nobody'}.${skipped.length ? ' Skipped: ' + skipped.join('; ') + '.' : ''}`;
}

/** Close (admins only) or open the group, optionally flipping back after a duration. */
async function setClosed(sock, jid, closed, durationText) {
  const ms = durationText ? parseDuration(durationText) : null;
  if (durationText && !ms) throw new Error('The time was not understood. Use 30s, 10m, 2h or 1d (max 7 days).');
  await prepare(sock, jid);

  scheduler.cancelGroup(jid, ['open', 'close']);
  await sock.groupSettingUpdate(jid, closed ? 'announcement' : 'not_announcement');
  if (ms) scheduler.add(closed ? 'open' : 'close', jid, ms);

  const state = closed ? 'closed (admins only)' : 'open (everyone can chat)';
  return `Group is now ${state}${ms ? ` for ${formatDuration(ms)}, then it switches back automatically` : ''}.`;
}

/** Make members admins or remove their admin rights. */
async function setAdmin(sock, jid, targets, promote) {
  const meta = await prepare(sock, jid);
  const done = [];
  const skipped = [];
  for (const t of targets.slice(0, MAX_TARGETS)) {
    const p = findParticipant(meta, t);
    if (!p) {
      skipped.push(`+${num(t)} is not in this group`);
      continue;
    }
    if (!promote && isBot(sock, p)) {
      skipped.push('I will not demote myself');
      continue;
    }
    try {
      await sock.groupParticipantsUpdate(jid, [p.id], promote ? 'promote' : 'demote');
      done.push(p.id);
    } catch (e) {
      skipped.push(`+${num(p.id)}: ${e.message}`);
    }
    await sleep(800);
  }
  return `${promote ? 'Made admin' : 'Removed admin from'}: ${done.map((j) => '+' + num(j)).join(', ') || 'nobody'}.${skipped.length ? ' Skipped: ' + skipped.join('; ') + '.' : ''}`;
}

module.exports = { kick, setClosed, setAdmin };
