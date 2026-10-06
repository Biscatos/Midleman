// ─── Midleman select ─────────────────────────────────────────────────────────
// Native <select> dropdowns cannot be styled, so every single-choice <select>
// in the dashboard gets a themed trigger + listbox. The native element stays
// in the DOM (visually hidden) and remains the single source of truth:
//   • existing code keeps reading/writing `select.value`, `.innerHTML`, options;
//   • picking an item sets the native value and dispatches `input` + `change`,
//     so inline `onchange=` handlers and listeners run exactly as before;
//   • programmatic `select.value = …`, option changes and `disabled` toggles
//     are mirrored back into the trigger automatically.
// Opt out per element with `data-native`.
(function () {
  'use strict';

  const ENHANCED = new WeakMap(); // select → { trigger, label }
  let open = null;                // { select, trigger, panel, items, active }

  const CHEVRON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function eligible(sel) {
    return sel instanceof HTMLSelectElement
      && !sel.multiple && !(sel.size > 1)
      && !sel.hasAttribute('data-native')
      && !sel.classList.contains('mm-visually-hidden') // already driven by a segmented control
      && !ENHANCED.has(sel);
  }

  function selectedText(sel) {
    const o = sel.options[sel.selectedIndex];
    return o ? o.textContent.trim() : '';
  }

  // Keep programmatic `select.value = x` / `selectedIndex = n` visible.
  function hookValue(sel) {
    for (const prop of ['value', 'selectedIndex']) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      if (!desc || !desc.set) continue;
      Object.defineProperty(sel, prop, {
        configurable: true,
        get() { return desc.get.call(this); },
        set(v) { desc.set.call(this, v); sync(this); },
      });
    }
  }

  function sync(sel) {
    const st = ENHANCED.get(sel);
    if (!st) return;
    const text = selectedText(sel);
    st.label.textContent = text || ' ';
    // Only a real placeholder (an empty, disabled first option such as "Choose…") is muted;
    // "All types" / "Any status" with value "" are legitimate choices.
    const cur = sel.options[sel.selectedIndex];
    st.trigger.classList.toggle('is-placeholder', !!cur && cur.disabled && !cur.value);
    st.trigger.disabled = sel.disabled;
    st.trigger.title = text;
    // Mirror the native element's own visibility (code toggles style.display on it).
    st.trigger.style.display = sel.style.display === 'none' ? 'none' : '';
  }

  function enhance(sel) {
    if (!eligible(sel)) return;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mm-select';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    // Accessible name: the field's <label for>, else aria-label, else the select's title.
    const lbl = sel.id && document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);
    if (lbl) { if (!lbl.id) lbl.id = 'mmlbl-' + sel.id; trigger.setAttribute('aria-labelledby', lbl.id + ' ' + (trigger.id = 'mmsel-' + sel.id)); }
    else if (sel.getAttribute('aria-label')) trigger.setAttribute('aria-label', sel.getAttribute('aria-label'));
    // Keep the select's layout: inline width/flex/margins move to the trigger.
    const keep = ['width', 'minWidth', 'maxWidth', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'margin', 'marginTop', 'marginLeft', 'marginRight', 'marginBottom', 'gridColumn', 'alignSelf'];
    for (const k of keep) if (sel.style[k]) trigger.style[k] = sel.style[k];
    if (sel.classList.contains('wz-input')) trigger.classList.add('mm-select--wz');
    const label = document.createElement('span');
    label.className = 'mm-select__value';
    trigger.appendChild(label);
    trigger.insertAdjacentHTML('beforeend', `<span class="mm-select__chev">${CHEVRON}</span>`);

    sel.classList.add('mm-select-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.after(trigger);
    ENHANCED.set(sel, { trigger, label });
    hookValue(sel);
    sync(sel);

    trigger.addEventListener('click', () => (open && open.select === sel ? close() : show(sel)));
    trigger.addEventListener('keydown', (e) => onTriggerKey(e, sel));
    sel.addEventListener('change', () => sync(sel));
    sel.addEventListener('focus', () => trigger.focus());
    // Options/attributes rewritten by code (innerHTML, disabled, style.display…)
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'style'] });
  }

  // ── Listbox ──────────────────────────────────────────────────────────────
  function show(sel) {
    close();
    const st = ENHANCED.get(sel);
    if (!st || sel.disabled) return;
    const panel = document.createElement('div');
    panel.className = 'mm-select-panel';
    panel.setAttribute('role', 'listbox');
    panel.id = 'mmlist-' + (sel.id || Math.random().toString(36).slice(2));
    const items = [];
    let group = null;
    for (const opt of sel.options) {
      if (opt.hidden) continue;
      const og = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null;
      if (og && og !== group) {
        group = og;
        const h = document.createElement('div');
        h.className = 'mm-select-group';
        h.textContent = og.label;
        panel.appendChild(h);
      }
      const it = document.createElement('div');
      it.className = 'mm-select-option';
      it.setAttribute('role', 'option');
      it.id = panel.id + '-' + items.length;
      const selected = opt.index === sel.selectedIndex;
      it.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (opt.disabled || (og && og.disabled)) it.setAttribute('aria-disabled', 'true');
      it.innerHTML = `<span class="mm-select-option__text"></span><span class="mm-select-option__check">${CHECK}</span>`;
      it.firstChild.textContent = opt.textContent.trim();
      it.dataset.index = String(opt.index);
      it.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on trigger
      it.addEventListener('click', () => { if (it.getAttribute('aria-disabled') !== 'true') pick(sel, opt.index); });
      it.addEventListener('mousemove', () => setActive(items.indexOf(it)));
      panel.appendChild(it);
      items.push(it);
    }
    if (!items.length) return;
    document.body.appendChild(panel);
    open = { select: sel, trigger: st.trigger, panel, items, active: -1 };
    st.trigger.setAttribute('aria-expanded', 'true');
    st.trigger.setAttribute('aria-controls', panel.id);
    st.trigger.classList.add('is-open');
    place();
    const cur = items.findIndex(i => Number(i.dataset.index) === sel.selectedIndex);
    setActive(cur >= 0 ? cur : firstEnabled(0, 1));
  }

  function place() {
    if (!open) return;
    const r = open.trigger.getBoundingClientRect();
    const p = open.panel;
    p.style.minWidth = Math.round(r.width) + 'px';
    p.style.left = Math.round(Math.min(r.left, window.innerWidth - Math.max(r.width, p.offsetWidth) - 8)) + 'px';
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const h = Math.min(p.scrollHeight, 320);
    if (below < h && above > below) {
      p.style.maxHeight = Math.min(320, above) + 'px';
      p.style.top = Math.round(r.top - Math.min(h, above) - 4) + 'px';
      p.classList.add('is-above');
    } else {
      p.style.maxHeight = Math.min(320, below) + 'px';
      p.style.top = Math.round(r.bottom + 4) + 'px';
      p.classList.remove('is-above');
    }
  }

  function close() {
    if (!open) return;
    open.panel.remove();
    open.trigger.setAttribute('aria-expanded', 'false');
    open.trigger.removeAttribute('aria-controls');
    open.trigger.removeAttribute('aria-activedescendant');
    open.trigger.classList.remove('is-open');
    open = null;
  }

  function pick(sel, index) {
    const changed = sel.selectedIndex !== index;
    const trigger = ENHANCED.get(sel).trigger;
    close();
    if (changed) {
      sel.selectedIndex = index;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    trigger.focus();
  }

  function firstEnabled(from, step) {
    if (!open) return -1;
    const n = open.items.length;
    for (let i = 0, k = from; i < n; i++, k = (k + step + n) % n) {
      if (open.items[k].getAttribute('aria-disabled') !== 'true') return k;
    }
    return -1;
  }

  function setActive(i) {
    if (!open || i < 0) return;
    open.items.forEach((it, k) => it.classList.toggle('is-active', k === i));
    open.active = i;
    open.trigger.setAttribute('aria-activedescendant', open.items[i].id);
    open.items[i].scrollIntoView({ block: 'nearest' });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────
  let typeBuf = '', typeTimer = 0;
  function onTriggerKey(e, sel) {
    const isOpen = open && open.select === sel;
    switch (e.key) {
      case 'ArrowDown': case 'ArrowUp': {
        e.preventDefault();
        if (!isOpen) { show(sel); return; }
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive(firstEnabled((open.active + step + open.items.length) % open.items.length, step));
        return;
      }
      case 'Home': case 'End':
        if (!isOpen) return;
        e.preventDefault();
        setActive(e.key === 'Home' ? firstEnabled(0, 1) : firstEnabled(open.items.length - 1, -1));
        return;
      case 'Enter': case ' ':
        e.preventDefault();
        if (!isOpen) { show(sel); return; }
        if (open.active >= 0) pick(sel, Number(open.items[open.active].dataset.index));
        return;
      case 'Escape':
        if (isOpen) { e.preventDefault(); e.stopPropagation(); close(); }
        return;
      case 'Tab':
        if (isOpen) close();
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Type-ahead: jump to the first option starting with the typed text.
          clearTimeout(typeTimer);
          typeBuf += e.key.toLowerCase();
          typeTimer = setTimeout(() => { typeBuf = ''; }, 600);
          if (!isOpen) show(sel);
          if (!open) return;
          const k = open.items.findIndex(it => it.getAttribute('aria-disabled') !== 'true' && it.textContent.trim().toLowerCase().startsWith(typeBuf));
          if (k >= 0) setActive(k);
        }
    }
  }

  // ── Global wiring ────────────────────────────────────────────────────────
  document.addEventListener('mousedown', (e) => {
    if (open && !open.panel.contains(e.target) && !open.trigger.contains(e.target)) close();
  }, true);
  window.addEventListener('resize', () => { if (open) place(); });
  document.addEventListener('scroll', (e) => {
    if (open && !open.panel.contains(e.target)) close();
  }, true);

  function enhanceAll(root) {
    if (root instanceof HTMLSelectElement) { enhance(root); return; }
    if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhance);
  }
  enhanceAll(document);
  // Selects rendered later by the dashboard (tables, editors, modals).
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) enhanceAll(n);
  }).observe(document.body, { childList: true, subtree: true });

  window.mmSelectSync = sync; // for code that rebuilds options in bulk
})();
