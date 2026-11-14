/**
 * Optional Postgres mirror (set DATABASE_URL). Hosts with no persistent disk (Heroku, Koyeb, Render free)
 * wipe session/ and data/ on every restart; this keeps the WhatsApp login and the bot's settings in a
 * database instead, so restarts never log you out or break encryption keys.
 * Files are pulled to disk before the bot starts, then changed files are pushed every few seconds.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILES = ['db.json', 'menu.jpg', 'cookies.txt'];
const SYNC_MS = 10_000;

const sig = (st) => `${st.mtimeMs}:${st.size}`;

function createRemote(pool) {
  const known = new Map(); // rel path -> signature last pushed (or pulled)
  let running = null;
  let timer = null;

  const init = () => pool.query('CREATE TABLE IF NOT EXISTS voltron_files (path TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');

  function listLocal() {
    const out = new Map();
    const add = (rel) => {
      try {
        out.set(rel, sig(fs.statSync(path.join(ROOT, rel))));
      } catch {
        /* vanished */
      }
    };
    try {
      for (const f of fs.readdirSync(path.join(ROOT, 'session'))) add(`session/${f}`);
    } catch {
      /* no session yet */
    }
    for (const f of DATA_FILES) add(`data/${f}`);
    return out;
  }

  /** Database -> disk. Returns how many files were restored. */
  async function pull() {
    await init();
    const { rows } = await pool.query('SELECT path, data FROM voltron_files');
    if (!rows.length) return 0;
    const wanted = new Set(rows.map((r) => r.path));
    if (wanted.has('session/creds.json')) {
      for (const rel of listLocal().keys()) {
        if (rel.startsWith('session/') && !wanted.has(rel)) fs.rmSync(path.join(ROOT, rel), { force: true });
      }
    }
    for (const r of rows) {
      const abs = path.join(ROOT, r.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(r.data, 'base64'));
    }
    for (const [rel, s] of listLocal()) known.set(rel, s);
    return rows.length;
  }

  /** Disk -> database, only files that changed since the last push. */
  async function sync() {
    if (running) return running;
    running = (async () => {
      const local = listLocal();
      const changed = [...local].filter(([rel, s]) => known.get(rel) !== s);
      const removed = [...known.keys()].filter((rel) => !local.has(rel));
      for (let i = 0; i < changed.length; i += 40) {
        const batch = changed.slice(i, i + 40).flatMap(([rel]) => {
          try {
            return [[rel, fs.readFileSync(path.join(ROOT, rel)).toString('base64')]];
          } catch {
            return [];
          }
        });
        if (!batch.length) continue;
        const values = batch.map((_, n) => `($${n * 2 + 1}, $${n * 2 + 2})`).join(',');
        await pool.query(
          `INSERT INTO voltron_files (path, data) VALUES ${values} ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          batch.flat()
        );
        for (const [rel] of batch) known.set(rel, local.get(rel));
      }
      if (removed.length) {
        await pool.query('DELETE FROM voltron_files WHERE path = ANY($1)', [removed]);
        for (const rel of removed) known.delete(rel);
      }
    })()
      .catch((e) => console.error('database sync failed:', e.message))
      .finally(() => {
        running = null;
      });
    return running;
  }

  function start() {
    if (timer) return;
    timer = setInterval(sync, SYNC_MS);
    timer.unref();
  }

  /** Forget the saved login (after being logged out) so the next start asks to link again. */
  async function wipeSession() {
    await pool.query("DELETE FROM voltron_files WHERE path LIKE 'session/%'");
  }

  return { pull, sync, start, flush: sync, wipeSession };
}

function fromEnv() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) return null;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch {
    console.error('DATABASE_URL is set but the "pg" package is missing. Run npm install.');
    return null;
  }
  const local = /localhost|127\.0\.0\.1|sslmode=disable/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 3 });
  pool.on('error', (e) => console.error('database error:', e.message));
  return createRemote(pool);
}

const noop = { pull: async () => 0, sync: async () => {}, start() {}, flush: async () => {}, wipeSession: async () => {} };
const active = fromEnv();

module.exports = { remote: active || noop, enabled: !!active, createRemote };
