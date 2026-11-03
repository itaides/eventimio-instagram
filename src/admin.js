import { esc } from './util.js';
import { shell, confirmAction } from './layout.js';
import { DEFAULTS, LANGS } from './flow.js';

const SOURCE_LABEL = { comment: 'תגובה על פוסט/ריל', story: 'תגובה לסטורי', dm: 'הודעה פרטית', postback: 'לחיצה על כפתור' };
const LANG_LABEL = { he: 'עברית', en: 'English', fr: 'Français' };
/** Send status → [label, pill tone]. */
const SEND_STATUS = {
  sent: ['נשלח', 'pill--ok'], pending: ['בתור', 'pill--wait'], sending: ['בשליחה', 'pill--wait'], failed: ['נכשל', 'pill--bad'],
};
const STEP_LABEL = { trigger: '', open: 'לחיצה על ההודעה המקדימה', followed: 'לחיצה על "כבר עוקב/ת"' };
/** Redirect code → [flash text, is it an error]. */
const FLASH = {
  verified: ['החיבור לאינסטגרם תקין', false],
  verifyfailed: ['בדיקת החיבור נכשלה. הפרטים בהודעה האדומה.', true],
  added: ['האוטומציה נוספה', false],
  saved: ['נשמר', false],
  deleted: ['האוטומציה נמחקה', false],
  missing: ['חסרה מילת מפתח או טקסט ללינק', true],
  badurl: ['הכתובת של הלינק צריכה להתחיל ב-https://', true],
  badmedia: ['לא הצלחתי לקרוא את הפוסט שנבחר. נסו לבחור שוב.', true],
  nopublic: ['כדי להסתפק בתשובה פומבית צריך לכתוב לפחות נוסח אחד', true],
};
const BLANK = { lang: 'he', source: 'comment', trigger_mode: 'keyword', send_dm: 1, follow_gate: 0 };

/** JSON for an inline <script>, safe against "</script>" in user text. */
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Renders the whole admin page: account status, automation list, stage editor with phone preview, activity.
 * @param {{s: object, rules: object[], recent: object[], sentByRule: object, pending: number,
 *   media: object[], mediaError: string|null, editing: object|null, msg: string|null}} p
 */
