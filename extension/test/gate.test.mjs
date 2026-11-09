import test from 'node:test';
import assert from 'node:assert/strict';
import { grantCovers, anyGrantCovers, patchMatches, isSafePattern, maskFitsPage, MAX_PATTERN_LENGTH, patternProblem } from '../lib/gate.js';

const NOW = 1000;
const at = (url, tabId = 1) => ({ url, tabId, now: NOW });

test('tab grant covers only its own tab on the site it was given on', () => {
  const grant = { kind: 'tab', tabId: 1, origin: 'https://a.example', until: null };
  assert.equal(grantCovers(grant, at('https://a.example/x')), true);
  assert.equal(grantCovers(grant, at('https://a.example/other?q=1')), true);
  assert.equal(grantCovers(grant, at('https://b.example/', 1)), false, 'another site in the same tab');
  assert.equal(grantCovers(grant, at('http://a.example/x')), false, 'another scheme is another origin');
  assert.equal(grantCovers(grant, at('https://a.example/x', 2)), false);
  assert.equal(grantCovers({ kind: 'tab', tabId: 1, until: null }, at('https://a.example/x')), false, 'a tab grant without origin covers nothing');
});

test('page grant covers exactly that page, ignoring the hash', () => {
  const grant = { kind: 'page', url: 'https://a.example/x?q=1', until: null };
  assert.equal(grantCovers(grant, at('https://a.example/x?q=1#top')), true);
  assert.equal(grantCovers(grant, at('https://a.example/x?q=2')), false);
  assert.equal(grantCovers(grant, at('https://a.example/y')), false);
});

test('site grant matches the exact host and not a lookalike', () => {
  const grant = { kind: 'site', host: 'a.example', until: null };
  assert.equal(grantCovers(grant, at('https://a.example/any')), true);
  assert.equal(grantCovers(grant, at('https://a.example.evil.test/')), false);
  assert.equal(grantCovers(grant, at('https://sub.a.example/')), false);
  assert.equal(grantCovers(grant, at('not a url')), false);
});

test('regexp grant must match the whole url and a bad pattern never matches', () => {
  assert.equal(grantCovers({ kind: 'regexp', pattern: '^https://a\\.example/issues/.*', until: null }, at('https://a.example/issues/1')), true);
  assert.equal(grantCovers({ kind: 'regexp', pattern: 'https://a\\.example/issues/.*', until: null }, at('https://a.example/issues/1')), true);
  assert.equal(grantCovers({ kind: 'regexp', pattern: '^https://a\\.example/issues/', until: null }, at('https://a.example/issues/1')), false, 'a prefix is not the whole url');
  assert.equal(grantCovers({ kind: 'regexp', pattern: '^https://a\\.example/issues/.*', until: null }, at('https://a.example/pull/1')), false);
  assert.equal(grantCovers({ kind: 'regexp', pattern: 'a\\.example', until: null }, at('https://evil.test/?a.example')), false, 'unanchored text inside another url');
  assert.equal(grantCovers({ kind: 'regexp', pattern: 'https://a\\.example/|https://b\\.example/', until: null }, at('https://evil.test/?https://b.example/')), false, 'an alternation is anchored as a whole');
  assert.equal(grantCovers({ kind: 'regexp', pattern: '(', until: null }, at('https://a.example/')), false);
});

test('expiry: past does not cover, future and null do', () => {
  const base = { kind: 'tab', tabId: 1, origin: 'https://a.example' };
  assert.equal(grantCovers({ ...base, until: NOW - 1 }, at('https://a.example/')), false);
  assert.equal(grantCovers({ ...base, until: NOW }, at('https://a.example/')), false);
  assert.equal(grantCovers({ ...base, until: NOW + 1 }, at('https://a.example/')), true);
  assert.equal(grantCovers({ ...base, until: null }, at('https://a.example/')), true);
});

test('no grants cover nothing, unknown kinds cover nothing', () => {
  assert.equal(anyGrantCovers(undefined, at('https://a.example/')), false);
  assert.equal(anyGrantCovers([{ kind: 'all', until: null }], at('https://a.example/')), false);
});

test('patch masks match host and path with stars, regexp patches the full url', () => {
  const mask = { mask: 'github.com/*/pull/*' };
  assert.equal(patchMatches(mask, 'https://github.com/a/b/pull/8'), true);
  assert.equal(patchMatches(mask, 'https://github.com/a/b/issues/8'), false);
  assert.equal(patchMatches(mask, 'https://notgithub.com/a/pull/8'), false);
  assert.equal(patchMatches({ mask: 'a.example/*' }, 'https://a.example/x.y?z=1'), true);
  assert.equal(patchMatches({ pattern: '^https://a\\.example/$' }, 'https://a.example/'), true);
  assert.equal(patchMatches({ pattern: '(' }, 'https://a.example/'), false);
  assert.equal(patchMatches({}, 'https://a.example/'), false);
  assert.equal(patchMatches(mask, 'garbage'), false);
});

