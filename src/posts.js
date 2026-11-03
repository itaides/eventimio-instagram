/**
 * Pure rules for publishing posts: Meta's caption/carousel limits, our daily cap, Israel-time
 * scheduling, and the DM automation a post can create. No network or DB, so it is unit-tested.
 */

/** Meta Content Publishing limits (developers.facebook.com, IG User > Media). */
export const LIMITS = { caption: 2200, hashtags: 30, mentions: 20, images: 10, bytes: 8 * 1024 * 1024 };

export const RATIOS = ['4:5', '1:1', '1.91:1'];

const TZ = 'Asia/Jerusalem';
const IMAGE_KEY = /^[0-9a-f-]{36}\.jpg$/;

/** Counts what Meta limits in a caption. */
export function captionStats(caption) {
  const text = caption || '';
  return {
    chars: [...text].length,
    hashtags: (text.match(/#[^\s#]+/g) || []).length,
    mentions: (text.match(/@[A-Za-z0-9._]+/g) || []).length,
  };
}

/**
 * Validates the new-post form.
 * @returns {{post?: object, error?: string}} error is an admin flash key
 */
export function postFromForm(f, nowSec) {
  const caption = String(f.get('caption') || '').trim();
  const stats = captionStats(caption);
  if (stats.chars > LIMITS.caption || stats.hashtags > LIMITS.hashtags || stats.mentions > LIMITS.mentions) {
    return { error: 'caption_limits' };
  }
  const images = String(f.get('images') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!images.length || images.length > LIMITS.images || !images.every((k) => IMAGE_KEY.test(k))) {
    return { error: 'images' };
  }
  const ratio = RATIOS.includes(f.get('ratio')) ? f.get('ratio') : '4:5';

  let publishAt = nowSec;
  if (f.get('when') === 'schedule') {
    publishAt = israelLocalToEpoch(String(f.get('publish_at') || ''));
    if (!publishAt || publishAt < nowSec - 60) return { error: 'schedule_past' };
  }

  const autoOn = ['1', 'on', 'true'].includes(String(f.get('auto_on') || ''));
  const autoKeyword = String(f.get('auto_keyword') || '').trim();
  const autoLink = String(f.get('auto_link') || '').trim();
  if (autoOn && (!autoKeyword || !/^https:\/\//.test(autoLink))) return { error: 'auto' };

  return {
    post: {
      caption, ratio, images: JSON.stringify(images), publish_at: publishAt,
      auto_keyword: autoOn ? autoKeyword : null, auto_link: autoOn ? autoLink : null,
    },
  };
}

/** Israel's UTC offset in minutes at a given instant (handles daylight saving). */
export function israelOffsetMinutes(atMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60000);
}

/** "2026-11-13T19:30" in Israel time → epoch seconds; null if malformed. */
export function israelLocalToEpoch(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const naive = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes settle the offset around daylight-saving switches.
  let guess = naive - israelOffsetMinutes(naive) * 60000;
  guess = naive - israelOffsetMinutes(guess) * 60000;
  return Math.floor(guess / 1000);
}

/** Start of the current Israel calendar day, in epoch seconds. */
export function israelDayStart(nowSec) {
  const offset = israelOffsetMinutes(nowSec * 1000) * 60;
  const local = nowSec + offset;
  return local - (local % 86400) - offset;
}

/** Epoch seconds → "13.11 19:30" in Israel time, for the admin list. */
export function formatIsrael(sec) {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(sec * 1000));
}

/** The comment→DM automation a post asks for, bound to its published media. */
export function ruleForPost(post, mediaId, nowSec) {
  if (!post.auto_keyword || !post.auto_link) return null;
  return {
    name: `פוסט: ${post.auto_keyword}`,
    lang: 'he',
    source: 'comment',
    trigger_mode: 'keyword',
    keyword: post.auto_keyword,
    media_id: mediaId,
    media_label: (post.caption || '').slice(0, 60),
    media_thumb: null,
    public_reply: null,
    send_dm: 1,
    opener_text: 'היי {username}! ראיתי שהגבת כדי לקבל את הלינק 🎁 לשלוח אותו עכשיו?',
    opener_button: null,
    follow_gate: 0,
    follow_text: null,
    follow_profile_button: null,
    follow_confirm_button: null,
    follow_reminder_text: null,
    message: 'הנה הלינק שביקשת 👇',
    button_text: 'לפתיחה',
    button_url: post.auto_link,
    active: 1,
    created_at: nowSec,
  };
}

/** A JPEG starts with FF D8 FF; Meta accepts nothing else. */
export function isJpeg(bytes) {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
