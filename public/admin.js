/**
 * Progressive enhancement shared by every admin page. The pages work without it in current
 * browsers; this fills the gaps for older ones and keeps ARIA in step with CSS validation.
 */

// Invoker Commands (Baseline Dec 2025). We only use show-modal and close, so a tiny fallback
// replaces the full polyfill for browsers that predate them.
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[commandfor]');
    const dialog = button && document.getElementById(button.getAttribute('commandfor'));
    if (!(dialog instanceof HTMLDialogElement)) return;
    const command = button.getAttribute('command');
    if (command === 'show-modal' && !dialog.open) dialog.showModal();
    else if (command === 'close') dialog.close();
  });
}

// Light dismiss for <dialog closedby="any"> where the attribute is unknown (Safari). Esc works everywhere.
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (event, dialog) => {
    const r = dialog.getBoundingClientRect();
    return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (event) => { pressedOutside = outside(event, dialog); });
    dialog.addEventListener('pointerup', (event) => {
      if (pressedOutside && outside(event, dialog)) dialog.close();
    });
  }
}

// aria-invalid follows :user-invalid, so screen readers hear the error the moment it shows.
const syncInvalid = (el) => {
  if (el instanceof Element && el.hasAttribute('aria-errormessage')) {
    el.setAttribute('aria-invalid', String(el.matches(':user-invalid')));
  }
};
document.addEventListener('blur', (event) => syncInvalid(event.target), true);
document.addEventListener('input', (event) => syncInvalid(event.target));
document.addEventListener('invalid', (event) => syncInvalid(event.target), true);

// One click, one POST: after a valid submit, the button is disabled so a double click can't post twice.
// Deferred, so the submitter's own name/value still makes it into the form data.
document.addEventListener('submit', (event) => {
  if (event.defaultPrevented || !event.submitter) return;
  const button = event.submitter;
  setTimeout(() => { button.disabled = true; button.dataset.sent = ''; });
});
// Coming back through the back/forward cache must not leave those buttons dead.
addEventListener('pageshow', (event) => {
  if (event.persisted) for (const b of document.querySelectorAll('button[data-sent]')) { b.disabled = false; delete b.dataset.sent; }
});
