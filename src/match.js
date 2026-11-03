/**
 * Keyword matching for comments and DMs.
 * Text is folded (case, niqqud, accents, punctuation, emoji) into word tokens, and a keyword
 * phrase must appear as consecutive whole tokens. Hebrew may glue one prefix letter to the first word.
 */

const HEBREW_PREFIXES = new Set(['ו', 'ה', 'ל', 'ב', 'ש']);

/** Folds text into lowercase word tokens without diacritics or symbols. */
export function tokenize(text) {
  const folded = String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** True when `word` is `target`, or `target` with a single Hebrew prefix letter ("והמדריך" → "המדריך"). */
function sameWord(word, target, allowPrefix) {
  if (word === target) return true;
  return allowPrefix && word.length === target.length + 1 && HEBREW_PREFIXES.has(word[0]) && word.slice(1) === target;
}

/** Whether the phrase occurs in the text as consecutive whole words. */
export function containsPhrase(text, phrase) {
  const needle = tokenize(phrase);
  if (!needle.length) return false;
  const hay = tokenize(text);
  for (let start = 0; start + needle.length <= hay.length; start += 1) {
    if (needle.every((w, i) => sameWord(hay[start + i], w, i === 0))) return true;
  }
  return false;
}

/** "מנויים, מנוים ,אשמח" → three alternatives. Latin and Arabic commas both separate. */
export function splitKeywords(field) {
  return String(field ?? '').split(/[,،]/).map((k) => k.trim()).filter(Boolean);
}

/**
 * The automation that handles an event, or null.
 * Order: rules bound to this post before general ones; within each, keyword rules before
 * "any comment" rules ("any" exists for comments only).
 */
export function findRule(rules, source, mediaId, text) {
  const candidates = rules.filter((r) => r.active && (r.source || 'comment') === source);
  const isAny = (r) => source === 'comment' && r.trigger_mode === 'any';
  const rank = (r) => (r.media_id && r.media_id === mediaId ? 0 : 2) + (isAny(r) ? 1 : 0);
  const eligible = candidates.filter((r) => !r.media_id || r.media_id === mediaId);
  eligible.sort((a, b) => rank(a) - rank(b));
  return eligible.find((r) => isAny(r) || splitKeywords(r.keyword).some((k) => containsPhrase(text, k))) || null;
}

/** Replaces {name} placeholders; unknown ones are left as they are. */
export function renderTemplate(text, values) {
  return String(text).replace(/\{([a-z_]+)\}/gi, (whole, key) => (values[key] == null ? whole : String(values[key])));
}

/** One random non-empty line of a multi-line field, or null. */
export function pickOne(lines) {
  const options = String(lines ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return options.length ? options[Math.floor(Math.random() * options.length)] : null;
}
