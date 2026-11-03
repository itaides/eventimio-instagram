import { esc } from './util.js';
import { shell, confirmAction } from './layout.js';
import { LIMITS, RATIOS, formatIsrael } from './posts.js';

/** Redirect code → [flash text, is it an error]. */
const FLASH = {
  posted: ['הפוסט נשלח לפרסום. הוא יופיע בפיד תוך דקה בערך.', false],
  scheduled: ['הפוסט תוזמן', false],
  cancelled: ['התזמון בוטל', false],
  caption_limits: ['הכיתוב עובר את המגבלות של אינסטגרם (2,200 תווים, 30 האשטגים, 20 תיוגים)', true],
  images: ['צריך בין תמונה אחת ל-10 תמונות', true],
  schedule_past: ['זמן התזמון כבר עבר', true],
  auto: ['להודעה האוטומטית צריך מילת מפתח ולינק שמתחיל ב-https://', true],
  daily_cap: ['הגעתם למכסה היומית. אפשר לתזמן למחר.', true],
};
const STATUS = {
  scheduled: ['מתוזמן', 'pill--wait'], publishing: ['בפרסום', 'pill--wait'], processing: ['מטא מעבדת', 'pill--wait'],
  published: ['פורסם', 'pill--ok'], failed: ['נכשל', 'pill--bad'], cancelled: ['בוטל', ''],
};
const RATIO_LABEL = { '4:5': '4:5 לאורך', '1:1': '1:1 ריבוע', '1.91:1': '1.91:1 לרוחב' };

/**
 * The "new post" page: images (cropped and converted to JPEG in the browser), caption with Meta's
 * limits, optional comment→DM automation, publish now or schedule; plus recent and scheduled posts.
 * @param {{s: object, posts: object[], today: number, cap: number, canPublish: boolean, msg: string|null}} p
 */
