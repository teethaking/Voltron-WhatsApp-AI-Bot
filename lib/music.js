const fs = require('fs');
const yts = require('yt-search');
const config = require('../config');
const { tmpName, cleanup, URL_RE } = require('./utils');
const { ytdlp, explain } = require('./ytdlp');

const SEP = '|||';
const outTemplate = () => tmpName('x').replace(/\.x$/, '') + '.%(ext)s';
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

function fmtViews(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function fmtTime(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** YouTube search via the scraper (YouTube sometimes answers with an empty page, so try twice), then yt-dlp. */
async function search(query, limit = 10) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await withTimeout(yts({ query, pages: 1 }), 15_000);
      const vids = (r.videos || []).slice(0, limit).map((v) => ({
        id: v.videoId,
        url: v.url,
        title: v.title,
        author: v.author?.name || '',
        seconds: v.seconds || 0,
        views: v.views || 0,
        ago: v.ago || '',
        thumb: v.thumbnail || v.image || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      }));
      if (vids.length) return vids;
    } catch (e) {
      console.warn('yt-search failed:', e.message);
    }
  }
  const out = await ytdlp(
    [`ytsearch${Math.min(limit, 5)}:${query}`, '--flat-playlist', '--simulate', '--print', `%(id)s${SEP}%(title)s${SEP}%(channel,uploader)s${SEP}%(duration)s${SEP}%(view_count)s`],
    { timeout: 60_000 }
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, title, author, seconds, views] = line.split(SEP);
      return { id, url: `https://www.youtube.com/watch?v=${id}`, title, author: author === 'NA' ? '' : author, seconds: Number(seconds) || 0, views: Number(views) || 0, ago: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
    });
}

/** Best search hit that is a real track (not a live stream, not hours long). */
async function findTrack(query) {
  const max = config.maxSongMinutes * 60;
  const hits = await search(query);
  return hits.find((v) => v.seconds > 0 && v.seconds <= max) || null;
}

async function audioFrom(source, extra = []) {
  const stdout = await ytdlp([
    source,
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
    '--max-filesize', `${config.maxMb}M`,
    '--match-filter', `duration <= ${config.maxSongMinutes * 60}`,
    '--embed-metadata',
    ...extra,
    '--print', `after_move:%(title)s${SEP}%(uploader)s${SEP}%(filepath)s`,
    '-o', outTemplate(),
  ]).catch((e) => {
    // --max-downloads exits with 101 after a successful download
    if (e.code === 101 && e.stdout) return e.stdout;
    throw e;
  });
  const [title, uploader, file] = lastLine(stdout).split(SEP);
  if (!file || !fs.existsSync(file)) throw new Error('Nothing was downloaded.');
  return { title, uploader: uploader === 'NA' ? '' : uploader, file };
}

/** SoundCloud does not block datacenter IPs the way YouTube does, so it is the backup source. */
function soundcloud(query) {
  return audioFrom(`scsearch5:${query}`, ['-f', 'bestaudio[format_id!*=preview]', '-i', '--max-downloads', '1']);
}

/**
 * Download a song as mp3. Tries YouTube, then SoundCloud.
 * Returns { title, uploader, file, source }. The caller deletes `file`.
 */
async function fetchSong(track, query) {
  const errors = [];
  if (track?.url) {
    try {
      return { ...(await audioFrom(track.url)), source: 'YouTube' };
    } catch (e) {
      errors.push(e);
      console.warn(`YouTube download failed for "${track.title}": ${e.message}`);
    }
  }
  try {
    return { ...(await soundcloud(track?.title ? `${track.title}` : query)), source: 'SoundCloud' };
  } catch (e) {
    errors.push(e);
  }
  throw new Error(explain(errors[0]));
}

function nowPlayingCard(t, prefix) {
  return [
    `╭──『 🎧 *ɴᴏᴡ ᴘʟᴀʏɪɴɢ* 』`,
    `│ 🎵 *${t.title}*`,
    t.author && `│ 👤 ${t.author}`,
    t.seconds && `│ ⏱️ ${fmtTime(t.seconds)}`,
    t.views && `│ 👁️ ${fmtViews(t.views)} views${t.ago ? ` · ${t.ago}` : ''}`,
    `│ 🔗 ${t.url}`,
    `╰──『 ⬇️ _sending audio..._ 』`,
    ``,
    `_${prefix}lyrics ${t.title.slice(0, 40)} for the words_`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function sendCard(sock, jid, track, quoted) {
  const caption = nowPlayingCard(track, config.prefix);
  try {
    const res = await fetch(track.thumb, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    const image = Buffer.from(await res.arrayBuffer());
    await sock.sendMessage(jid, { image, caption }, { quoted });
  } catch {
    await sock.sendMessage(jid, { text: caption }, { quoted });
  }
}

/** Search for a song (or take a link), send a now-playing card and the audio. Returns the title. */
async function playSong(sock, jid, query, quoted, { asDocument = false } = {}) {
  query = String(query || '').trim().slice(0, 200);
  if (!query) throw new Error('No song name given.');

  const link = query.match(URL_RE)?.[0];
  let track = null;
  if (!link) {
    track = await findTrack(query);
    if (track) await sendCard(sock, jid, track, quoted);
  }

  const song = link ? { ...(await audioFrom(link).catch((e) => Promise.reject(new Error(explain(e))))), source: 'link' } : await fetchSong(track, query);
  const title = (song.title || track?.title || query).replace(/[\\/:*?"<>|]/g, '').slice(0, 100);
  try {
    if (!track) {
      await sock.sendMessage(jid, { text: `🎧 *${title}*${song.uploader ? `\n👤 ${song.uploader}` : ''}${song.source === 'SoundCloud' ? '\n☁️ via SoundCloud' : ''}` }, { quoted });
    }
    const content = asDocument
      ? { document: { url: song.file }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` }
      : { audio: { url: song.file }, mimetype: 'audio/mpeg', fileName: `${title}.mp3` };
    await sock.sendMessage(jid, content, { quoted });
  } finally {
    cleanup(song.file);
  }
  return title;
}

/** Lyrics from lrclib.net (free, no key). */
async function lyrics(query) {
  const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'user-agent': `${config.botName} WhatsApp bot` },
  });
  if (!res.ok) throw new Error(`Lyrics service answered ${res.status}. Try again later.`);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).find((x) => x.plainLyrics) || null;
}

module.exports = { search, findTrack, playSong, lyrics, fmtTime, fmtViews };
