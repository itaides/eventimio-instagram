/**
 * Admin form → rule row. Pure, so validation is unit-tested.
 * Works with FormData or any object exposing get(name).
 */

import { LANGS, defaultsFor } from './flow.js';

const SOURCES = ['comment', 'story', 'dm'];
const clean = (v) => (v == null ? '' : String(v)).trim();
const orNull = (v) => clean(v) || null;
const on = (f, name) => ['1', 'on', 'true'].includes(clean(f.get(name)));

/**
 * @param {{get(name: string): any}} f
 * @returns {{rule?: object, error?: string}} error is an admin flash key (see admin.js MSG)
 */
export function ruleFromForm(f) {
  const lang = LANGS.includes(f.get('lang')) ? f.get('lang') : 'he';
  const source = SOURCES.includes(f.get('source')) ? f.get('source') : 'comment';
  const isComment = source === 'comment';
  const triggerMode = isComment && f.get('trigger_mode') === 'any' ? 'any' : 'keyword';
  const keyword = clean(f.get('keyword'));
  if (triggerMode === 'keyword' && !keyword) return { error: 'missing' };

  let mediaId = null, mediaLabel = null, mediaThumb = null;
  if (isComment && clean(f.get('media'))) {
    try {
      [mediaId, mediaThumb, mediaLabel] = JSON.parse(f.get('media'));
    } catch {
      return { error: 'badmedia' };
    }
  }

  const publicReply = isComment ? orNull(f.get('public_reply')) : null;
  // Public-only applies to comments; DMs and story replies always get a message.
  const sendDm = isComment && on(f, 'public_only') ? 0 : 1;
  if (!sendDm && !publicReply) return { error: 'nopublic' };

  const message = clean(f.get('message'));
  if (sendDm && !message) return { error: 'missing' };
  const buttonUrl = orNull(f.get('button_url'));
  if (buttonUrl && !/^https:\/\//.test(buttonUrl)) return { error: 'badurl' };

  const followGate = sendDm && on(f, 'follow_gate') ? 1 : 0;
  // The follow gate needs a tap first, so it forces the opener on.
  const openerOn = sendDm && (on(f, 'opener') || followGate);

  return {
    rule: {
      name: orNull(f.get('name')),
      lang,
      source,
      trigger_mode: triggerMode,
      keyword: triggerMode === 'any' ? '' : keyword,
      media_id: mediaId,
      media_label: mediaLabel,
      media_thumb: mediaThumb,
      public_reply: publicReply,
      send_dm: sendDm,
      opener_text: openerOn ? clean(f.get('opener_text')) || defaultsFor({ lang }).opener_text : null,
      opener_button: openerOn ? orNull(f.get('opener_button')) : null,
      follow_gate: followGate,
      follow_text: orNull(f.get('follow_text')),
      follow_profile_button: orNull(f.get('follow_profile_button')),
      follow_confirm_button: orNull(f.get('follow_confirm_button')),
      follow_reminder_text: orNull(f.get('follow_reminder_text')),
      message: message || '',
      button_text: buttonUrl ? clean(f.get('button_text')) || defaultsFor({ lang }).link_button : null,
      button_url: buttonUrl,
    },
  };
}
