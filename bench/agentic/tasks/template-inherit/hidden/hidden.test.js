import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/templates.js';

const templates = {
  base: '<title>{% block title %}Site{% endblock %}</title><main>{% block body %}empty{% endblock %}</main>',
  page: '{% extends "base" %}{% block title %}{{ super() }} — {{ page.name }}{% endblock %}{% block body %}Hello {{ user.name }}{% endblock %}',
  grand: '{% extends "page" %}{% block title %}{{ super() }}!{% endblock %}',
};

test('two-level inheritance with super chaining', () => {
  const out = render('grand', templates, { page: { name: 'Docs' }, user: { name: 'Ada' } });
  assert.equal(out, '<title>Site — Docs!</title><main>Hello Ada</main>');
});
test('child replaces some blocks, inherits the rest; outside content discarded', () => {
  const t = { ...templates, solo: '{% extends "base" %}IGNORED{% block body %}B{% endblock %}TRAILING' };
  assert.equal(render('solo', t, {}), '<title>Site</title><main>B</main>');
});
test('escaping on by default, raw filter opts out, missing paths empty', () => {
  const t = { x: '{{ v }}|{{ v | raw }}|{{ a.b.c }}' };
  assert.equal(render('x', t, { v: '<b>&"' }), '&lt;b&gt;&amp;&quot;|<b>&"|');
});
test('no-extends template renders its blocks in place', () => {
  const t = { p: 'A{% block b %}mid{% endblock %}Z' };
  assert.equal(render('p', t, {}), 'AmidZ');
});
test('exact errors', () => {
  assert.throws(() => render('missing', {}, {}), (e) => e.message === 'unknown template missing');
  assert.throws(() => render('c', { c: '{% extends "nope" %}' }, {}), (e) => e.message === 'unknown template nope');
  assert.throws(() => render('c', { c: '{% block open %}x' }, {}), (e) => e.message === 'unclosed block open');
});