test('patch patterns must match the whole url', () => {
  assert.equal(patchMatches({ pattern: 'example\\.com' }, 'https://evil.test/?example.com'), false);
  assert.equal(patchMatches({ pattern: 'https://example\\.com/.*' }, 'https://example.com/a'), true);
  assert.equal(patchMatches({ pattern: 'https://example\\.com/.*' }, 'https://example.com.evil.test/a'), false);
});

test('patch mask stars never cross the host, the query counts only when the mask has one', () => {
  assert.equal(patchMatches({ mask: 'a.example*' }, 'https://a.example.evil.test/'), false);
  assert.equal(patchMatches({ mask: 'a.example/*' }, 'https://a.example.evil.test/'), false);
  assert.equal(patchMatches({ mask: '*/x' }, 'https://evil.test/x'), false);
  assert.equal(patchMatches({ mask: 'a.example/*' }, 'https://evil.test/?a.example/x'), false);
  assert.equal(patchMatches({ mask: 'a.example/*' }, 'https://evil.test/a.example/x'), false);
  assert.equal(patchMatches({ mask: '*.a.example/*' }, 'https://www.a.example/x'), true);
  assert.equal(patchMatches({ mask: '*.a.example/*' }, 'https://wwwa.example/x'), false);
  assert.equal(patchMatches({ mask: '*.a.example/*' }, 'https://evil.test/www.a.example/x'), false);
  assert.equal(patchMatches({ mask: 'a.example/docs*' }, 'https://a.example/docs/intro?lang=en'), true, 'no query in the mask: the query is ignored');
  assert.equal(patchMatches({ mask: 'a.example/x?id=1' }, 'https://a.example/x?id=1'), true);
  assert.equal(patchMatches({ mask: 'a.example/x?id=1' }, 'https://a.example/x?id=2'), false);
  assert.equal(patchMatches({ mask: 'a.example/x*' }, 'https://a.example/y?x'), false, 'a star in the path does not reach into the query');
  assert.equal(patchMatches({ mask: 'a.example:8080/*' }, 'https://a.example:8080/x'), true);
  assert.equal(patchMatches({ mask: 'a.example:8080/*' }, 'https://a.example/x'), false);
});

test('nested quantifiers, alternations under a quantifier and long patterns are refused and never run', () => {
  for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+', '^(https?://)+x', '(.*a){20}', '(\\w+\\s?)+$', '(a)\\1', 'x'.repeat(MAX_PATTERN_LENGTH + 1)]) {
    assert.equal(isSafePattern(bad), false, bad);
  }
  for (const good of ['^https://a\\.example/.*', 'https://a\\.example/(issues|pull)/\\d+', '(?:www\\.)?a\\.example/.*', '[(+*)]+', '\\(a+\\)+']) {
    assert.equal(isSafePattern(good), true, good);
  }
  const started = Date.now();
  assert.equal(patchMatches({ pattern: '(a+)+$' }, `https://a.example/${'a'.repeat(40)}!`), false);
  assert.ok(Date.now() - started < 100, 'an unsafe pattern is not evaluated');
});

test('a suggested mask fits only when it covers this page and stays on this host', () => {
  const here = 'https://a.example/docs/intro?x=1';
  assert.equal(maskFitsPage('a.example/docs*', here), true);
  assert.equal(maskFitsPage('a.example/*', here), true);
  assert.equal(maskFitsPage('a.example/other*', here), false, 'does not cover this page');
  assert.equal(maskFitsPage('*.example/*', here), false, 'wider than this host');
  assert.equal(maskFitsPage('b.example/*', here), false, 'another host');
  assert.equal(maskFitsPage('', here), false);
  assert.equal(maskFitsPage(7, here), false);
});

test('patternProblem names why a typed pattern cannot be saved', () => {
  assert.equal(patternProblem('https://a\\.example/.*'), null);
  assert.equal(patternProblem(''), 'Enter a pattern');
  assert.equal(patternProblem('   '), 'Enter a pattern');
  assert.equal(patternProblem(undefined), 'Enter a pattern');
  assert.match(patternProblem('x'.repeat(MAX_PATTERN_LENGTH + 1)), /at most 500 characters/);
  assert.equal(patternProblem('a('), 'This is not a valid pattern');
  assert.match(patternProblem('(a+)+$'), /can freeze the browser/);
});
