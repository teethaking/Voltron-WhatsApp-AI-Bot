const fs = require('fs');
const googleTTS = require('google-tts-api');
const config = require('../config');
const { run, tmpName, cleanup } = require('./utils');
const { ytdlp, explain } = require('./ytdlp');

/**
 * Media actions shared by the normal commands (.dl, .play, .tts ...) and the AI assistant.
 * Every function takes (sock, jid, input, quoted) and sends the result to `jid`.
 * Inputs are validated here because the AI passes through text written by other people.
 */

const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

const outTemplate = () => tmpName('x').replace(/\.x$/, '') + '.%(ext)s';
const lastLine = (s) => s.trim().split('\n').filter(Boolean).pop() || '';
const dl = (args) => ytdlp(args).catch((e) => Promise.reject(new Error(explain(e))));

function assertUrl(url) {
  if (!/^https?:\/\/\S+$/i.test(url || '')) throw new Error('That is not a valid link.');
  return url;
}

async function downloadVideo(sock, jid, url, quoted) {
  assertUrl(url);
  const maxMb = config.maxMb;
  const stdout = await dl([
    '-f', `bv*[filesize<${maxMb}M][ext=mp4]+ba[ext=m4a]/b[filesize<${maxMb}M][ext=mp4]/bv*+ba/b`,
    '--merge-output-format', 'mp4',
    '--max-filesize', `${maxMb}M`,
    '--print', 'after_move:filepath',
    '-o', outTemplate(),
    url,
  ]);
  const file = lastLine(stdout);
  if (!file || !fs.existsSync(file)) throw new Error('Nothing was downloaded.');
  try {
    const size = fs.statSync(file).size / 1024 / 1024;
    if (size > maxMb) throw new Error(`File is ${size.toFixed(0)}MB, over the ${maxMb}MB limit.`);
    await sock.sendMessage(jid, { video: { url: file }, caption: `✅ Downloaded by ${config.botName}`, mimetype: 'video/mp4' }, { quoted });
  } finally {
    cleanup(file);
  }
}

async function downloadAudio(sock, jid, url, quoted) {
  assertUrl(url);
  const stdout = await dl([
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--max-filesize', `${config.maxMb}M`,
    '--print', 'after_move:filepath',
    '-o', outTemplate(),
    url,
  ]);
  const file = lastLine(stdout);
  if (!file || !fs.existsSync(file)) throw new Error('Nothing was downloaded.');
  try {
    await sock.sendMessage(jid, { audio: { url: file }, mimetype: 'audio/mpeg' }, { quoted });
  } finally {
    cleanup(file);
  }
}

/** Search for a song, send it as audio, return its title. */
const playSong = (...args) => require('./music').playSong(...args);

/** Text to speech, sent as a WhatsApp voice note. */
async function tts(sock, jid, text, lang, quoted) {
  text = String(text || '').trim().slice(0, 600);
  if (!text) throw new Error('Nothing to say.');
  lang = LANG_RE.test(lang || '') ? lang : config.ttsLang;

  const parts = await googleTTS.getAllAudioBase64(text, {
    lang,
    slow: false,
    host: 'https://translate.google.com',
    splitPunct: ',.?!',
  });
  const mp3 = Buffer.concat(parts.map((p) => Buffer.from(p.base64, 'base64')));

  const inFile = tmpName('mp3');
  const outFile = tmpName('ogg');
  fs.writeFileSync(inFile, mp3);
  try {
    try {
      // WhatsApp voice notes want ogg/opus
      await run('ffmpeg', ['-y', '-i', inFile, '-c:a', 'libopus', '-b:a', '48k', outFile]);
      await sock.sendMessage(jid, { audio: { url: outFile }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted });
    } catch (e) {
      // no ffmpeg/opus: send the mp3 as a normal audio message
      await sock.sendMessage(jid, { audio: mp3, mimetype: 'audio/mpeg' }, { quoted });
    }
  } finally {
    cleanup(inFile, outFile);
  }
}

/** Entry point used by the AI and by approved requests. Returns a short result string. */
async function runAction(sock, jid, tool, input, quoted) {
  switch (tool) {
    case 'play_song': {
      const title = await playSong(sock, jid, input.query, quoted);
      return `Sent "${title}" as audio.`;
    }
    case 'download_video':
      await downloadVideo(sock, jid, input.url, quoted);
      return 'Video sent.';
    case 'download_audio':
      await downloadAudio(sock, jid, input.url, quoted);
      return 'Audio sent.';
    case 'text_to_speech':
      await tts(sock, jid, input.text, input.lang, quoted);
      return 'Voice note sent.';
    default:
      throw new Error('Unknown action.');
  }
}

/** Short human description of a request, for the owner's approval message. */
function describe(tool, input) {
  switch (tool) {
    case 'play_song': return `play a song: "${String(input.query || '').slice(0, 100)}"`;
    case 'download_video': return `download a video: ${String(input.url || '').slice(0, 150)}`;
    case 'download_audio': return `download audio: ${String(input.url || '').slice(0, 150)}`;
    case 'text_to_speech': return `voice note saying: "${String(input.text || '').slice(0, 100)}"`;
    default: return tool;
  }
}

module.exports = { downloadVideo, downloadAudio, playSong, tts, runAction, describe, LANG_RE };
