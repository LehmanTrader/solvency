import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/render.js';
test('variables escape html', () => {
  assert.equal(render('Hi {{who}}!', { who: '<b>&"' }), 'Hi &lt;b&gt;&amp;&quot;!');
});
test('sections repeat', () => {
  assert.equal(render('{{#xs}}[{{v}}]{{/xs}}', { xs: [{ v: 1 }, { v: 2 }] }), '[1][2]');
});