export function postPage({ s, posts, today, cap, canPublish, msg }) {
  const [msgText, msgBad] = FLASH[msg] || [];
  const atCap = today >= cap;
  return `${shell({ title: 'פוסט חדש', s, active: 'post' })}
<main>
  ${msgText ? `<div class="flash ${msgBad ? 'flash--bad' : ''}" role="status">${msgText}</div>` : ''}
  ${canPublish ? '' : '<div class="flash flash--bad" role="alert">חסר טוקן פרסום (IG_PUBLISH_TOKEN) או כתובת ציבורית (PUBLIC_BASE_URL). אפשר לתזמן, והפוסטים יפורסמו כשהטוקן יוגדר.</div>'}
  <p class="chip post-chip">פורסמו היום <strong>${today}</strong> מתוך ${cap}</p>

  <div class="work">
    <form class="editor" method="post" action="/admin/post" id="post">
      <input type="hidden" name="action" value="post_create">
      <input type="hidden" name="images" id="images">

      <section class="stage" aria-labelledby="p1">
        <div class="stage__head"><span class="stage__num">1</span>
          <div class="stage__title"><h2 id="p1">תמונות</h2><div class="hint">עד ${LIMITS.images}. יותר מאחת = קרוסלה. ממירים ל-JPEG וחותכים כאן, לפני העלאה.</div></div>
        </div>
        <div class="stage__body">
          <div class="thumbs" id="thumbs">
            <label class="add" id="add-label"><input type="file" id="files" accept="image/*" multiple>
              <span class="add__plus" aria-hidden="true">+</span>הוספה</label>
          </div>
          <fieldset class="seg">
            <legend class="lbl">יחס תמונה</legend>
            ${RATIOS.map((r, i) => `<label><input type="radio" name="ratio" value="${r}" ${i === 0 ? 'checked' : ''}><span>${RATIO_LABEL[r]}</span></label>`).join('')}
          </fieldset>
          <p class="hint">בקרוסלה כל התמונות נחתכות לאותו יחס. 4:5 תופס הכי הרבה מסך בפיד.</p>
        </div>
      </section>

      <section class="stage" aria-labelledby="p2">
        <div class="stage__head"><span class="stage__num">2</span>
          <div class="stage__title"><h2 id="p2">כיתוב</h2><div class="hint">השורה הראשונה היא מה שרואים לפני "עוד"</div></div>
        </div>
        <div class="stage__body">
          <label class="lbl" for="caption">הכיתוב</label>
          <textarea class="fld" id="caption" name="caption" dir="auto" rows="7"></textarea>
          <div class="counts hint" aria-live="polite">
            <span id="c-chars">0 / 2,200 תווים</span><span id="c-tags">0 / 30 האשטגים</span><span id="c-ment">0 / 20 תיוגי @</span>
          </div>
        </div>
      </section>

      <section class="stage" aria-labelledby="p3">
        <div class="stage__head"><span class="stage__num">3</span>
          <div class="stage__title"><h2 id="p3">הודעה אוטומטית לתגובות</h2><div class="hint">מי שמגיב את המילה על הפוסט הזה מקבל את הלינק בפרטי</div></div>
          <input class="switch" type="checkbox" switch role="switch" name="auto_on" id="auto_on" aria-label="הודעה אוטומטית לתגובות" checked>
        </div>
        <div class="stage__body grid-3" id="auto-body">
          <div><label class="lbl" for="auto_keyword">מילת מפתח</label><input class="fld" id="auto_keyword" name="auto_keyword" autocapitalize="off" autocorrect="off" spellcheck="false" dir="auto"></div>
          <div class="span-2"><label class="lbl" for="auto_link">הלינק</label><input class="fld" id="auto_link" name="auto_link" type="url" autocapitalize="off" autocorrect="off" spellcheck="false" dir="ltr" placeholder="https://" aria-errormessage="auto_link-error"><span class="field-error" id="auto_link-error">צריך כתובת מלאה שמתחילה ב-https://</span></div>
        </div>
      </section>

      <section class="stage" aria-labelledby="p4">
        <div class="stage__head"><span class="stage__num stage__num--link">4</span>
          <div class="stage__title"><h2 id="p4">מתי לפרסם</h2><div class="hint">שעון ישראל</div></div>
        </div>
        <div class="stage__body">
          <fieldset class="seg">
            <legend class="lbl">מתי</legend>
            <label><input type="radio" name="when" value="now" checked ${atCap ? 'disabled' : ''}><span>עכשיו</span></label>
            <label><input type="radio" name="when" value="schedule" ${atCap ? 'checked' : ''}><span>לתזמן</span></label>
          </fieldset>
          <div id="when-at" hidden>
            <label class="lbl" for="publish_at">תאריך ושעה</label>
            <input class="fld fld--when" type="datetime-local" id="publish_at" name="publish_at">
          </div>
          <div class="actions">
            <button class="btn btn--primary" id="post-submit">פרסום עכשיו</button>
            <progress id="upload-bar" class="upload-bar" max="1" value="0" aria-label="העלאת תמונות" hidden></progress>
            <span class="hint progress" id="progress" role="status"></span>
          </div>
        </div>
      </section>
    </form>

    <aside class="preview" aria-label="תצוגה בפיד">
      <strong>ככה זה ייראה בפיד</strong>
      <div class="feed">
        <div class="feed__head" dir="ltr">
          <span class="phone__avatar" aria-hidden="true">E</span>
          <bdi class="phone__name">${esc(s.username || 'your.account')}</bdi>
        </div>
        <div class="feed__img feed__img--portrait" id="pv-img"><span>אין תמונה עדיין</span></div>
        <div class="feed__cap" dir="auto" id="pv-cap"></div>
        <div class="feed__bot" id="pv-bot" hidden></div>
      </div>
    </aside>
  </div>

  <section class="panel" aria-labelledby="plist">
    <h2 id="plist">מתוזמנים ופורסמו לאחרונה</h2>
    ${posts.length ? posts.map((p) => {
      const imgs = JSON.parse(p.images || '[]');
      const [label, cls] = STATUS[p.status] || [p.status, ''];
      const when = p.status === 'published' && p.published_at ? formatIsrael(p.published_at) : formatIsrael(p.publish_at);
      return `<div class="row">
        <div class="row__body">
          <div class="row__title"><bdi>${esc((p.caption || '').split('\n')[0] || 'ללא כיתוב')}</bdi></div>
          <div class="hint">${when}${imgs.length > 1 ? ` · קרוסלה של ${imgs.length}` : ''}${p.auto_keyword ? ` · אוטומציה: "${esc(p.auto_keyword)}"` : ''}${p.permalink ? ` · <a href="${esc(p.permalink)}" target="_blank" rel="noopener">לפוסט</a>` : ''}</div>
          ${p.error ? `<div class="err">${esc(p.error)}</div>` : ''}
        </div>
        <span class="pill ${cls}">${label}</span>
        ${p.status === 'scheduled' ? `${confirmAction({
          id: `cancel-${p.id}`, trigger: 'ביטול', title: 'לבטל את התזמון?', confirm: 'ביטול התזמון',
          action: '/admin/post', fields: { action: 'post_cancel', id: p.id },
        })}` : ''}
      </div>`;
    }).join('') : '<p class="empty">עוד לא פורסמו פוסטים מכאן.</p>'}
  </section>
</main>

<script>
const MAX = ${LIMITS.images};
const form = document.getElementById('post');
const $ = (id) => document.getElementById(id);
const files = [];
const RATIO = { '4:5': 4 / 5, '1:1': 1, '1.91:1': 1.91 };
const ratio = () => form.querySelector('input[name="ratio"]:checked').value;
const css = (r) => r.replace(':', ' / ');

function count(text) {
  return {
    chars: [...text].length,
    tags: (text.match(/#[^\\s#]+/g) || []).length,
    ment: (text.match(/@[A-Za-z0-9._]+/g) || []).length,
  };
}

function render() {
  const thumbs = $('thumbs');
  thumbs.querySelectorAll('.thumb').forEach((n) => n.remove());
  files.forEach((f, i) => {
    const box = document.createElement('div');
    box.className = 'thumb' + (i === 0 ? ' thumb--first' : '');
    box.style.aspectRatio = css(ratio());
    const img = document.createElement('img');
    img.src = f.url; img.alt = 'תמונה ' + (i + 1);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'thumb__x'; x.textContent = '×'; x.setAttribute('aria-label', 'הסרת תמונה ' + (i + 1));
    x.onclick = () => { URL.revokeObjectURL(f.url); files.splice(i, 1); render(); };
    box.append(img, x);
    thumbs.insertBefore(box, $('add-label'));
  });
  $('add-label').hidden = files.length >= MAX;

  const pv = $('pv-img');
  pv.style.aspectRatio = css(ratio());
  pv.replaceChildren();
  if (files.length) {
    const img = document.createElement('img'); img.src = files[0].url; img.alt = '';
    pv.append(img);
    if (files.length > 1) { const c = document.createElement('span'); c.className = 'feed__count'; c.textContent = '1/' + files.length; pv.append(c); }
  } else { const t = document.createElement('span'); t.textContent = 'אין תמונה עדיין'; pv.append(t); }

  const text = $('caption').value;
  const lines = text.split('\\n');
  const first = lines.slice(0, 2).join('\\n');
  const cap = $('pv-cap'); cap.replaceChildren();
  const who = document.createElement('bdi'); who.dir = 'ltr'; who.className = 'who';
  who.textContent = ${JSON.stringify(s.username || 'your.account')};
  cap.append(who, document.createTextNode(' ' + first + (lines.length > 2 ? ' ... עוד' : '')));

  const c = count(text);
  const set = (id, n, max, label) => { const e = $(id); e.textContent = n.toLocaleString('en-US') + ' / ' + max.toLocaleString('en-US') + ' ' + label; e.classList.toggle('over', n > max); };
  set('c-chars', c.chars, 2200, 'תווים'); set('c-tags', c.tags, 30, 'האשטגים'); set('c-ment', c.ment, 20, 'תיוגי @');

  const auto = $('auto_on').checked;
  $('auto-body').hidden = !auto;
  $('pv-bot').hidden = !auto || !$('auto_keyword').value.trim();
  $('pv-bot').textContent = 'הבוט פעיל: מי שמגיב "' + $('auto_keyword').value.trim() + '" מקבל הודעה';

  const sched = form.querySelector('input[name="when"]:checked').value === 'schedule';
  $('when-at').hidden = !sched;
  $('publish_at').required = sched;
  $('post-submit').textContent = sched ? 'תזמון' : 'פרסום עכשיו';
}

/** Center-crops to the chosen ratio at 1080px wide and encodes JPEG (Meta's only image format). */
async function toJpeg(file, r) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let sw = bmp.width, sh = bmp.height;
  if (sw / sh > r) sw = Math.round(sh * r); else sh = Math.round(sw / r);
  const sx = Math.round((bmp.width - sw) / 2), sy = Math.round((bmp.height - sh) / 2);
  const W = 1080, H = Math.round(W / r);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, W, H);
  return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
}

$('files').addEventListener('change', (e) => {
  for (const f of e.target.files) {
    if (files.length >= MAX) break;
    if (f.type.startsWith('image/')) files.push({ file: f, url: URL.createObjectURL(f) });
  }
  e.target.value = '';
  render();
});
form.addEventListener('input', render);
form.addEventListener('change', render);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!files.length) { $('progress').textContent = 'צריך לפחות תמונה אחת'; return; }
  const btn = $('post-submit'); btn.disabled = true;
  const bar = $('upload-bar'); bar.max = files.length; bar.value = 0; bar.hidden = false;
  try {
    const keys = [];
    for (let i = 0; i < files.length; i++) {
      $('progress').textContent = 'מעלה תמונה ' + (i + 1) + ' מתוך ' + files.length + '...';
      const blob = await toJpeg(files[i].file, RATIO[ratio()]);
      const res = await fetch('/admin/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const out = await res.json();
      if (!res.ok || !out.key) throw new Error(out.error || 'ההעלאה נכשלה');
      keys.push(out.key);
      bar.value = i + 1;
    }
    $('images').value = keys.join(',');
    $('progress').textContent = 'שולח...';
    btn.dataset.sent = ''; // admin.js re-enables it after a back navigation
    form.submit();
  } catch (err) {
    // fetch() rejects with an English TypeError when the network drops.
    $('progress').textContent = err instanceof TypeError ? 'אין חיבור לרשת. אפשר לנסות שוב.' : err.message;
    bar.hidden = true;
    btn.disabled = false;
  }
});

render();
</script>
</body>
</html>`;
}
