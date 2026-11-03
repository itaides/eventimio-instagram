/**
 * Pure decision logic for an automation's steps: trigger → opener → follow gate → link.
 * No network calls, so every branch is unit-testable.
 */

/** Languages an automation can be written in. */
export const LANGS = ['he', 'en', 'fr'];

/** Fallback copy per language, used when a rule leaves a field empty. Hebrew is gender-neutral. */
export const DEFAULTS = {
  he: {
    opener_text: 'היי {username}! ראיתי שהגבת כדי לקבל את הלינק 🎁 לשלוח אותו עכשיו?',
    opener_button: 'ברור, אשמח!',
    follow_text: 'רגע לפני הלינק: הוא שמור לעוקבים שלנו 💛 אפשר לעקוב בלחיצה ולחזור לכאן.',
    follow_profile_button: 'לפרופיל שלנו',
    follow_confirm_button: 'אני כבר עוקב/ת',
    follow_reminder_text: 'עדיין לא רואים מעקב 🙈 אחרי שעוקבים, לוחצים שוב על הכפתור.',
    link_button: 'לפתיחה',
  },
  en: {
    opener_text: 'Hi {username}! Saw your comment asking for the link 🎁 Want me to send it?',
    opener_button: 'Yes, send it!',
    follow_text: 'One sec: the link is for our followers 💛 Follow with one tap and come back here.',
    follow_profile_button: 'Visit our profile',
    follow_confirm_button: 'I already follow',
    follow_reminder_text: 'Not seeing the follow yet 🙈 Once you follow, tap the button again.',
    link_button: 'Open',
  },
  fr: {
    opener_text: 'Salut {username} ! J’ai vu ton commentaire pour recevoir le lien 🎁 Je te l’envoie ?',
    opener_button: 'Oui, envoie !',
    follow_text: 'Juste avant le lien : il est réservé à nos abonnés 💛 Abonne-toi en un clic et reviens ici.',
    follow_profile_button: 'Voir notre profil',
    follow_confirm_button: 'Je suis abonné·e',
    follow_reminder_text: 'On ne voit pas encore ton abonnement 🙈 Une fois abonné·e, appuie à nouveau sur le bouton.',
    link_button: 'Ouvrir',
  },
};

/** Default copy for a rule's language; unknown languages fall back to Hebrew. */
export const defaultsFor = (rule) => DEFAULTS[rule?.lang] || DEFAULTS.he;

/** Postback payloads we put on our own buttons. */
export const PAYLOAD = {
  open: (ruleId) => `open:${ruleId}`,
  followed: (ruleId) => `followed:${ruleId}`,
};

/**
 * Parses a postback payload produced by {@link PAYLOAD}.
 * @param {string} payload e.g. "open:12"
 * @returns {{step: 'open'|'followed', ruleId: number} | null}
 */
export function parsePayload(payload) {
  const m = /^(open|followed):(\d+)$/.exec(payload || '');
  return m ? { step: m[1], ruleId: Number(m[2]) } : null;
}

const val = (rule, key) => (rule[key] && String(rule[key]).trim()) || defaultsFor(rule)[key];

/**
 * Builds a Messenger-style message: plain text, or a button template with up to 3 buttons.
 * @param {string} text
 * @param {Array<{title: string, url?: string, payload?: string} | null>} buttons url → web_url, payload → postback
 */
export function buildMessage(text, buttons = []) {
  const list = buttons.filter(Boolean).slice(0, 3);
  if (!list.length) return { text };
  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text: text.slice(0, 640),
        buttons: list.map((b) => (b.url
          ? { type: 'web_url', url: b.url, title: b.title.slice(0, 20) }
          : { type: 'postback', payload: b.payload, title: b.title.slice(0, 20) })),
      },
    },
  };
}

/**
 * The final message carrying the link.
 * @returns {{message: object, fallback: object|null}} fallback = plain text with the URL, if Meta rejects the button
 */
export function linkMessage(rule, text) {
  const button = rule.button_url ? { url: rule.button_url, title: rule.button_text || defaultsFor(rule).link_button } : null;
  return { message: buildMessage(text, [button]), fallback: button ? { text: `${text}\n${button.url}` } : null };
}

/** Opener: asks before sending the link; its button posts back `open:<id>`. */
export function openerMessage(rule, text) {
  return buildMessage(text, [{ payload: PAYLOAD.open(rule.id), title: val(rule, 'opener_button') }]);
}

/** Follow prompt: a profile link plus an "I already follow" postback. */
export function followMessage(rule, text, profileUrl) {
  return buildMessage(text, [
    { url: profileUrl, title: val(rule, 'follow_profile_button') },
    { payload: PAYLOAD.followed(rule.id), title: val(rule, 'follow_confirm_button') },
  ]);
}

/**
 * Decides which message a queued event gets.
 * The follow gate implies an opener: Meta only exposes follow status after the user engages.
 * @param {object} rule
 * @param {'trigger'|'open'|'followed'} step trigger = comment/DM arrived, open/followed = our button was tapped
 * @param {boolean|null} follows null = couldn't check, so the link goes out anyway
 * @returns {'opener'|'follow'|'reminder'|'link'}
 */
export function nextMessage(rule, step, follows = null) {
  if (step === 'trigger') return rule.opener_text || rule.follow_gate ? 'opener' : 'link';
  if (!rule.follow_gate || follows !== false) return 'link';
  return step === 'open' ? 'follow' : 'reminder';
}

/** Text for a message kind, falling back to {@link DEFAULTS}. */
export function textFor(rule, kind) {
  if (kind === 'opener') return val(rule, 'opener_text');
  if (kind === 'follow') return val(rule, 'follow_text');
  if (kind === 'reminder') return val(rule, 'follow_reminder_text');
  return rule.message;
}

/** Follow status is only fetched on a button tap, and only for gated rules. */
export const needsFollowCheck = (rule, step) => step !== 'trigger' && Boolean(rule.follow_gate);
