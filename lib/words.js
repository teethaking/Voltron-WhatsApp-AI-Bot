/**
 * Word lists for the games. assets/words.json holds:
 *   all    - ~100k English words, used to check that a word is real
 *   common - ~7k everyday words (4-10 letters, no plurals, no rude words), used as game answers
 */
const data = require('../assets/words.json');

const all = new Set(data.all);
const byLength = new Map();
for (const w of data.common) {
  if (!byLength.has(w.length)) byLength.set(w.length, []);
  byLength.get(w.length).push(w);
}

const isWord = (w) => all.has(w);

/** A random everyday word of exactly `len` letters. */
function pick(len) {
  const list = byLength.get(len);
  return list ? list[Math.floor(Math.random() * list.length)] : null;
}

/** A random everyday word between `min` and `max` letters. */
function pickBetween(min, max) {
  const lens = [...byLength.keys()].filter((l) => l >= min && l <= max);
  return pick(lens[Math.floor(Math.random() * lens.length)]);
}

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

module.exports = { isWord, pick, pickBetween, shuffle };
