import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextMessage, needsFollowCheck, parsePayload, PAYLOAD, buildMessage, openerMessage, followMessage, linkMessage,
  textFor, DEFAULTS,
} from '../src/flow.js';
import { findRule } from '../src/match.js';
import { ruleFromForm } from '../src/rules.js';

const form = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) });

test('trigger: link directly unless opener or follow gate is on', () => {
  assert.equal(nextMessage({ opener_text: null }, 'trigger'), 'link');
  assert.equal(nextMessage({ opener_text: 'hi' }, 'trigger'), 'opener');
  assert.equal(nextMessage({ opener_text: null, follow_gate: 1 }, 'trigger'), 'opener');
});

test('tap without follow gate always gets the link', () => {
  assert.equal(nextMessage({ follow_gate: 0 }, 'open', false), 'link');
  assert.equal(needsFollowCheck({ follow_gate: 0 }, 'open'), false);
});

test('follow gate: follower → link, non-follower → prompt, then reminder', () => {
  const r = { follow_gate: 1, opener_text: 'x' };
  assert.equal(needsFollowCheck(r, 'trigger'), false);
  assert.equal(needsFollowCheck(r, 'open'), true);
  assert.equal(nextMessage(r, 'open', true), 'link');
  assert.equal(nextMessage(r, 'open', false), 'follow');
  assert.equal(nextMessage(r, 'followed', false), 'reminder');
  assert.equal(nextMessage(r, 'followed', true), 'link');
});

test('follow gate: unknown follow status sends the link anyway', () => {
  assert.equal(nextMessage({ follow_gate: 1 }, 'open', null), 'link');
  assert.equal(nextMessage({ follow_gate: 1 }, 'followed', null), 'link');
});

test('payloads round-trip and reject foreign input', () => {
  assert.deepEqual(parsePayload(PAYLOAD.open(7)), { step: 'open', ruleId: 7 });
  assert.deepEqual(parsePayload(PAYLOAD.followed(12)), { step: 'followed', ruleId: 12 });
  assert.equal(parsePayload('ICEBREAKER_1'), null);
  assert.equal(parsePayload('open:abc'), null);
  assert.equal(parsePayload(undefined), null);
});

test('buildMessage: text only, web_url and postback buttons, capped at 3', () => {
  assert.deepEqual(buildMessage('hi'), { text: 'hi' });
  assert.deepEqual(buildMessage('hi', [null]), { text: 'hi' });
  const m = buildMessage('hi', [
    { url: 'https://a', title: 'A very long button title here' },
    { payload: 'open:1', title: 'B' },
    { payload: 'x', title: 'C' },
    { payload: 'y', title: 'D' },
  ]);
  const { buttons } = m.attachment.payload;
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons[0], { type: 'web_url', url: 'https://a', title: 'A very long button t' });
  assert.deepEqual(buttons[1], { type: 'postback', payload: 'open:1', title: 'B' });
});

test('opener and follow messages carry our payloads and default labels', () => {
  const rule = { id: 5 };
  const opener = openerMessage(rule, 'q').attachment.payload.buttons[0];
  assert.equal(opener.payload, 'open:5');
  assert.equal(opener.title, DEFAULTS.he.opener_button);
  const [profile, confirm] = followMessage(rule, 't', 'https://www.instagram.com/yourbrand').attachment.payload.buttons;
  assert.equal(profile.url, 'https://www.instagram.com/yourbrand');
  assert.equal(confirm.payload, 'followed:5');
  assert.equal(confirm.title, DEFAULTS.he.follow_confirm_button);
});

test('linkMessage falls back to plain text with the URL', () => {
  const { fallback } = linkMessage({ button_url: 'https://x.y', button_text: 'go' }, 'hey');
  assert.deepEqual(fallback, { text: 'hey\nhttps://x.y' });
  assert.equal(linkMessage({}, 'hey').fallback, null);
});

test('textFor uses rule text, else defaults', () => {
  assert.equal(textFor({ follow_text: '  ' }, 'follow'), DEFAULTS.he.follow_text);
  assert.equal(textFor({ follow_reminder_text: 'r' }, 'reminder'), 'r');
  assert.equal(textFor({ message: 'm' }, 'link'), 'm');
});

test('any-comment mode: fires on any comment, keyword rules win, comments only', () => {
  const rules = [
    { id: 1, source: 'comment', trigger_mode: 'any', keyword: '', media_id: 'reel1', active: 1 },
    { id: 2, source: 'comment', trigger_mode: 'keyword', keyword: 'פרומפט', media_id: 'reel1', active: 1 },
    { id: 3, source: 'dm', trigger_mode: 'any', keyword: '', media_id: null, active: 1 },
  ];
  assert.equal(findRule(rules, 'comment', 'reel1', 'וואו 😍').id, 1);
  assert.equal(findRule(rules, 'comment', 'reel1', 'פרומפט').id, 2);
  assert.equal(findRule(rules, 'comment', 'reel2', 'וואו'), null);
  assert.equal(findRule(rules, 'dm', null, 'שלום'), null);
});

