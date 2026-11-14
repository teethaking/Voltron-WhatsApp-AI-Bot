const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');
const { run } = require('./utils');
const { ytdlpReady } = require('./bootstrap');

const ROOT = path.join(__dirname, '..');
const MAX_JOBS = 2; // small hosts choke on several ffmpeg conversions at once

/** Cookie file for yt-dlp (fixes YouTube's "Sign in to confirm you're not a bot"). */
function cookieFile() {
  const candidates = [process.env.YTDLP_COOKIES, path.join(store.DIR, 'cookies.txt'), path.join(ROOT, 'cookies.txt')];
  return candidates.find((f) => f && fs.existsSync(f)) || null;
}

// Recent yt-dlp needs a JavaScript runtime for YouTube. Use this server's Node if yt-dlp supports the flag.
let jsRuntimeArgs;
function jsRuntime() {
  if (jsRuntimeArgs === undefined) {
    try {
      const help = execFileSync('yt-dlp', ['--help'], { maxBuffer: 10 * 1024 * 1024 }).toString();
      jsRuntimeArgs = help.includes('--js-runtimes') ? ['--js-runtimes', `node:${process.execPath}`] : [];
    } catch {
      return [];
    }
  }
  return jsRuntimeArgs;
}

/** Flags every yt-dlp call gets. Evaluated per call so a new cookies file works without a restart. */
function baseArgs() {
  const cookies = cookieFile();
  return [
    '--no-playlist', '--no-warnings', '--no-simulate', '--restrict-filenames', '--no-progress',
    ...jsRuntime(),
    ...(cookies ? ['--cookies', cookies] : []),
  ];
}

let running = 0;
const waiting = [];

async function ytdlp(args, opts) {
  await ytdlpReady();
  if (running >= MAX_JOBS) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await run('yt-dlp', [...baseArgs(), ...args], opts);
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** Friendlier wording for the errors people actually hit on servers. */
function explain(e) {
  const m = String(e?.message || e);
  if (/sign in to confirm|not a bot|cookies/i.test(m)) {
    return 'YouTube is blocking this server. The owner can fix it with .setcookies (see the README).';
  }
  if (/not installed/i.test(m)) return 'yt-dlp is not installed on the server yet. Wait a minute after startup and try again.';
  if (/unavailable|private video|removed/i.test(m)) return 'That video is unavailable.';
  if (/max-filesize|larger than max/i.test(m)) return 'That file is too big to send.';
  return m;
}

module.exports = { ytdlp, cookieFile, explain };
