/**
 * The volume slider is a log10 track from VOL_MIN to VOL_MAX, and its tick
 * labels are laid out by `justify-content: space-between` — so they are only
 * truthful if there is exactly one label per decade. With a label missing, the
 * remaining ones sit at even fractions that no longer match their values and
 * the handle appears to point at the wrong number (200 tasks looked like "1k").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VOL_MIN = 10, VOL_MAX = 100_000;
const src = readFileSync(new URL('../site/src/components/Calculator.astro', import.meta.url), 'utf8');

const parseTick = (t: string) => {
  const m = /^([\d.]+)(k|M)?$/.exec(t.trim());
  assert.ok(m, `tick "${t}" is not a number with an optional k/M suffix`);
  return Number(m![1]) * (m![2] === 'k' ? 1e3 : m![2] === 'M' ? 1e6 : 1);
};

test('volume slider has one tick label per decade, in order', () => {
  const row = /<div class="ticks small"[^>]*>([\s\S]*?)<\/div>/.exec(src);
  assert.ok(row, 'tick row not found in Calculator.astro');
  const ticks = [...row![1].matchAll(/<span>([^<]+)<\/span>/g)].map((m) => parseTick(m[1]));

  const decades = Math.round(Math.log10(VOL_MAX) - Math.log10(VOL_MIN));
  assert.equal(ticks.length, decades + 1,
    `a log track spanning ${decades} decades needs ${decades + 1} labels, got ${ticks.length}`);
  assert.equal(ticks[0], VOL_MIN);
  assert.equal(ticks[ticks.length - 1], VOL_MAX);
  ticks.forEach((v, i) => assert.equal(v, VOL_MIN * 10 ** i, `tick ${i} should be ${VOL_MIN * 10 ** i}`));
});

test('evenly spaced labels land on their true log positions', () => {
  const L0 = Math.log10(VOL_MIN), L1 = Math.log10(VOL_MAX);
  const ticks = [10, 100, 1_000, 10_000, 100_000];
  ticks.forEach((v, i) => {
    const truePct = ((Math.log10(v) - L0) / (L1 - L0)) * 100;   // where the value sits
    const flexPct = (i / (ticks.length - 1)) * 100;             // where space-between draws it
    assert.ok(Math.abs(truePct - flexPct) < 0.001,
      `${v} sits at ${truePct.toFixed(1)}% but is drawn at ${flexPct.toFixed(1)}%`);
  });
});
