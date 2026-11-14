const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
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
    `Send *${config.prefix}update* to install it now (the bot restarts by itself).`,
    `_Mute these notices with UPDATE_NOTIFY=false._`,
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

const ROOT = path.join(__dirname, '..');
const KEEP = new Set(['node_modules', 'session', 'data', 'tmp', 'bin', '.env', 'cookies.txt', '.git']);
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd: ROOT, timeout: 5 * 60 * 1000, shell: process.platform === 'win32' && cmd === 'npm', ...opts }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().split(/\r?\n/).pop())) : resolve(String(out))
    )
  );

/** Version the code on disk is at, as far as we know. */
const installedSha = () => store.db.appliedSha || runningSha();

/** Is GitHub ahead of what is installed? */
async function pending() {
  const head = await gh(`/commits/${config.updateBranch}`);
  const mine = installedSha();
  return { head, mine, upToDate: !!mine && mine === head.sha };
}

async function pullWithGit() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return false;
  try {
    await run('git', ['pull', '--ff-only', '--quiet']);
    return true;
  } catch {
    return false;
  }
}

async function pullWithTarball() {
  const work = path.join(ROOT, 'tmp', 'update');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const res = await fetch(`https://codeload.github.com/${config.updateRepo}/tar.gz/${config.updateBranch}`, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'user-agent': `${config.botName}-bot` },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when downloading the update`);
  const archive = path.join(work, 'src.tar.gz');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  await run('tar', ['-xzf', 'src.tar.gz', '--strip-components=1'], { cwd: work }); // relative: GNU tar reads "C:" as a remote host
  fs.rmSync(archive);
  for (const name of fs.readdirSync(work)) {
    if (KEEP.has(name)) continue;
    fs.cpSync(path.join(work, name), path.join(ROOT, name), { recursive: true, force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
}

/** Download the newest code over the current files, install new dependencies, then restart the process. */
async function apply(head) {
  const pkgFile = path.join(ROOT, 'package.json');
  const depsBefore = fs.readFileSync(pkgFile, 'utf8');
  if (!(await pullWithGit())) await pullWithTarball();
  if (fs.readFileSync(pkgFile, 'utf8') !== depsBefore) {
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
  }
  store.db.appliedSha = head.sha;
  store.db.lastSha = head.sha;
  store.saveNow();
}

/** Exit so the host (panel, Docker, pm2, Heroku) starts the bot again on the new code. */
function restart() {
  store.saveNow();
  require('./msgcache').flush();
  setTimeout(() => process.exit(1), 1500);
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

module.exports = { start, check, pending, apply, restart };
