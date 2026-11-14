// Loads every plugin without connecting to WhatsApp, so broken installs or bad plugins fail CI.
process.env.YTDLP_SKIP_DOWNLOAD = 'true';
const assert = require('assert');

const handler = require('../lib/handler');
handler.loadPlugins();

const cmds = [...handler.commands];
const names = new Map();
const clashes = [];
for (const c of cmds) {
  for (const n of [c.name, ...(c.aliases || [])]) {
    if (names.has(n) && names.get(n) !== c.name) clashes.push(`${n} (${names.get(n)} vs ${c.name})`);
    names.set(n, c.name);
  }
  assert.strictEqual(typeof c.run, 'function', `${c.name} has no run()`);
  assert.ok(c.desc, `${c.name} has no description`);
}

const expected = ['menu', 'play', 'playdoc', 'yts', 'lyrics', 'sticker', 'dl', 'audio', 'tts', 'vv', 'kick', 'games'];
const missing = expected.filter((n) => !names.has(n));
assert.deepStrictEqual(missing, [], `missing commands: ${missing.join(', ')}`);
assert.deepStrictEqual(clashes, [], `command names used twice: ${clashes.join(', ')}`);

require('../lib/sticker');
require('../lib/music');

console.log(`smoke ok: ${cmds.length} commands, ${names.size} names`);
process.exit(0);
