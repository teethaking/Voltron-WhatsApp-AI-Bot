const fs = require('fs');
const crypto = require('crypto');
const webp = require('node-webpmux');
const { run, tmpName, cleanup } = require('./utils');

const SIZE = 512;
const MAX_ANIMATED = 950 * 1024; // WhatsApp silently drops animated stickers much over ~1MB

// sharp is optional: some hosts (old glibc, Termux) have no prebuilt binary. ffmpeg covers for it.
let sharpLib;
function sharp() {
  if (sharpLib === undefined) {
    try {
      sharpLib = require('sharp');
    } catch (e) {
      sharpLib = null;
      console.warn(`sharp unavailable (${e.message.split('\n')[0]}), using ffmpeg for images.`);
    }
  }
  return sharpLib;
}

/** WhatsApp reads the pack / author names from a JSON blob inside the webp EXIF chunk. */
function exif(pack, author) {
  const json = Buffer.from(
    JSON.stringify({
      'sticker-pack-id': crypto.randomBytes(16).toString('hex'),
      'sticker-pack-name': pack || '',
      'sticker-pack-publisher': author || '',
      emojis: [''],
    }),
    'utf8'
  );
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  const out = Buffer.concat([head, json]);
  out.writeUIntLE(json.length, 14, 4);
  return out;
}

async function withExif(buf, pack, author) {
  const img = new webp.Image();
  await img.load(buf);
  img.exif = exif(pack, author);
  return img.save(null);
}

function fitFilter(crop) {
  return crop
    ? `crop=min(iw\\,ih):min(iw\\,ih),scale=${SIZE}:${SIZE}`
    : `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=decrease,format=rgba,pad=${SIZE}:${SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
}

async function ffmpegWebp(input, args) {
  const inFile = tmpName('bin');
  const outFile = tmpName('webp');
  try {
    fs.writeFileSync(inFile, input);
    await run('ffmpeg', ['-y', '-i', inFile, ...args, '-c:v', 'libwebp', outFile], { timeout: 2 * 60 * 1000 });
    return fs.readFileSync(outFile);
  } finally {
    cleanup(inFile, outFile);
  }
}

async function staticWebp(buf, crop) {
  const s = sharp();
  if (s) {
    return s(buf)
      .resize(SIZE, SIZE, { fit: crop ? 'cover' : 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 75 })
      .toBuffer();
  }
  return ffmpegWebp(buf, ['-vf', fitFilter(crop), '-frames:v', '1', '-lossless', '0', '-q:v', '75']);
}

async function animatedWebp(buf, crop) {
  // shrink step by step until WhatsApp will accept it
  const tries = [
    { fps: 15, q: 60, t: 8 },
    { fps: 12, q: 40, t: 7 },
    { fps: 10, q: 25, t: 6 },
  ];
  let out;
  for (const { fps, q, t } of tries) {
    out = await ffmpegWebp(buf, [
      '-t', String(t), '-an',
      '-vf', `fps=${fps},${fitFilter(crop)}`,
      '-loop', '0', '-lossless', '0', '-q:v', String(q), '-compression_level', '6',
    ]);
    if (out.length <= MAX_ANIMATED) break;
  }
  return out;
}

/**
 * Turn an image, short video/GIF or existing sticker into a WhatsApp sticker.
 * kind: 'image' | 'video' | 'sticker'
 */
async function makeSticker(buf, { kind, crop = false, pack, author }) {
  let out;
  if (kind === 'sticker') out = buf; // already webp, only the names change
  else if (kind === 'video') out = await animatedWebp(buf, crop);
  else out = await staticWebp(buf, crop);
  return withExif(out, pack, author);
}

/** Sticker -> PNG (first frame for animated ones). */
async function toImage(buf) {
  const s = sharp();
  if (s) return s(buf).png().toBuffer();
  const inFile = tmpName('webp');
  const outFile = tmpName('png');
  try {
    fs.writeFileSync(inFile, buf);
    await run('ffmpeg', ['-y', '-i', inFile, '-frames:v', '1', outFile]);
    return fs.readFileSync(outFile);
  } finally {
    cleanup(inFile, outFile);
  }
}

/** Animated sticker -> mp4. ffmpeg cannot decode animated webp, so sharp turns it into a GIF first. */
async function toVideo(buf) {
  const s = sharp();
  const inFile = tmpName(s ? 'gif' : 'webp');
  const outFile = tmpName('mp4');
  try {
    fs.writeFileSync(inFile, s ? await s(buf, { animated: true }).gif().toBuffer() : buf);
    await run('ffmpeg', ['-y', '-i', inFile, '-movflags', 'faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', outFile]);
    return fs.readFileSync(outFile);
  } finally {
    cleanup(inFile, outFile);
  }
}

module.exports = { makeSticker, toImage, toVideo };
