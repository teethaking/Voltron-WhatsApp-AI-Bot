const store = require('./store');

/**
 * Persistent one-shot jobs. Types:
 *   close  - set the group to admins-only
 *   open   - set the group back to everyone
 *   readd  - add a temp-kicked member back (falls back to a DM invite link)
 */
let sock = null;
const handles = new Map();

function arm(task) {
  clearTimeout(handles.get(task.id));
  const delay = Math.min(Math.max(0, task.at - Date.now()), 2 ** 31 - 1);
  handles.set(task.id, setTimeout(() => fire(task), delay));
}

function remove(task) {
  clearTimeout(handles.get(task.id));
  handles.delete(task.id);
  const i = store.db.timers.findIndex((t) => t.id === task.id);
  if (i >= 0) store.db.timers.splice(i, 1);
  store.saveNow();
}

async function fire(task) {
  if (!sock) return setTimeout(() => fire(task), 10_000); // not connected yet, retry
  try {
    if (task.type === 'close') {
      await sock.groupSettingUpdate(task.group, 'announcement');
      await sock.sendMessage(task.group, { text: 'Time is up. Group is now closed (admins only).' });
    } else if (task.type === 'open') {
      await sock.groupSettingUpdate(task.group, 'not_announcement');
      await sock.sendMessage(task.group, { text: 'Time is up. Group is open again, everyone can send messages.' });
    } else if (task.type === 'readd') {
      const res = await sock.groupParticipantsUpdate(task.group, [task.user], 'add');
      const status = String(res?.[0]?.status || '');
      if (status === '200') {
        await sock.sendMessage(task.group, {
          text: `@${task.user.split('@')[0]} is back after the temporary removal.`,
          mentions: [task.user],
        });
      } else {
        // Could not add directly (privacy settings etc.): send them an invite link instead.
        const code = await sock.groupInviteCode(task.group);
        await sock.sendMessage(task.user, {
          text: `Your temporary removal is over. You can rejoin here:\nhttps://chat.whatsapp.com/${code}`,
        });
      }
    }
  } catch (e) {
    console.error(`scheduler ${task.type} failed:`, e.message);
  }
  remove(task);
}

/** Schedule a job `ms` from now. Replaces nothing; use cancelGroup first if needed. */
function add(type, group, ms, extra = {}) {
  const task = { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, type, group, at: Date.now() + ms, ...extra };
  store.db.timers.push(task);
  store.saveNow();
  arm(task);
  return task;
}

/** Cancel pending jobs of the given types for a group (e.g. a new .close replaces the old timer). */
function cancelGroup(group, types) {
  for (const t of [...store.db.timers]) {
    if (t.group === group && types.includes(t.type)) remove(t);
  }
}

/** Call whenever a (re)connected socket is available: re-arms every saved job. */
function setSocket(s) {
  sock = s;
  for (const h of handles.values()) clearTimeout(h);
  handles.clear();
  for (const t of store.db.timers) arm(t);
}

module.exports = { add, cancelGroup, setSocket };
