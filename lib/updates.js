const { execFileSync } = require('child_process');
const config = require('../config');
const store = require('./store');
const { ownerJid } = require('./utils');

/**
 * Watches the bot's GitHub repo. When a new commit lands on the main branch, DMs the owner
 * "update now" with the commit messages (the features that were implemented).
 */

const API = 'https://api.github.com';
const CHECK_EVERY_MS = 10 * 60 * 1000;
let sock = null;
let timer = null;
let busy = false;

const gh = async (path) => {
  const res = await fetch(`${API}/repos/${config.updateRepo}${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': `${config.botName}-bot` },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
};

/** Commit the running code was built from, when the host tells us (or when it is a git checkout). */
function runningSha() {
  const env = ['GIT_SHA', 'SOURCE_VERSION', 'HEROKU_SLUG_COMMIT', 'RAILWAY_GIT_COMMIT_SHA', 'RENDER_GIT_COMMIT', 'COMMIT_SHA']
    .map((k) => process.env[k])
    .find(Boolean);
  if (env) return env.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const isMerge = (c) => (c.parents || []).length > 1;
const lines = (msg) => String(msg || '').split('\n').map((l) => l.trim());

/** Commits between the last one we told the owner about and the newest one (newest last). */
async function newCommits(from, head) {
  try {
    const cmp = await gh(`/compare/${from}...${head.sha}`);
    const list = (cmp.commits || []).filter((c) => !isMerge(c));
    if (list.length) return list;
  } catch {
    /* history rewritten or compare unavailable: just report the newest commit */
  }
  return [head];
}

function buildMessage(commits, head) {
  const items = commits.slice(-6).map((c) => {
    const [title, ...body] = lines(c.commit.message);
    const extra = commits.length === 1 ? body.filter(Boolean).slice(0, 6).map((l) => `   ${l.replace(/^[-*]\s*/, '· ')}`) : [];
    return [`✅ ${title}`, ...extra].join('\n');
  });
  const more = commits.length > 6 ? `\n_...and ${commits.length - 6} more_` : '';
  return [
    `🔔 *UPDATE NOW!*`,
    `${config.botName} has new changes on GitHub. The features are implemented:`,
    ``,
    items.join('\n') + more,
    ``,
    `🔗 https://github.com/${config.updateRepo}/commit/${head.sha.slice(0, 7)}`,
    `_Redeploy or pull the repo to get them. Mute these with UPDATE_NOTIFY=false._`,
  ]
    .join('\n');
}

/** Check GitHub once. `force` also reports when nothing is new (used by .update). Returns a status string. */
async function check({ force = false } = {}) {
  if (!sock || busy) return 'busy';
  busy = true;
  try {
    const head = await gh(`/commits/${config.updateBranch}`);
    const seen = store.db.lastSha;
    const mine = runningSha();

    if (!seen && !force) {
      store.db.lastSha = head.sha; // first run: remember where we are, nothing to announce
      store.saveNow();
      return 'baseline';
    }
    if (seen === head.sha || (!force && mine === head.sha)) {
      store.db.lastSha = head.sha;
      store.saveNow();
      return 'current';
    }

    const commits = await newCommits(seen || head.sha, head);
    await sock.sendMessage(ownerJid(sock), { text: buildMessage(commits, head) });
    store.db.lastSha = head.sha;
    store.saveNow();
    return 'sent';
  } finally {
    busy = false;
  }
}

/** Call whenever a (re)connected socket is available. */
function start(s) {
  sock = s;
  if (!config.updateNotify || timer) return;
  const run = () => check().catch((e) => console.warn('update check failed:', e.message));
  setTimeout(run, 30_000).unref();
  timer = setInterval(run, CHECK_EVERY_MS);
  timer.unref();
}

module.exports = { start, check };