export function adminPage({ s, rules, recent, sentByRule, pending, media, mediaError, editing, msg }) {
  const r = editing || BLANK;
  const v = (k) => esc(r[k] ?? '');
  const isNew = !editing;
  const flash = FLASH[msg];
  const openerOn = Boolean(r.opener_text) || Boolean(r.follow_gate);
  const publicOn = Boolean(r.public_reply);
  const d = DEFAULTS[r.lang] || DEFAULTS.he;
  const dir = r.lang === 'he' ? 'rtl' : 'ltr';
  const mediaOptions = [...media];
  if (r.media_id && !media.some((m) => m.id === r.media_id)) {
    mediaOptions.unshift({ id: r.media_id, thumbnail_url: r.media_thumb, caption: r.media_label });
  }

  return `${shell({ title: 'אוטומציות', s, pending, active: 'rules' })}

<main>
  ${flash ? `<div class="flash${flash[1] ? ' flash--bad' : ''}" role="status">${flash[0]}</div>` : ''}
  ${s.token_error ? `<div class="flash flash--bad" role="alert">החיבור לאינסטגרם לא עובד: ${esc(s.token_error)}</div>` : ''}

  <nav class="rules" aria-label="האוטומציות שלי">
    ${rules.map((x) => `
      <a class="rule-card ${editing?.id === x.id ? 'rule-card--on' : ''} ${x.active ? '' : 'rule-card--off'}" href="/admin?edit=${x.id}" ${editing?.id === x.id ? 'aria-current="page"' : ''}>
        <span class="rule-card__name">${esc(x.name || x.keyword || 'אוטומציה')}</span>
        <span class="rule-card__meta">${esc(ruleMeta(x))} · ${sentByRule[x.id] || 0} נשלחו${x.active ? '' : ' · כבוי'}</span>
      </a>`).join('')}
    <a class="rule-card rule-card--new" href="/admin" ${isNew ? 'aria-current="page"' : ''}>+ אוטומציה חדשה</a>
  </nav>

  <div class="work">
    <form class="editor" method="post" id="editor">
      <input type="hidden" name="action" value="${isNew ? 'add' : 'update'}">
      ${isNew ? '' : `<input type="hidden" name="id" value="${r.id}">`}

      <div class="head-row">
        <div class="head-row__name">
          <label class="lbl" for="name">שם האוטומציה <span class="hint">(רק לך)</span></label>
          <input class="fld" id="name" name="name" value="${v('name')}" placeholder="למשל: מדריך תקציב">
        </div>
        <fieldset class="seg">
          <legend class="lbl">שפת ההודעות</legend>
          ${LANGS.map((l) => `<label><input type="radio" name="lang" value="${l}" ${r.lang === l ? 'checked' : ''}><span>${LANG_LABEL[l]}</span></label>`).join('')}
        </fieldset>
        <div class="actions">
          <button class="btn btn--primary">${isNew ? 'יצירה' : 'שמירה'}</button>
        </div>
      </div>

      <section class="stage" aria-labelledby="st1">
        <div class="stage__head">
          <span class="stage__num">1</span>
          <div class="stage__title"><h2 id="st1">טריגר</h2><div class="hint">מה מפעיל את האוטומציה</div></div>
        </div>
        <div class="stage__body">
          <fieldset class="seg">
            <legend class="lbl">איפה כותבים?</legend>
            ${['comment', 'story', 'dm'].map((x) => `<label><input type="radio" name="source" value="${x}" ${r.source === x ? 'checked' : ''}><span>${SOURCE_LABEL[x]}</span></label>`).join('')}
          </fieldset>
          <fieldset class="seg" data-show="comment">
            <legend class="lbl">מה מפעיל?</legend>
            <label><input type="radio" name="trigger_mode" value="keyword" ${r.trigger_mode !== 'any' ? 'checked' : ''}><span>רק עם מילת מפתח</span></label>
            <label><input type="radio" name="trigger_mode" value="any" ${r.trigger_mode === 'any' ? 'checked' : ''}><span>כל תגובה</span></label>
          </fieldset>
          <div data-show="keyword">
            <label class="lbl" for="keyword">מילת מפתח <span class="hint">(כמה מילים? מפרידים בפסיק)</span></label>
            <input class="fld" id="keyword" name="keyword" autocapitalize="off" autocorrect="off" spellcheck="false" value="${v('keyword')}" dir="auto" autocomplete="off">
          </div>
          <div data-show="comment">
            <span class="lbl" id="posts-lbl">על איזה פוסט או ריל?</span>
            ${mediaError ? `<p class="err">לא הצלחתי לטעון את הפוסטים: ${esc(mediaError)}</p>` : ''}
            <div class="posts" role="radiogroup" aria-labelledby="posts-lbl">
              <label><input type="radio" name="media" value="" ${r.media_id ? '' : 'checked'}><span class="all">כל הפוסטים והרילס</span></label>
              ${mediaOptions.map((m) => {
                const thumb = m.thumbnail_url || m.media_url || '';
                const label = (m.caption || '').slice(0, 60);
                return `<label title="${esc(label)}"><input type="radio" name="media" value="${esc(JSON.stringify([m.id, thumb, label]))}" ${r.media_id === m.id ? 'checked' : ''}><img class="ph-no-capture" src="${esc(thumb)}" alt="${esc(label || 'פוסט')}" loading="lazy"></label>`;
              }).join('')}
            </div>
            <p class="hint">כל אדם מקבל את האוטומציה פעם אחת בכל ריל, גם אם הגיב כמה פעמים.</p>
          </div>
        </div>
      </section>

      <section class="stage" aria-labelledby="st2" data-show="comment">
        <div class="stage__head">
          <span class="stage__num">2</span>
          <div class="stage__title"><h2 id="st2">תשובה פומבית</h2><div class="hint">תגובה מתחת לתגובה שלהם, נוסח אקראי בכל פעם</div></div>
          <input class="switch" type="checkbox" switch role="switch" id="public_on" aria-label="תשובה פומבית" ${publicOn ? 'checked' : ''}>
        </div>
        <div class="stage__body" data-show="public">
          <div>
            <label class="lbl" for="public_reply">הנוסחים <span class="hint">(אחד בכל שורה)</span></label>
            <textarea class="fld" id="public_reply" name="public_reply" dir="${dir}" data-dir>${v('public_reply')}</textarea>
          </div>
          <label class="check"><input type="checkbox" name="public_only" ${r.send_dm === 0 ? 'checked' : ''}> להסתפק בתשובה הפומבית, בלי הודעה פרטית</label>
        </div>
      </section>

      <section class="stage" aria-labelledby="st3" data-show="dm">
        <div class="stage__head">
          <span class="stage__num" data-num="opener">3</span>
          <div class="stage__title"><h2 id="st3">הודעה מקדימה</h2><div class="hint" id="opener-hint">שואלים לפני ששולחים. הלינק יוצא רק אחרי לחיצה.</div></div>
          <input class="switch" type="checkbox" switch role="switch" name="opener" id="opener" aria-label="הודעה מקדימה" ${openerOn ? 'checked' : ''}>
        </div>
        <div class="stage__body grid-3" data-show="opener">
          <div class="span-2">
            <label class="lbl" for="opener_text">טקסט ההודעה <span class="hint">({username} = שם המשתמש)</span></label>
            <textarea class="fld" id="opener_text" name="opener_text" dir="${dir}" data-dir data-default="opener_text" placeholder="${esc(d.opener_text)}">${v('opener_text')}</textarea>
          </div>
          <div>
            <label class="lbl" for="opener_button">הכפתור <span class="hint">(עד 20 תווים)</span></label>
            <input class="fld" id="opener_button" name="opener_button" maxlength="20" dir="${dir}" data-dir data-default="opener_button" placeholder="${esc(d.opener_button)}" value="${v('opener_button')}">
          </div>
        </div>
      </section>

      <section class="stage" aria-labelledby="st4" data-show="dm">
        <div class="stage__head">
          <span class="stage__num" data-num="follow">4</span>
          <div class="stage__title"><h2 id="st4">עוקבים בלבד</h2><div class="hint">אחרי הלחיצה בודקים אם עוקבים. אם מטא לא עונה, הלינק נשלח בכל מקרה.</div></div>
          <input class="switch" type="checkbox" switch role="switch" name="follow_gate" id="follow_gate" aria-label="עוקבים בלבד" ${r.follow_gate ? 'checked' : ''}>
        </div>
        <div class="stage__body" data-show="follow">
          <div>
            <label class="lbl" for="follow_text">למי שלא עוקב</label>
            <textarea class="fld" id="follow_text" name="follow_text" dir="${dir}" data-dir data-default="follow_text" placeholder="${esc(d.follow_text)}">${v('follow_text')}</textarea>
          </div>
          <div class="grid-2">
            <div>
              <label class="lbl" for="follow_profile_button">כפתור לפרופיל</label>
              <input class="fld" id="follow_profile_button" name="follow_profile_button" maxlength="20" dir="${dir}" data-dir data-default="follow_profile_button" placeholder="${esc(d.follow_profile_button)}" value="${v('follow_profile_button')}">
            </div>
            <div>
              <label class="lbl" for="follow_confirm_button">כפתור אישור</label>
              <input class="fld" id="follow_confirm_button" name="follow_confirm_button" maxlength="20" dir="${dir}" data-dir data-default="follow_confirm_button" placeholder="${esc(d.follow_confirm_button)}" value="${v('follow_confirm_button')}">
            </div>
          </div>
          <div>
            <label class="lbl" for="follow_reminder_text">תזכורת, אם לחצו בלי לעקוב</label>
            <textarea class="fld" id="follow_reminder_text" name="follow_reminder_text" dir="${dir}" data-dir data-default="follow_reminder_text" placeholder="${esc(d.follow_reminder_text)}">${v('follow_reminder_text')}</textarea>
          </div>
        </div>
      </section>

      <section class="stage" aria-labelledby="st5" data-show="dm">
        <div class="stage__head">
          <span class="stage__num stage__num--link" data-num="link">5</span>
          <div class="stage__title"><h2 id="st5">הלינק</h2><div class="hint">ההודעה עם מה שהבטחת</div></div>
        </div>
        <div class="stage__body">
          <div>
            <label class="lbl" for="message">טקסט ההודעה <span class="hint">({username} = שם המשתמש)</span></label>
            <textarea class="fld" id="message" name="message" dir="${dir}" data-dir>${v('message')}</textarea>
          </div>
          <div class="grid-3">
            <div>
              <label class="lbl" for="button_text">טקסט הכפתור</label>
              <input class="fld" id="button_text" name="button_text" maxlength="20" dir="${dir}" data-dir data-default="link_button" placeholder="${esc(d.link_button)}" value="${v('button_text')}">
            </div>
            <div class="span-2">
              <label class="lbl" for="button_url">כתובת <span class="hint">(בלי כתובת, נשלח רק הטקסט)</span></label>
              <input class="fld" id="button_url" name="button_url" type="url" autocapitalize="off" autocorrect="off" spellcheck="false" dir="ltr" placeholder="https://" aria-errormessage="button_url-error" value="${v('button_url')}"><span class="field-error" id="button_url-error">צריך כתובת מלאה שמתחילה ב-https://</span>
            </div>
          </div>
        </div>
      </section>
    </form>

    <aside class="preview" aria-label="תצוגה בטלפון">
      <strong>ככה זה ייראה בטלפון</strong>
      <fieldset class="seg" data-show="follow" id="path">
        <legend class="hint">מסלול</legend>
        <label><input type="radio" name="path" value="yes" form="none"><span>עוקב/ת</span></label>
        <label><input type="radio" name="path" value="no" form="none" checked><span>עוד לא עוקב/ת</span></label>
      </fieldset>
      <div class="phone">
        <div class="phone__head">
          <span class="phone__avatar" aria-hidden="true">E</span>
          <bdi class="phone__name" dir="ltr">${esc(s.username || 'your.account')}</bdi>
        </div>
        <div class="phone__chat" id="chat" aria-live="polite"></div>
      </div>
      <p class="hint">התצוגה מתעדכנת תוך כדי הקלדה. שדה ריק = הטקסט האפור שבתוכו.</p>
    </aside>
  </div>

  ${isNew ? '' : `
  <div class="actions">
    <form class="inline-form" method="post"><input type="hidden" name="action" value="toggle"><input type="hidden" name="id" value="${r.id}"><button class="btn">${r.active ? 'כיבוי האוטומציה' : 'הפעלת האוטומציה'}</button></form>
    ${confirmAction({
      id: `delete-${r.id}`, trigger: 'מחיקה', triggerClass: 'btn btn--quiet', title: 'למחוק את האוטומציה?',
      confirm: 'מחיקה', fields: { action: 'delete', id: r.id },
    })}
  </div>`}

  <section class="panel" aria-labelledby="activity">
    <h2 id="activity">פעילות אחרונה</h2>
    ${recent.length ? `<div class="table-wrap"><table>${recent.map((e) => `
      <tr>
        <td>${e.username ? `<bdi dir="ltr">@${esc(e.username)}</bdi>` : '-'}<div class="hint">${SOURCE_LABEL[e.source] || ''}${STEP_LABEL[e.step] ? ` · ${STEP_LABEL[e.step]}` : ''}</div></td>
        <td><bdi>${esc((e.incoming_text || '').slice(0, 80))}</bdi>${e.error ? `<div class="err">${esc(e.error)}</div>` : ''}</td>
        <td>${statusPill(e.status)}</td>
      </tr>`).join('')}</table></div>` : '<p class="empty">עוד לא נשלחו הודעות.</p>'}
  </section>
</main>

<script>
const DEFAULTS = ${json(DEFAULTS)};
const SAMPLE_USER = 'dana.events';
const form = document.getElementById('editor');
const chat = document.getElementById('chat');
const $ = (id) => document.getElementById(id);
const val = (name) => (form.elements[name] && form.elements[name].value || '').trim();
const radio = (name, scope) => ((scope || form).querySelector('input[name="' + name + '"]:checked') || {}).value;

function state() {
  const lang = radio('lang') || 'he';
  const source = radio('source');
  const isComment = source === 'comment';
  const follow = $('follow_gate').checked;
  const publicOn = isComment && $('public_on').checked;
  const dm = !(publicOn && form.elements.public_only.checked);
  return { lang, source, isComment, follow, publicOn, dm, opener: follow || $('opener').checked, any: isComment && radio('trigger_mode') === 'any' };
}

/** Shows or hides blocks and disables hidden fields so they are not submitted. */
function sync(st) {
  const shown = { comment: st.isComment, keyword: !st.any, public: st.publicOn, dm: st.dm, opener: st.opener, follow: st.follow };
  form.querySelectorAll('[data-show]').forEach((el) => {
    el.hidden = !shown[el.dataset.show];
    el.querySelectorAll('input, textarea').forEach((f) => { if (!f.classList.contains('switch')) f.disabled = el.hidden || f.closest('[hidden]') !== null; });
  });
  $('path').hidden = !(st.follow && st.dm);
  const opener = $('opener');
  opener.disabled = st.follow;
  if (st.follow) opener.checked = true;
  $('opener-hint').textContent = st.follow
    ? 'חובה כשמסלול העוקבים דולק: רק אחרי לחיצה אפשר לבדוק מעקב.'
    : 'שואלים לפני ששולחים. הלינק יוצא רק אחרי לחיצה.';
  const first = st.isComment ? 3 : 2;
  ['opener', 'follow', 'link'].forEach((k, i) => { form.querySelector('[data-num="' + k + '"]').textContent = first + i; });
  const d = DEFAULTS[st.lang] || DEFAULTS.he;
  const dir = st.lang === 'he' ? 'rtl' : 'ltr';
  form.querySelectorAll('[data-dir]').forEach((f) => { f.dir = dir; });
  form.querySelectorAll('[data-default]').forEach((f) => { f.placeholder = d[f.dataset.default]; });
  chat.dir = dir;
}

function el(cls, text) {
  const n = document.createElement('div');
  n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function card(text, buttons) {
  const c = el('card');
  c.append(el('card__text', text));
  buttons.forEach((b) => c.append(el('card__btn', b)));
  return c;
}

/** Rebuilds the phone conversation the commenter would see. */
function render() {
  const st = state();
  sync(st);
  const d = DEFAULTS[st.lang] || DEFAULTS.he;
  const fill = (t) => String(t || '').replace(/\\{username\\}/g, SAMPLE_USER);
  const or = (name, key) => val(name) || d[key];
  const said = st.any ? '😍' : (val('keyword').split(/[,،]/)[0] || '').trim() || '...';
  const parts = [];

  if (st.isComment) {
    parts.push(el('note', 'מתחת לריל'));
    const t = el('thread');
    const line = el('', ' ' + said);
    const who = document.createElement('bdi'); who.dir = 'ltr'; who.textContent = SAMPLE_USER; who.className = 'who';
    line.prepend(who);
    t.append(line);
    const variants = val('public_reply').split('\\n').map((x) => x.trim()).filter(Boolean);
    if (st.publicOn && variants.length) t.append(el('thread__reply', fill(variants[0])));
    parts.push(t);
    if (st.dm) parts.push(el('note', 'בהודעות'));
  } else {
    if (st.source === 'story') parts.push(el('note', 'תגובה לסטורי'));
    parts.push(el('bub bub--them', said));
  }

  if (st.dm) {
    if (st.opener) {
      const btn = or('opener_button', 'opener_button');
      parts.push(card(fill(or('opener_text', 'opener_text')), [btn]));
      parts.push(el('bub bub--them', btn));
      if (st.follow && radio('path', $('path')) === 'no') {
        const fb = [or('follow_profile_button', 'follow_profile_button'), or('follow_confirm_button', 'follow_confirm_button')];
        parts.push(card(fill(or('follow_text', 'follow_text')), fb));
        parts.push(el('bub bub--them', fb[1]));
        parts.push(card(fill(or('follow_reminder_text', 'follow_reminder_text')), fb));
        parts.push(el('note', 'עקבו, ולחצו שוב'));
        parts.push(el('bub bub--them', fb[1]));
      }
    }
    const text = fill(val('message')) || '...';
    parts.push(val('button_url') ? card(text, [or('button_text', 'link_button')]) : el('bub bub--us', text));
  }
  chat.replaceChildren(...parts);
}

form.addEventListener('input', render);
form.addEventListener('change', render);
$('path').addEventListener('change', render);
render();
</script>
</body>
</html>`;
}

/** Short summary line for an automation card. */
function ruleMeta(r) {
  const where = SOURCE_LABEL[r.source] || '';
  const what = r.trigger_mode === 'any' ? 'כל תגובה' : `"${(r.keyword || '').split(',')[0].trim()}"`;
  return `${where} · ${what} · ${LANG_LABEL[r.lang] || ''}`;
}

function statusPill(status) {
  const [label, tone] = SEND_STATUS[status] || [esc(status), 'pill--wait'];
  return `<span class="pill ${tone}">${label}</span>`;
}
