/**
 * Wizard — a stepped dialog for the dashboard's larger forms.
 *
 * The big config modals had grown to 20–50 fields in one scroll, where you
 * could not see where you were or what still needed filling. A Wizard splits
 * them into steps listed down the left.
 *
 * It is deliberately NOT a strict wizard. Creating a record walks the steps in
 * order (later steps locked, Save only at the end); editing one unlocks every
 * step and keeps Save always available, because changing a single field should
 * never mean paging through five panes.
 *
 * ── Markup ────────────────────────────────────────────────────────────────
 * The page supplies only the panes. Title bar, step nav and footer are built
 * here, so adding a wizard to a modal is one mount() call plus sections:
 *
 *   <div class="modal-overlay" id="thingModal">
 *     <div class="wz-shell">
 *       <section class="wz-step" data-step-id="basics"
 *                data-step-title="Basics" data-step-hint="Name and type">
 *         … fields …
 *       </section>
 *       …
 *     </div>
 *   </div>
 *
 * ── Wiring ────────────────────────────────────────────────────────────────
 *   const wiz = Wizard.mount('thingModal', {
 *     title: 'Thing', subtitle: 'What this is',
 *     onClose: closeThingModal,
 *     onSave:  saveThing,
 *     hidden:  id => id === 'advanced' && !isAdvancedMode(),
 *     problems: () => ({ basics: 'Name is required' }),
 *   });
 *
 * Four hooks belong in the modal's own functions — miss one and the stepper
 * goes stale rather than failing loudly, so they are listed here:
 *   1. open:     wiz.open(isEditing)   — resets and renders
 *   2. save:     if (wiz.focusProblem()) return;
 *   3. change:   wiz.render()          — after anything that changes step
 *                                        visibility or validity
 *   4. close:    wiz.close()           — clears per-instance state
 */
class Wizard {
  /** @param {string|HTMLElement} modal  overlay element or its id */
  static mount(modal, cfg = {}) {
    const root = typeof modal === 'string' ? document.getElementById(modal) : modal;
    // Mounting happens at script load; a page that renders only the login form
    // has no modals, and one missing element must not take the script down.
    if (!root || !root.querySelector('.wz-shell')) {
      console.warn(`Wizard.mount: no .wz-shell for ${modal} — stubbed`);
      return Wizard.stub();
    }
    const w = new Wizard(root, cfg);
    Wizard.registry.set(root.id || cfg.title || String(Wizard.registry.size), w);
    return w;
  }

  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.shell = root.querySelector('.wz-shell');
    if (!this.shell) throw new Error(`Wizard: #${root.id} has no .wz-shell`);

    this.stepIndex = 0;
    this.freeNav = false;
    this.seen = new Set();
    this.nagged = false;
    /** Scratch space for per-modal editor state (repeated rows and the like).
     *  Lives on the instance so two modals can never read each other's. */
    this.store = {};

