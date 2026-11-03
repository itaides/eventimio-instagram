/**
 * Shared admin shell: <head>, brand styles and the header with section tabs.
 * Every admin page renders `${shell(...)}` first and its own <main> after.
 */
import { esc } from './util.js';

const TABS = [
  { id: 'rules', href: '/admin', label: 'אוטומציות' },
  { id: 'post', href: '/admin/post', label: 'פוסט חדש' },
];

/**
 * @param {{title: string, s: object, pending?: number, active: 'rules'|'post'}} p
 */
export function shell({ title, s, pending = 0, active }) {
  const connected = Boolean(s.token);
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(s.brand)}</title>
<link rel="icon" href="${esc(s.brandIcon || '/icon.svg')}">
<link rel="preload" href="/fonts/heebo-hebrew.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/admin.css">
<script src="/admin.js" defer></script>
</head>
<body>
<header class="top">
  <div class="top__in">
    ${s.brandLogo
      ? `<img class="top__logo" src="${esc(s.brandLogo)}" alt="${esc(s.brand)}">`
      : `<span class="top__brand">${esc(s.brand)}</span>`}
    <nav class="tabs" aria-label="ניווט">
      ${TABS.map((t) => `<a href="${t.href}"${t.id === active ? ' aria-current="page"' : ''}>${t.label}</a>`).join('')}
    </nav>
    <span class="top__grow"></span>
    ${connected
      ? `<span class="chip"><span class="dot" aria-hidden="true"></span>מחובר${s.username ? ` · <bdi dir="ltr">@${esc(s.username)}</bdi>` : ''}</span>`
      : '<span class="chip"><span class="dot dot--off" aria-hidden="true"></span>לא מחובר</span>'}
    ${pending ? `<span class="chip chip--candy">${pending} הודעות בתור</span>` : ''}
    <form class="inline-form" method="post" action="/admin"><input type="hidden" name="action" value="verify"><button class="btn ${connected && s.username ? 'btn--quiet' : 'btn--primary'}">בדיקת חיבור</button></form>
  </div>
</header>`;
}

/**
 * A destructive POST behind a native modal: the trigger opens the <dialog> with Invoker Commands
 * (public/admin.js covers browsers without them), and only the dialog's own button submits.
 * @param {{id: string, trigger: string, title: string, confirm: string, fields: object,
 *   action?: string, triggerClass?: string}} p
 */
export function confirmAction({ id, trigger, title, confirm, fields, action = '/admin', triggerClass = 'btn' }) {
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join('');
  return `<button type="button" class="${triggerClass}" command="show-modal" commandfor="${id}">${trigger}</button>
<dialog id="${id}" class="confirm" closedby="any" aria-labelledby="${id}-title">
  <h2 id="${id}-title">${title}</h2>
  <form method="post" action="${action}" class="confirm__actions">${hidden}
    <button type="button" class="btn" command="close" commandfor="${id}" autofocus>חזרה</button>
    <button class="btn btn--danger">${confirm}</button>
  </form>
</dialog>`;
}
