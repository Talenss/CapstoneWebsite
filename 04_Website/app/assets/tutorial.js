/* ============================================================
   ResumeMatch PH — Onboarding tour (assets/tutorial.js)
   ------------------------------------------------------------
   Objective 4: "a step-by-step tutorial that users can revisit
   anytime they need assistance."

   Runs automatically the first time a person lands on a page,
   and is replayable forever from the "Show me around" button.
   Steps whose target isn't on screen are skipped silently, so
   the same step list works for an empty account and a full one.

     RMPHTour.init('seeker-dashboard', steps, { user: id });
     RMPHTour.start(true);   // replay, ignoring the "seen" flag

   Each step: { sel: '#id', title: '...', text: '...' }
   ============================================================ */
(function (global) {
  'use strict';

  const T = { key:'', steps:[], i:0, open:false, opts:{}, timer:null, els:null, lastFocus:null };
  const seenKey = () => 'rmph_tour_' + T.key + (T.opts.user ? '_' + T.opts.user : '');
  const visible = () => T.steps.filter(s => {
    const el = document.querySelector(s.sel);
    return el && el.offsetParent !== null;     // exists AND is actually rendered
  });

  function build() {
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const card = document.createElement('div');
    card.className = 'tour-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Tour');
    document.body.appendChild(spot);
    document.body.appendChild(card);
    T.els = { spot, card };
  }

  function place() {
    const steps = visible();
    if (!steps.length) return finish(true);
    if (T.i >= steps.length) T.i = steps.length - 1;
    if (T.i < 0) T.i = 0;

    const step = steps[T.i];
    const el = document.querySelector(step.sel);
    const { spot, card } = T.els;

    el.scrollIntoView({ block:'center', behavior:'smooth' });

    clearTimeout(T.timer);
    T.timer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      spot.style.top = (r.top - 6) + 'px';
      spot.style.left = (r.left - 6) + 'px';
      spot.style.width = (r.width + 12) + 'px';
      spot.style.height = (r.height + 12) + 'px';

      const last = T.i === steps.length - 1;
      card.innerHTML =
        '<h4></h4><p></p>' +
        '<div class="tour-foot">' +
          '<span class="tour-count">Step ' + (T.i + 1) + ' of ' + steps.length + '</span>' +
          '<span class="tour-btns">' +
            '<button class="btn ghost sm" data-skip type="button">Skip</button>' +
            (T.i > 0 ? '<button class="btn ghost sm" data-back type="button">Back</button>' : '') +
            '<button class="btn primary sm" data-next type="button">' + (last ? 'Done' : 'Next') + '</button>' +
          '</span>' +
        '</div>';
      card.querySelector('h4').textContent = step.title;
      card.querySelector('p').textContent = step.text;

      card.querySelector('[data-next]').addEventListener('click', () => last ? finish(true) : (T.i++, place()));
      card.querySelector('[data-skip]').addEventListener('click', () => finish(true));
      const back = card.querySelector('[data-back]');
      if (back) back.addEventListener('click', () => { T.i--; place(); });

      // below the target if it fits, otherwise above; always inside the viewport
      const ch = card.offsetHeight, cw = card.offsetWidth, pad = 14;
      let top = r.bottom + pad;
      if (top + ch > window.innerHeight - 12) top = r.top - ch - pad;
      if (top < 12) top = Math.min(window.innerHeight - ch - 12, Math.max(12, r.bottom + pad));
      const left = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      card.style.top = top + 'px';
      card.style.left = left + 'px';

      card.querySelector('[data-next]').focus({ preventScroll: true });
    }, 260);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    else if (e.key === 'ArrowRight') { const b = T.els.card.querySelector('[data-next]'); if (b) b.click(); }
    else if (e.key === 'ArrowLeft')  { const b = T.els.card.querySelector('[data-back]'); if (b) b.click(); }
    else if (e.key === 'Tab') {                       // keep focus inside the card
      const f = T.els.card.querySelectorAll('button');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  const onMove = () => { if (T.open) place(); };

  function start(force) {
    if (T.open) return;
    if (!force) { try { if (localStorage.getItem(seenKey())) return; } catch (e) {} }
    if (!visible().length) return;

    T.lastFocus = document.activeElement;
    T.open = true; T.i = 0;
    build();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    place();
  }

  function finish(remember) {
    if (!T.open) return;
    clearTimeout(T.timer);
    if (T.els) { T.els.spot.remove(); T.els.card.remove(); T.els = null; }
    T.open = false;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
    if (remember) { try { localStorage.setItem(seenKey(), '1'); } catch (e) {} }
    if (T.lastFocus && T.lastFocus.focus) T.lastFocus.focus();
  }

  function init(key, steps, opts) {
    T.key = key; T.steps = steps || []; T.opts = opts || {};
    // wire every "Show me around" button on the page
    document.querySelectorAll('[data-tour]').forEach(b => b.addEventListener('click', () => start(true)));
    if (T.opts.auto !== false) setTimeout(() => start(false), 700);   // first visit only
  }

  global.RMPHTour = { init, start, stop: () => finish(false) };
})(window);
