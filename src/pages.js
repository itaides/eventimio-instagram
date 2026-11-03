/**
 * The two public pages Meta's app settings link to. English first for reviewers, then Hebrew for
 * our audience. Facts here must match the code: what the webhook receives, what `sends` keeps, and
 * the 90-day `forgetOld` retention.
 */
import { esc } from './util.js';

const RETENTION_DAYS = 90;
const DELETION_DAYS = 7;

/**
 * Inline styles (nonce-stamped by htmlResponse) and system fonts: /public sits behind Zero Trust,
 * so these pages must need nothing from it. Meta's reviewers and crawler get them complete.
 */
const STYLE = `
  :root { color-scheme: light; --ink: #14204d; --muted: #56607f; --line: #e3e7f2; --link: #c2366e; --bg: #fbfcff; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 17px/1.65 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
  .legal-head, .legal { max-inline-size: 720px; margin-inline: auto; padding-inline: 16px; }
  .legal-head { padding-block-start: 20px; }
  .legal { padding-block: 8px 64px; }
  .brand { font-weight: 800; font-size: 26px; letter-spacing: -0.02em; color: #4b2861; }
  .legal article + article { margin-block-start: 48px; padding-block-start: 16px; border-block-start: 1px solid var(--line); }
  h1 { font-size: clamp(26px, 5vw, 34px); line-height: 1.2; margin-block: 24px 8px; text-wrap: balance; }
  h2 { font-size: 19px; margin-block: 28px 4px; }
  p, li { text-wrap: pretty; }
  .lede { color: var(--muted); margin-block-start: 0; }
  .steps { padding-inline-start: 1.4em; }
  .steps li + li { margin-block-start: 6px; }
  a { color: var(--link); text-underline-offset: 3px; }
  a:focus-visible { outline: 3px solid #4a93de; outline-offset: 2px; border-radius: 4px; }
`;

/** @param {{title: string, brand: string, english: string, hebrew: string}} p */
function legalPage({ title, brand, english, hebrew }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${brand}</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>
<header class="legal-head"><span class="brand">${brand}</span></header>
<main class="legal">
  <article lang="en">${english}</article>
  <article lang="he" dir="rtl">${hebrew}</article>
</main>
</body>
</html>`;
}

const mail = (email) => `<a href="mailto:${email}">${email}</a>`;

export function privacyPage(env) {
  const brand = esc(env.BRAND_NAME);
  const email = esc(env.CONTACT_EMAIL);
  return legalPage({
    title: 'Privacy Policy',
    brand,
    english: `
    <h1>Privacy Policy</h1>
    <p class="lede">How ${brand}'s Instagram auto-reply tool handles your information.</p>

    <h2>Who runs it</h2>
    <p>${brand} runs this tool for its own Instagram account only. It answers people who ask us for something,
    such as a guide or a link, by commenting on our posts, replying to our stories, messaging us, or tapping a button we sent.</p>

    <h2>What Instagram shares with us</h2>
    <ul>
      <li>Your Instagram-scoped ID and username</li>
      <li>The text of the comment, story reply or message, and the ID of the post it belongs to</li>
      <li>Whether you follow our account, only when an automation sends its link to followers only</li>
    </ul>

    <h2>How we use it</h2>
    <p>To check the text against the keywords we set, and to send the one reply you asked for: a private message,
    and sometimes a short public reply to your comment. We never sell or share this information, never use it for advertising,
    and never message people who did not contact us first.</p>

    <h2>What we keep, and for how long</h2>
    <p>For each reply we send, we log your ID, username, the text you wrote and whether delivery worked, so nobody gets the same
    message twice. Comments and messages that match no automation are not stored. Every record is deleted automatically
    after ${RETENTION_DAYS} days.</p>

    <h2>Your choices</h2>
    <p>You can ask us to delete your records at any time. See the <a href="/data-deletion">data deletion page</a>.</p>

    <h2>Contact</h2>
    <p>${mail(email)}</p>`,
    hebrew: `
    <h1>מדיניות פרטיות</h1>
    <p class="lede">איך כלי התשובות האוטומטיות של ${brand} באינסטגרם מטפל במידע.</p>
    <p>הכלי פועל רק בחשבון האינסטגרם של ${brand}, ועונה למי שביקש מאיתנו משהו: בתגובה לפוסט, בתשובה לסטורי, בהודעה, או בלחיצה על כפתור ששלחנו.</p>
    <p>אינסטגרם משתפת איתנו את המזהה ושם המשתמש, את הטקסט שנכתב ואת הפוסט שאליו הוא שייך, ובאוטומציה לעוקבים בלבד גם אם יש מעקב אחרי החשבון שלנו.
    המידע משמש רק כדי לבדוק מילות מפתח ולשלוח את התשובה שהתבקשה. הוא לא נמכר, לא משותף ולא משמש לפרסום, ולא נשלחות הודעות למי שלא פנה.</p>
    <p>על כל תשובה שנשלחה נשמר רישום, כדי שאף אחד לא יקבל אותה פעמיים. תגובות והודעות שלא התאימו לאף אוטומציה לא נשמרות. כל רישום נמחק אוטומטית אחרי ${RETENTION_DAYS} יום.</p>
    <p>למחיקת המידע: <a href="/data-deletion">עמוד מחיקת המידע</a>, או ${mail(email)}.</p>`,
  });
}

export function deletionPage(env) {
  const brand = esc(env.BRAND_NAME);
  const email = esc(env.CONTACT_EMAIL);
  return legalPage({
    title: 'Data Deletion',
    brand,
    english: `
    <h1>Delete your data</h1>
    <ol class="steps">
      <li>Email ${mail(email)} with the subject <q>Data deletion</q>.</li>
      <li>Include your Instagram username so we can find your records.</li>
      <li>Within ${DELETION_DAYS} days we delete every record linked to it and reply to confirm.</li>
    </ol>
    <p>Nothing to do otherwise: records are deleted automatically ${RETENTION_DAYS} days after they are created.</p>`,
    hebrew: `
    <h1>מחיקת המידע</h1>
    <ol class="steps">
      <li>שולחים מייל ל-${mail(email)} עם הנושא <q>מחיקת מידע</q>.</li>
      <li>מצרפים את שם המשתמש באינסטגרם, כדי שנמצא את הרישומים.</li>
      <li>תוך ${DELETION_DAYS} ימים נמחק כל מה שקשור אליו, ונאשר במייל.</li>
    </ol>
    <p>גם בלי פנייה, כל רישום נמחק אוטומטית ${RETENTION_DAYS} יום אחרי שנשמר.</p>`,
  });
}
