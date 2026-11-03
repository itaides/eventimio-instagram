import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, containsPhrase, splitKeywords, findRule, renderTemplate, pickOne } from '../src/match.js';

test('tokenize folds case, niqqud, accents, punctuation and emoji', () => {
  assert.deepEqual(tokenize('  מַדְרִיךְ!!! 🎁 '), ['מדריך']);
  assert.deepEqual(tokenize('Wedding-BUDGET, café?'), ['wedding', 'budget', 'cafe']);
  assert.deepEqual(tokenize(null), []);
});

test('phrases match as whole consecutive words', () => {
  assert.ok(containsPhrase('אפשר את המדריך לתקציב?', 'מדריך'));        // prefix ה
  assert.ok(containsPhrase('שלחו בבקשה תקציב חתונה 🙏', 'תקציב חתונה'));
  assert.ok(containsPhrase('Send the GUIDE please', 'guide'));
  assert.ok(!containsPhrase('מדריכים', 'מדריך'));                      // longer word
  assert.ok(!containsPhrase('חתונה תקציב', 'תקציב חתונה'));            // wrong order
  assert.ok(!containsPhrase('guidebook', 'guide'));
  assert.ok(!containsPhrase('anything', '  '));
});

test('the Hebrew prefix applies to the first word only, and one letter at most', () => {
  assert.ok(containsPhrase('ולתקציב', 'לתקציב'));
  assert.ok(!containsPhrase('ולתקציב', 'תקציב'));                      // two letters
  assert.ok(!containsPhrase('תקציב והחתונה', 'תקציב חתונה'));          // prefix on the second word
  assert.ok(!containsPhrase('xguide', 'guide'));                       // Latin has no prefixes
});

test('keyword fields split on Latin and Arabic commas', () => {
  assert.deepEqual(splitKeywords('תקציב, budget ،guide ,, '), ['תקציב', 'budget', 'guide']);
  assert.deepEqual(splitKeywords(undefined), []);
});

test('findRule: post-specific before general, keyword before "any comment"', () => {
  const rules = [
    { id: 1, source: 'comment', trigger_mode: 'any', media_id: null, active: 1 },
    { id: 2, source: 'comment', keyword: 'מדריך', media_id: null, active: 1 },
    { id: 3, source: 'comment', trigger_mode: 'any', media_id: 'p1', active: 1 },
    { id: 4, source: 'comment', keyword: 'מדריך', media_id: 'p1', active: 1 },
    { id: 5, source: 'comment', keyword: 'מחיר', media_id: 'p1', active: 0 },
    { id: 6, source: 'story', keyword: 'מדריך', active: 1 },
  ];
  assert.equal(findRule(rules, 'comment', 'p1', 'המדריך!').id, 4);
  assert.equal(findRule(rules, 'comment', 'p1', 'וואו').id, 3);
  assert.equal(findRule(rules, 'comment', 'p2', 'מדריך').id, 2);
  assert.equal(findRule(rules, 'comment', 'p2', 'וואו').id, 1);
  assert.equal(findRule(rules, 'comment', 'p1', 'מחיר?').id, 3);       // inactive rule skipped
  assert.equal(findRule(rules, 'story', null, 'מדריך').id, 6);
  assert.equal(findRule(rules, 'dm', null, 'מדריך'), null);
});

test('renderTemplate fills known placeholders and leaves unknown ones', () => {
  assert.equal(renderTemplate('היי {username}, {other}', { username: 'noa.events' }), 'היי noa.events, {other}');
  assert.equal(renderTemplate('{username}', { username: '' }), '');
});

test('pickOne returns a non-empty line or null', () => {
  for (let i = 0; i < 20; i += 1) assert.ok(['א', 'ב'].includes(pickOne('א\n\n  ב  \n')));
  assert.equal(pickOne('  \n '), null);
  assert.equal(pickOne(null), null);
});
