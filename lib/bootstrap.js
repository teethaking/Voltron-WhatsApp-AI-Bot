const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

/**
 * Bot hosting panels usually only have Node. This makes sure ffmpeg and yt-dlp exist:
 *  - ffmpeg comes from the system, or the optional `ffmpeg-static` npm package
 *  - yt-dlp is downloaded as a standalone binary (no Python needed) and kept up to date,
 *    because YouTube breaks old yt-dlp versions every few weeks
 * Both end up in ./bin, which goes first on PATH.
 */

const BIN = path.join(__dirname, '..', 'bin');
const isWin = process.platform === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);
const YTDLP = path.join(BIN, exe('yt-dlp'));
const DAY = 24 * 60 * 60 * 1000;

function onPath(cmd) {
  try {
    execFileSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch {
    return fs.existsSync('/etc/alpine-release');
  }
}

function ytdlpAsset() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'linux') {
    const base = isMusl() ? 'yt-dlp_musllinux' : 'yt-dlp_linux';
    return arm ? `${base}_aarch64` : base;
  }
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  if (isWin) return arm ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  return null;
}

function ensureFfmpeg() {
  if (onPath('ffmpeg') || fs.existsSync(path.join(BIN, exe('ffmpeg')))) return;
  try {
    const src = require('ffmpeg-static');
    if (!src || !fs.existsSync(src)) throw new Error('ffmpeg-static binary missing');
    fs.copyFileSync(src, path.join(BIN, exe('ffmpeg')));
    fs.chmodSync(path.join(BIN, exe('ffmpeg')), 0o755);
    console.log('ffmpeg ready (bundled).');
  } catch (e) {
    console.warn(`Could not set up ffmpeg (${e.message}). Stickers from videos and audio conversion will not work.`);
  }
}

async function downloadYtdlp() {
  const asset = ytdlpAsset();
  if (!asset) throw new Error('no yt-dlp build for this platform');
  console.log('Downloading yt-dlp...');
  const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('download looks incomplete');
  const tmp = `${YTDLP}.part`;
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, YTDLP);
  console.log('yt-dlp ready.');
}

function updateYtdlp() {
  if (!fs.existsSync(YTDLP)) return;
  execFile(YTDLP, ['-U'], { timeout: 180_000 }, (err, stdout) => {
    if (err) return console.warn('yt-dlp update check failed:', err.message.split('\n')[0]);
    const line = String(stdout).trim().split('\n').pop();
    if (line) console.log(`yt-dlp: ${line}`);
  });
}

async function ensureYtdlp() {
  if (process.env.YTDLP_SKIP_DOWNLOAD === 'true') return;
  if (!fs.existsSync(YTDLP)) {
    try {
      await downloadYtdlp();
    } catch (e) {
      const fallback = onPath('yt-dlp') ? ' Using the system yt-dlp instead.' : ' .play and downloads will not work until it is installed.';
      return console.warn(`Could not download yt-dlp (${e.message}).${fallback}`);
    }
  } else {
    updateYtdlp();
  }
  setInterval(updateYtdlp, DAY).unref();
}

let ready = Promise.resolve();

/** Sets up PATH and ffmpeg right away; yt-dlp downloads in the background (see `ready`). */
function ensureBinaries() {
  fs.mkdirSync(BIN, { recursive: true });
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH || ''}`;
  ensureFfmpeg();
  ready = ensureYtdlp().catch((e) => console.warn('yt-dlp setup:', e.message));
}

module.exports = { ensureBinaries, ytdlpReady: () => ready };