test('ruleFromForm: basic keyword rule', () => {
  const { rule, error } = ruleFromForm(form({ source: 'comment', keyword: ' פרומפט ', message: 'הנה', button_url: 'https://a.b' }));
  assert.equal(error, undefined);
  assert.equal(rule.keyword, 'פרומפט');
  assert.equal(rule.send_dm, 1);
  assert.equal(rule.opener_text, null);
  assert.equal(rule.follow_gate, 0);
  assert.equal(rule.button_text, 'לפתיחה');
});

test('ruleFromForm: validation errors', () => {
  assert.equal(ruleFromForm(form({ source: 'comment', message: 'x' })).error, 'missing');
  assert.equal(ruleFromForm(form({ source: 'comment', keyword: 'k' })).error, 'missing');
  assert.equal(ruleFromForm(form({ keyword: 'k', message: 'x', button_url: 'http://a' })).error, 'badurl');
  assert.equal(ruleFromForm(form({ keyword: 'k', public_only: 'on' })).error, 'nopublic');
  assert.equal(ruleFromForm(form({ keyword: 'k', message: 'x', media: '{bad' })).error, 'badmedia');
});

test('ruleFromForm: any mode needs no keyword; public-only needs no message', () => {
  const { rule } = ruleFromForm(form({ trigger_mode: 'any', public_only: 'on', public_reply: 'שלחתי!' }));
  assert.equal(rule.trigger_mode, 'any');
  assert.equal(rule.keyword, '');
  assert.equal(rule.send_dm, 0);
  assert.equal(rule.follow_gate, 0);
});

test('ruleFromForm: any mode and public-only are ignored outside comments', () => {
  const { rule } = ruleFromForm(form({ source: 'dm', trigger_mode: 'any', keyword: 'k', message: 'x', public_only: 'on', public_reply: 'p' }));
  assert.equal(rule.trigger_mode, 'keyword');
  assert.equal(rule.send_dm, 1);
  assert.equal(rule.public_reply, null);
});

test('ruleFromForm: follow gate forces the opener on with default text', () => {
  const { rule } = ruleFromForm(form({ keyword: 'k', message: 'x', follow_gate: 'on' }));
  assert.equal(rule.follow_gate, 1);
  assert.equal(rule.opener_text, DEFAULTS.he.opener_text);
});

test('languages: defaults follow the rule language, Hebrew when unknown', () => {
  assert.equal(textFor({ lang: 'en' }, 'opener'), DEFAULTS.en.opener_text);
  assert.equal(textFor({ lang: 'fr' }, 'reminder'), DEFAULTS.fr.follow_reminder_text);
  assert.equal(textFor({ lang: 'xx' }, 'follow'), DEFAULTS.he.follow_text);
  assert.equal(openerMessage({ id: 1, lang: 'fr' }, 'q').attachment.payload.buttons[0].title, DEFAULTS.fr.opener_button);
  assert.equal(linkMessage({ lang: 'en', button_url: 'https://a' }, 't').message.attachment.payload.buttons[0].title, 'Open');
});

test('every language default fits Instagram button limits', () => {
  for (const d of Object.values(DEFAULTS)) {
    for (const k of ['opener_button', 'follow_profile_button', 'follow_confirm_button', 'link_button']) {
      assert.ok([...d[k]].length <= 20, `${k}: ${d[k]}`);
    }
  }
});

test('ruleFromForm: language and its default button text', () => {
  assert.equal(ruleFromForm(form({ keyword: 'k', message: 'x' })).rule.lang, 'he');
  const { rule } = ruleFromForm(form({ lang: 'fr', keyword: 'guide', message: 'x', button_url: 'https://a', opener: 'on' }));
  assert.equal(rule.lang, 'fr');
  assert.equal(rule.button_text, 'Ouvrir');
  assert.equal(rule.opener_text, DEFAULTS.fr.opener_text);
  assert.equal(ruleFromForm(form({ lang: 'de', keyword: 'k', message: 'x' })).rule.lang, 'he');
});

test('matching ignores accents and works in English and French', () => {
  const rules = [
    { id: 1, source: 'comment', keyword: 'guide, café', media_id: null, active: 1 },
    { id: 2, source: 'comment', keyword: 'Budget', media_id: null, active: 1 },
  ];
  assert.equal(findRule(rules, 'comment', 'x', 'Le GUIDE svp !').id, 1);
  assert.equal(findRule(rules, 'comment', 'x', 'un cafe?').id, 1);
  assert.equal(findRule(rules, 'comment', 'x', 'send the budget pls').id, 2);
  assert.equal(findRule(rules, 'comment', 'x', 'budgeting'), null);
});