    this._buildChrome();
  }

  // ── Chrome ────────────────────────────────────────────────────────────────

  _buildChrome() {
    const sections = [...this.shell.querySelectorAll(':scope > .wz-step')];
    if (!sections.length) throw new Error(`Wizard: #${this.root.id} has no .wz-step sections`);
    // Anything else the page put in the shell — an error banner, a status
    // strip — belongs to the dialog as a whole, not to one step. Keep it
    // pinned between the panes and the footer instead of discarding it.
    const extras = [...this.shell.children].filter(el => !el.classList.contains('wz-step'));

    // Each pane gets its own heading, so the step is named twice — once in the
    // nav, once above the fields — and you always know where you are.
    for (const s of sections) {
      if (s.querySelector(':scope > .wz-step-head')) continue;
      const head = document.createElement('header');
      head.className = 'wz-step-head';
      head.innerHTML = `<h4></h4><p></p>`;
      head.querySelector('h4').textContent = s.dataset.stepTitle || '';
      head.querySelector('p').textContent = s.dataset.stepHint || '';
      s.prepend(head);
    }

    const titlebar = document.createElement('div');
    titlebar.className = 'wz-titlebar';
    titlebar.innerHTML = `<div><h3></h3><p class="wz-subtitle"></p></div>
      <button type="button" class="wz-close" aria-label="Close">&times;</button>`;
    this.titleEl = titlebar.querySelector('h3');
    this.subtitleEl = titlebar.querySelector('.wz-subtitle');
    titlebar.querySelector('.wz-close').addEventListener('click', () => this._close());

    const main = document.createElement('div');
    main.className = 'wz-main';
    const wz = document.createElement('div');
    wz.className = 'wz';
    this.nav = document.createElement('nav');
    this.nav.className = 'wz-nav';
    this.body = document.createElement('div');
    this.body.className = 'wz-body';
    sections.forEach(s => this.body.appendChild(s));
    wz.append(this.nav, this.body);
    main.appendChild(wz);

    const foot = document.createElement('div');
    foot.className = 'wz-foot';
    foot.innerHTML = `<span class="wz-progress"></span>
      <div class="wz-foot-actions">
        <button type="button" class="btn btn-sm" data-wz="cancel">Cancel</button>
        <button type="button" class="btn btn-sm" data-wz="back">Back</button>
        <button type="button" class="btn btn-primary btn-sm" data-wz="next">Next</button>
        <button type="button" class="btn btn-primary btn-sm" data-wz="save"></button>
      </div>`;
    this.progressEl = foot.querySelector('.wz-progress');
    this.backBtn = foot.querySelector('[data-wz="back"]');
    this.nextBtn = foot.querySelector('[data-wz="next"]');
    this.saveBtn = foot.querySelector('[data-wz="save"]');
    this.saveBtn.textContent = this.cfg.saveLabel || 'Save';
    // Some modals' save functions already drive their button by id (disabling
    // it, swapping the label). Let the generated one adopt that id so their
    // code keeps working untouched.
    if (this.cfg.saveId) this.saveBtn.id = this.cfg.saveId;
    foot.querySelector('[data-wz="cancel"]').addEventListener('click', () => this._close());
    this.backBtn.addEventListener('click', () => this.step(-1));
    this.nextBtn.addEventListener('click', () => this.step(1));
    this.saveBtn.addEventListener('click', ev => this.cfg.onSave?.(ev));

    this.shell.replaceChildren(titlebar, main, ...extras, foot);
    extras.forEach(el => el.classList.add('wz-extra'));
  }

  _close() {
    // Give the modal's own close function the chance to do its bookkeeping; it
    // is expected to call wiz.close() in turn.
    if (this.cfg.onClose) this.cfg.onClose();
    else this.close();
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  /** Steps that currently apply — `hidden(id)` drops the ones that don't, so an
   *  inapplicable pane disappears from the nav instead of showing up empty. */
  steps() {
    const all = [...this.body.querySelectorAll('.wz-step')];
    return this.cfg.hidden ? all.filter(s => !this.cfg.hidden(s.dataset.stepId)) : all;
  }

  /** Reset for a fresh showing. `isEdit` unlocks free navigation. */
  open(isEdit = false, opts = {}) {
    this.stepIndex = 0;
    this.freeNav = !!isEdit;
    this.seen = new Set();
    this.nagged = false;
    if (opts.resetStore !== false) this.store = {};
    if (opts.title !== undefined) this.cfg.title = opts.title;
    if (opts.subtitle !== undefined) this.cfg.subtitle = opts.subtitle;
    this.render();
  }

  /** Clear per-instance state. Call from the modal's close function so a
   *  cancelled edit can't leak into the next showing. */
  close() {
    this.store = {};
    this.seen = new Set();
    this.nagged = false;
  }

  go(i) {
    const steps = this.steps();
    if (!steps.length) return;
    this.stepIndex = Math.max(0, Math.min(i, steps.length - 1));
    this.render();
    this.body.scrollTop = 0;
  }

  step(delta) { this.go(this.stepIndex + delta); }

  /** Index of a step by its data-step-id, among the ones currently shown. */
  indexOf(stepId) { return this.steps().findIndex(s => s.dataset.stepId === stepId); }

  render() {
    const steps = this.steps();
    if (!steps.length) return;
    if (this.stepIndex >= steps.length) this.stepIndex = steps.length - 1;

    const problems = this.cfg.problems ? (this.cfg.problems() || {}) : {};
    this.seen.add(steps[this.stepIndex].dataset.stepId);
    // A blank new form shouldn't open covered in warnings about fields nobody
    // has reached yet: a problem surfaces once its step has been seen, or once
    // Save was attempted.
    const show = id => (this.nagged || this.freeNav || this.seen.has(id)) ? problems[id] : undefined;

    this.nav.replaceChildren(...steps.map((s, i) => {
      const bad = show(s.dataset.stepId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wz-nav-item ' +
        (i === this.stepIndex ? 'active' : bad ? 'invalid' : (this.freeNav || i < this.stepIndex) ? 'done' : '');
      // Creation keeps the order — until a save attempt flags problems further
      // on, at which point locking the very steps we complain about is absurd.
      btn.disabled = !this.freeNav && !this.nagged && i > this.stepIndex;
      btn.title = bad || s.dataset.stepHint || '';
      const dot = document.createElement('span');
      dot.className = 'wz-dot';
      dot.textContent = bad && i !== this.stepIndex ? '!' : String(i + 1);
      const text = document.createElement('span');
      text.className = 'wz-nav-text';
      const title = document.createElement('span');
      title.className = 'wz-nav-title';
      title.textContent = s.dataset.stepTitle || '';
      const hint = document.createElement('span');
      hint.className = 'wz-nav-hint';
      hint.textContent = bad || s.dataset.stepHint || '';
      text.append(title, hint);
      btn.append(dot, text);
      btn.addEventListener('click', () => this.go(i));
      return btn;
    }));

    this.body.querySelectorAll('.wz-step').forEach(s => s.classList.remove('active'));
    steps[this.stepIndex].classList.add('active');

    const last = this.stepIndex === steps.length - 1;
    this.backBtn.style.display = this.stepIndex === 0 ? 'none' : '';
    this.nextBtn.style.display = last ? 'none' : '';
    // Save appears only on the last step while creating; when editing it is
    // always there, so a one-field change is one click.
    this.saveBtn.style.display = (this.freeNav || last) ? '' : 'none';

    if (this.titleEl) this.titleEl.textContent = this._resolve(this.cfg.title) || '';
    if (this.subtitleEl) this.subtitleEl.textContent = this._resolve(this.cfg.subtitle) || '';

    // Don't count the step you are standing on: it is normally incomplete
    // simply because you just arrived. After a failed save, everything counts.
    const open = steps.filter((s, i) => show(s.dataset.stepId) && (this.nagged || i !== this.stepIndex)).length;
    this.progressEl.textContent = `Step ${this.stepIndex + 1} of ${steps.length}` +
      (open ? ` · ${open} step${open > 1 ? 's need' : ' needs'} attention` : '');
  }

  _resolve(v) { return typeof v === 'function' ? v(this) : v; }

  /**
   * Jump to the first step with a problem and say what it is. Call at the top
   * of the modal's save function: without it the error names a field sitting on
   * a pane the user cannot see. Returns true when it blocked the save.
   */
  focusProblem() {
    this.nagged = true;
    const problems = this.cfg.problems ? (this.cfg.problems() || {}) : {};
    const steps = this.steps();
    const i = steps.findIndex(s => problems[s.dataset.stepId]);
    if (i === -1) { this.render(); return false; }
    this.go(i);
    const msg = problems[steps[i].dataset.stepId];
    if (typeof toast === 'function') toast(msg, 'error');
    return true;
  }
}

Wizard.registry = new Map();

/** Inert stand-in so callers need no null checks when a modal isn't on the page. */
Wizard.stub = () => ({
  stub: true, store: {},
  open() {}, close() {}, go() {}, step() {}, render() {},
  steps: () => [], indexOf: () => -1, focusProblem: () => false,
});

/** Value of an input, trimmed — the shape most `problems()` checks need. */
Wizard.val = id => (document.getElementById(id)?.value || '').trim();
/** Checked state of a checkbox, tolerating a missing element. */
Wizard.checked = id => !!document.getElementById(id)?.checked;
