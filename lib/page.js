// Helper library injected into Safari pages via AppleScript `do JavaScript`.
// It is idempotent: the first call on a page installs it, later calls reuse it.
// A page reload or navigation discards it, and the next tool call re-installs it.
(function () {
  if (window.__mcp && window.__mcp.v === 1) return;

  const M = (window.__mcp = {
    v: 1,
    refs: new Map(),
    elToRef: new WeakMap(),
    next: 1,
    logs: [],
    net: [],
    installedAt: Date.now(),
    confirmResult: false,
    promptResult: null,
  });

  const push = (arr, item, cap) => {
    arr.push(item);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  };
  const fmt = (a) => {
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (a instanceof Element) return '<' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + '>';
      if (typeof a === 'object' && a !== null) return JSON.stringify(a);
    } catch (e) {}
    return String(a);
  };
  M.log = (level, text) => push(M.logs, { level, text, time: Date.now(), url: location.href }, 1000);

  // ---- console capture ----
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level];
    console[level] = function (...args) {
      try { M.log(level, args.map(fmt).join(' ')); } catch (e) {}
      return orig.apply(this, args);
    };
  });
  addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      M.log('error', 'Failed to load <' + t.tagName.toLowerCase() + '>: ' + (t.src || t.href || ''));
      return;
    }
    M.log('exception', (e.error && e.error.stack) || e.message + ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')');
  }, true);
  addEventListener('unhandledrejection', (e) => M.log('exception', 'Unhandled promise rejection: ' + fmt(e.reason)));

  // ---- blocking dialogs would freeze AppleScript, so replace them ----
  window.alert = function (msg) { M.log('dialog', 'alert(' + JSON.stringify(String(msg)) + ') auto-dismissed'); };
  window.confirm = function (msg) {
    const r = !!M.confirmResult;
    M.log('dialog', 'confirm(' + JSON.stringify(String(msg)) + ') auto-answered ' + r + ' (set window.__mcp.confirmResult to change)');
    return r;
  };
  window.prompt = function (msg, def) {
    const r = M.promptResult;
    M.log('dialog', 'prompt(' + JSON.stringify(String(msg)) + ') auto-answered ' + JSON.stringify(r) + ' (set window.__mcp.promptResult to change)');
    return r;
  };

  // ---- network capture (fetch + XHR) ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      let url = typeof input === 'string' ? input : (input && input.url) || String(input);
      try { url = new URL(url, location.href).href; } catch (e) {}
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const rec = { type: 'fetch', method, url, start: Date.now() };
      push(M.net, rec, 500);
      return origFetch.apply(this, arguments).then(
        (r) => { rec.status = r.status; rec.duration = Date.now() - rec.start; return r; },
        (err) => { rec.error = String(err); rec.duration = Date.now() - rec.start; throw err; }
      );
    };
  }
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    let u = url;
    try { u = new URL(url, location.href).href; } catch (e) {}
    this.__mcpReq = { type: 'xhr', method: String(method).toUpperCase(), url: u };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const rec = this.__mcpReq;
    if (rec) {
      rec.start = Date.now();
      push(M.net, rec, 500);
      this.addEventListener('loadend', () => { rec.status = this.status; rec.duration = Date.now() - rec.start; });
    }
    return XS.apply(this, arguments);
  };

  // ---- element refs ----
  M.ref = (el) => {
    let r = M.elToRef.get(el);
    if (!r) {
      r = 'ref_' + M.next++;
      M.elToRef.set(el, r);
      M.refs.set(r, new WeakRef(el));
    }
    return r;
  };
  M.get = (r) => {
    const w = M.refs.get(r);
    const el = w && w.deref();
    if (!el || !el.isConnected) throw new Error('Element ' + r + ' not found. The page may have changed or reloaded; call read_page or find again.');
    return el;
  };

  // ---- roles and names ----
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox',
    number: 'spinbutton', hidden: null,
  };
  const TAG_ROLES = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', SVG: null,
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    FORM: 'form', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', UL: 'list', OL: 'list',
    LI: 'listitem', DIALOG: 'dialog', SUMMARY: 'button', LABEL: 'label', IFRAME: 'iframe',
    VIDEO: 'video', AUDIO: 'audio', OPTION: 'option', CANVAS: 'canvas', ARTICLE: 'article',
    SECTION: 'region', FIELDSET: 'group', LEGEND: 'legend', P: 'paragraph', DETAILS: 'group',
  };
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
    'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem',
  ]);
  // Container roles: their text belongs to children, so do not use it as their name.
  const NO_CONTENT_NAME = new Set([
    'paragraph', 'region', 'list', 'listitem', 'table', 'row', 'rowgroup', 'cell', 'grid', 'form', 'search',
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'group', 'article', 'dialog', 'alertdialog',
    'note', 'figure', 'tablist', 'tabpanel', 'menu', 'menubar', 'tree', 'toolbar', 'alert', 'status', 'log',
    'document', 'application', 'feed', 'presentation', 'none', 'generic', 'iframe', 'video', 'audio', 'canvas',
  ]);
  M.role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t in INPUT_ROLES ? INPUT_ROLES[t] : 'textbox';
    }
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return 'textbox';
    return TAG_ROLES[tag] || null;
  };
  const clean = (s, max = 100) => {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };
  M.name = (el, role) => {
    let n = el.getAttribute('aria-label');
    if (n) return clean(n);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      n = lb.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? e.innerText || e.textContent : ''; }).join(' ');
      if (clean(n)) return clean(n);
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) { n = clean(el.labels[0].innerText); if (n) return n; }
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value || el.type);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'IMG') return clean(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (el.getAttribute('title')) return clean(el.getAttribute('title'));
    if (role && !NO_CONTENT_NAME.has(role)) {
      return clean(el.innerText || el.textContent);
    }
    return '';
  };
  M.visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const s = getComputedStyle(el);
      return s.display === 'contents';
    }
    return true;
  };
  M.isInteractive = (el, role) => {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || el.isContentEditable) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0) return true;
    try {
      if (getComputedStyle(el).cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer')) return true;
    } catch (e) {}
    return false;
  };
  const extras = (el, role) => {
    const out = [];
    if (role === 'heading') out.push('level=' + el.tagName.slice(1));
    if (role === 'link') {
      const h = el.getAttribute('href');
      if (h && !h.startsWith('javascript:')) out.push('href="' + clean(h, 120) + '"');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type && el.type !== 'text' && el.tagName === 'INPUT') out.push('type=' + el.type);
      if (el.type === 'checkbox' || el.type === 'radio') out.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type !== 'password' && el.value) out.push('value="' + clean(el.value, 80) + '"');
    }
    if (el.tagName === 'SELECT') {
      const o = el.selectedOptions[0];
      out.push('value="' + clean(o ? o.text : '', 60) + '"');
      out.push('options=[' + Array.from(el.options).slice(0, 15).map((o) => JSON.stringify(clean(o.text, 30))).join(', ') + (el.options.length > 15 ? ', …' : '') + ']');
    }
    if (el.getAttribute('aria-checked')) out.push('checked=' + el.getAttribute('aria-checked'));
    if (el.getAttribute('aria-expanded')) out.push('expanded=' + el.getAttribute('aria-expanded'));
    if (el.getAttribute('aria-selected') === 'true') out.push('selected');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    return out.length ? ' ' + out.join(' ') : '';
  };
  M.describe = (el) => {
    const role = M.role(el) || el.tagName.toLowerCase();
    const n = M.name(el, role);
    return role + (n ? ' "' + n + '"' : '') + ' [' + M.ref(el) + ']' + extras(el, role);
  };
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const kids = (el) => {
    const list = [];
    const root = el.shadowRoot ? [el.shadowRoot, el] : [el];
    for (const r of root) for (const c of r.childNodes) list.push(c);
    if (el.tagName === 'SLOT') for (const c of el.assignedNodes()) list.push(c);
    return list;
  };

  // ---- read_page ----
  M.tree = ({ filter = 'all', ref_id, max_depth = 25, max_chars = 40000, viewport_only = false } = {}) => {
    const lines = [];
    let chars = 0;
    let truncated = false;
    const add = (depth, s) => {
      if (chars > max_chars) { truncated = true; return; }
      const line = '  '.repeat(depth) + '- ' + s;
      lines.push(line);
      chars += line.length + 1;
    };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD']);
    const walk = (node, depth) => {
      if (truncated || depth > max_depth) return;
      if (node.nodeType === 3) {
        if (filter !== 'interactive') {
          const t = clean(node.textContent, 200);
          if (t && node.parentElement && !M.elToRef.has(node.parentElement)) add(depth, 'text "' + t + '"');
        }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 11) { for (const c of node.childNodes) walk(c, depth); return; }
      const el = node;
      if (SKIP.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (!M.visible(el)) return;
      const role = M.role(el);
      const interactive = M.isInteractive(el, role);
      let printed = false;
      if (filter === 'interactive') {
        if (interactive && (!viewport_only || inViewport(el))) { add(0, M.describe(el)); printed = true; }
      } else if (role || interactive) {
        if (!viewport_only || inViewport(el)) { add(depth, M.describe(el)); printed = true; }
      }
      // Named leaves (buttons, links, headings…) already show their text; do not repeat it.
      if (printed && role && ['button', 'link', 'heading', 'option', 'img', 'label', 'combobox', 'textbox', 'searchbox', 'tab', 'menuitem'].includes(role)) {
        if (!el.querySelector('a,button,input,select,textarea,[role],[tabindex],[contenteditable]')) return;
      }
      if (el.tagName === 'SELECT') return;
      for (const c of kids(el)) walk(c, printed ? depth + 1 : depth);
    };
    let start = document.body || document.documentElement;
    if (ref_id) start = M.get(ref_id);
    walk(start, 0);
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
      truncated,
      tree: lines.join('\n'),
    };
  };

  // ---- find ----
  M.find = ({ query, limit = 20 }) => {
    const q = String(query).toLowerCase();
    const tokens = q.split(/[^a-z0-9@._-]+/i).filter(Boolean);
    const results = [];
    const all = [];
    const collect = (root) => {
      for (const el of root.querySelectorAll('*')) {
        all.push(el);
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    };
    collect(document);
    for (const el of all) {
      const role = M.role(el);
      const interactive = M.isInteractive(el, role);
      if (!role && !interactive) continue;
      if (!M.visible(el)) continue;
      const n = M.name(el, role || 'x').toLowerCase();
      const hay = [role || '', n, el.getAttribute('placeholder') || '', el.id || '', el.getAttribute('name') || '',
        el.getAttribute('type') || '', el.getAttribute('href') || '', el.getAttribute('data-testid') || '',
        typeof el.className === 'string' ? el.className : ''].join(' ').toLowerCase();
      let score = 0;
      if (n && n === q) score += 10;
      else if (n && n.includes(q)) score += 6;
      for (const t of tokens) {
        if (t.length > 2 ? hay.includes(t) : new RegExp('(^|[^a-z0-9])' + t.replace(/[.]/g, '\\.') + '($|[^a-z0-9])').test(hay)) score += t.length > 2 ? 2 : 1;
      }
      if (!score) continue;
      if (interactive) score += 1;
      if (inViewport(el)) score += 0.5;
      results.push({ el, score });
    }
    results.sort((a, b) => b.score - a.score);
    const out = [];
    const seen = new Set();
    for (const { el } of results) {
      if (out.length >= limit) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      out.push(M.describe(el) + ' at (' + Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) + ')' + (inViewport(el) ? '' : ' offscreen'));
    }
    return out;
  };

  // ---- page text ----
  M.text = ({ max_chars = 100000 } = {}) => {
    let root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]');
    if (!root || clean(root.innerText, 1e9).length < 200) root = document.body;
    let t = (root ? root.innerText : document.documentElement.innerText) || '';
    t = t.replace(/\n{3,}/g, '\n\n');
    const truncated = t.length > max_chars;
    return { url: location.href, title: document.title, truncated, text: truncated ? t.slice(0, max_chars) : t };
  };

  // ---- input simulation ----
  const deepFromPoint = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  M.deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  M.point = ({ coordinate, ref }) => {
    if (ref) {
      const el = M.get(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, el: deepFromPoint(x, y) && el.contains(deepFromPoint(x, y)) ? deepFromPoint(x, y) : el };
    }
    if (!coordinate) throw new Error('Provide coordinate [x, y] or ref');
    const [x, y] = coordinate;
    const el = deepFromPoint(x, y);
    if (!el) throw new Error('No element at (' + x + ',' + y + '). Viewport is ' + innerWidth + 'x' + innerHeight + '.');
    return { x, y, el };
  };
  const mods = (m = '') => {
    const s = String(m).toLowerCase();
    return { ctrlKey: /ctrl|control/.test(s), shiftKey: /shift/.test(s), altKey: /alt|option/.test(s), metaKey: /cmd|meta|command/.test(s) };
  };
  const mouseInit = (x, y, button, buttons, extra) => Object.assign({
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x + screenX, screenY: y + screenY, button, buttons,
  }, extra);
  const pointer = (el, type, init) => el.dispatchEvent(new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init)));
  const focusable = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      if (e.matches && e.matches('a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable=true],summary')) return e;
    }
    return null;
  };
  M.hover = ({ coordinate, ref }) => {
    const { x, y, el } = M.point({ coordinate, ref });
    const init = mouseInit(x, y, 0, 0);
    pointer(el, 'pointerover', init); el.dispatchEvent(new MouseEvent('mouseover', init));
    pointer(el, 'pointerenter', Object.assign({}, init, { bubbles: false })); el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, init, { bubbles: false })));
    pointer(el, 'pointermove', init); el.dispatchEvent(new MouseEvent('mousemove', init));
    return 'Hovered ' + M.describe(el) + ' at (' + Math.round(x) + ',' + Math.round(y) + ')';
  };
  M.click = ({ coordinate, ref, button = 'left', count = 1, modifiers }) => {
    const { x, y, el } = M.point({ coordinate, ref });
    const b = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
    const bs = b === 2 ? 2 : b === 1 ? 4 : 1;
    const md = mods(modifiers);
    const desc = M.describe(el);
    M.hover({ coordinate: [x, y] });
    for (let i = 1; i <= count; i++) {
      const down = mouseInit(x, y, b, bs, Object.assign({ detail: i }, md));
      const up = mouseInit(x, y, b, 0, Object.assign({ detail: i }, md));
      pointer(el, 'pointerdown', down);
      const ok = el.dispatchEvent(new MouseEvent('mousedown', down));
      if (ok && i === 1) {
        const f = focusable(el);
        if (f) f.focus({ preventScroll: true });
        else if (M.deepActive() && M.deepActive() !== document.body) M.deepActive().blur();
      }
      pointer(el, 'pointerup', up);
      el.dispatchEvent(new MouseEvent('mouseup', up));
      if (b === 2) el.dispatchEvent(new MouseEvent('contextmenu', up));
      else if (b === 0) el.dispatchEvent(new MouseEvent('click', up));
      else el.dispatchEvent(new MouseEvent('auxclick', up));
    }
    if (count === 2 && b === 0) el.dispatchEvent(new MouseEvent('dblclick', mouseInit(x, y, 0, 0, Object.assign({ detail: 2 }, md))));
    if (count >= 3 && b === 0) {
      const t = M.deepActive();
      if (t && typeof t.select === 'function') t.select();
      else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    }
    return 'Clicked ' + desc + ' at (' + Math.round(x) + ',' + Math.round(y) + ')';
  };
  M.drag = ({ start, end }) => {
    const a = M.point({ coordinate: start });
    const [ex, ey] = end;
    const target = deepFromPoint(ex, ey) || document.body;
    pointer(a.el, 'pointerdown', mouseInit(a.x, a.y, 0, 1));
    a.el.dispatchEvent(new MouseEvent('mousedown', mouseInit(a.x, a.y, 0, 1)));
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = a.x + ((ex - a.x) * i) / steps, y = a.y + ((ey - a.y) * i) / steps;
      const over = deepFromPoint(x, y) || target;
      pointer(over, 'pointermove', mouseInit(x, y, 0, 1));
      over.dispatchEvent(new MouseEvent('mousemove', mouseInit(x, y, 0, 1)));
    }
    pointer(target, 'pointerup', mouseInit(ex, ey, 0, 0));
    target.dispatchEvent(new MouseEvent('mouseup', mouseInit(ex, ey, 0, 0)));
    // HTML5 drag and drop
    const src = a.el.closest('[draggable=true]');
    if (src) {
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: a.x, clientY: a.y }));
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ex, clientY: ey }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ex, clientY: ey }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: ex, clientY: ey }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return 'Dragged from (' + Math.round(a.x) + ',' + Math.round(a.y) + ') to (' + ex + ',' + ey + ')';
  };

  const isEditable = (el) => el && (el.isContentEditable ||
    (el.tagName === 'TEXTAREA') ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type)));
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  };
  const keyInfo = (k) => {
    const named = {
      enter: ['Enter', 'Enter', 13], return: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
      backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32],
      arrowup: ['ArrowUp', 'ArrowUp', 38], up: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40],
      arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
      home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
    };
    const lk = k.toLowerCase();
    if (named[lk]) return { key: named[lk][0], code: named[lk][1], keyCode: named[lk][2] };
    if (/^f\d{1,2}$/.test(lk)) return { key: k.toUpperCase(), code: k.toUpperCase(), keyCode: 111 + +lk.slice(1) };
    if (k.length === 1) {
      const up = k.toUpperCase();
      const code = /[a-z]/i.test(k) ? 'Key' + up : /\d/.test(k) ? 'Digit' + k : '';
      return { key: k, code, keyCode: up.charCodeAt(0) };
    }
    return { key: k, code: k, keyCode: 0 };
  };
  const tabbables = () => Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex],[contenteditable=""],[contenteditable=true],summary'))
    .filter((e) => !e.disabled && e.getAttribute('tabindex') !== '-1' && M.visible(e));
  M.pressOne = (combo) => {
    const parts = combo.split('+');
    const keyName = parts.pop();
    const md = mods(parts.join('+'));
    const info = keyInfo(keyName);
    const el = M.deepActive() || document.body;
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode }, md);
    const ok = el.dispatchEvent(new KeyboardEvent('keydown', init));
    const printable = info.key.length === 1 && !md.ctrlKey && !md.metaKey && !md.altKey;
    if (ok && printable) el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: info.key.charCodeAt(0) })));
    if (ok) {
      const k = info.key;
      if (printable && isEditable(el)) document.execCommand('insertText', false, k);
      else if ((md.metaKey || md.ctrlKey) && k.toLowerCase() === 'a') {
        if (typeof el.select === 'function') el.select(); else document.execCommand('selectAll');
      } else if (k === 'Backspace' && isEditable(el)) document.execCommand('delete');
      else if (k === 'Delete' && isEditable(el)) document.execCommand('forwardDelete');
      else if (k === 'Enter') {
        if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand(md.shiftKey ? 'insertLineBreak' : 'insertParagraph') || document.execCommand('insertText', false, '\n');
        else if (el.tagName === 'INPUT' && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
        else if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') el.click();
      } else if (k === ' ' && (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.type === 'checkbox' || el.type === 'radio')) el.click();
      else if (k === 'Tab') {
        const list = tabbables();
        const i = list.indexOf(el);
        const next = list[(i + (md.shiftKey ? -1 : 1) + list.length) % list.length];
        if (next) next.focus();
      } else if (['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp'].includes(k) && !isEditable(el)) {
        const d = { PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9, ArrowDown: 40, ArrowUp: -40 }[k];
        if (k === 'Home') scrollTo(0, 0); else if (k === 'End') scrollTo(0, document.documentElement.scrollHeight); else scrollBy(0, d);
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  };
  M.key = ({ text, repeat = 1 }) => {
    const combos = String(text).trim().split(/\s+/);
    for (let r = 0; r < repeat; r++) for (const c of combos) M.pressOne(c);
    const a = M.deepActive();
    return 'Pressed ' + combos.join(' ') + (repeat > 1 ? ' x' + repeat : '') + (a && a !== document.body ? '; focus: ' + M.describe(a) : '');
  };
  M.type = ({ text }) => {
    const el = M.deepActive();
    if (!isEditable(el)) throw new Error('No editable element is focused. Click an input first (focused: ' + (el ? M.describe(el) : 'none') + ').');
    const s = String(text);
    const perChar = s.length <= 300;
    if (perChar) {
      for (const ch of s) {
        if (ch === '\n') { M.pressOne('Enter'); continue; }
        const info = keyInfo(ch);
        const init = { bubbles: true, cancelable: true, composed: true, key: ch, code: info.code, keyCode: info.keyCode };
        const ok = el.dispatchEvent(new KeyboardEvent('keydown', init));
        if (ok) {
          el.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, init, { charCode: ch.charCodeAt(0) })));
          if (!document.execCommand('insertText', false, ch)) {
            if (!el.isContentEditable) {
              const st = el.selectionStart ?? el.value.length, en = el.selectionEnd ?? el.value.length;
              setNativeValue(el, el.value.slice(0, st) + ch + el.value.slice(en));
              try { el.setSelectionRange(st + 1, st + 1); } catch (e) {}
              el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
            }
          }
        }
        el.dispatchEvent(new KeyboardEvent('keyup', init));
      }
    } else if (!document.execCommand('insertText', false, s)) {
      if (el.isContentEditable) el.textContent += s;
      else setNativeValue(el, el.value + s);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: s }));
    }
    return 'Typed ' + s.length + ' chars into ' + M.describe(el);
  };
  M.scroll = ({ coordinate, direction = 'down', amount = 3 }) => {
    const [x, y] = coordinate || [innerWidth / 2, innerHeight / 2];
    let el = deepFromPoint(x, y);
    const px = amount * 100;
    const dx = direction === 'left' ? -px : direction === 'right' ? px : 0;
    const dy = direction === 'up' ? -px : direction === 'down' ? px : 0;
    const scrollable = (e) => {
      const s = getComputedStyle(e);
      const oy = /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight;
      const ox = /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth;
      return dy ? oy : ox;
    };
    while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement || (el.getRootNode().host);
    const target = !el || el === document.body || el === document.documentElement ? document.scrollingElement || document.documentElement : el;
    const before = [target.scrollLeft, target.scrollTop];
    target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    const name = target === document.scrollingElement || target === document.documentElement ? 'page' : M.describe(target);
    return 'Scrolled ' + name + ' ' + direction + ' from ' + before.join(',') + ' to ' + Math.round(target.scrollLeft) + ',' + Math.round(target.scrollTop);
  };
  M.formInput = ({ ref, value }) => {
    const el = M.get(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (el.tagName === 'SELECT') {
      const v = String(value);
      const opt = Array.from(el.options).find((o) => o.value === v) || Array.from(el.options).find((o) => clean(o.text).toLowerCase() === v.toLowerCase()) || Array.from(el.options).find((o) => clean(o.text).toLowerCase().includes(v.toLowerCase()));
      if (!opt) throw new Error('No option matching ' + JSON.stringify(v) + '. Options: ' + Array.from(el.options).map((o) => o.text).join(', '));
      setNativeValue(el, opt.value);
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 'on' || value === 1;
      if (el.checked !== want) el.click();
      return 'Set ' + M.describe(el);
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, String(value));
    } else if ('value' in el) {
      el.focus();
      setNativeValue(el, String(value));
    } else throw new Error(M.describe(el) + ' is not a form field');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'Set ' + M.describe(el);
  };
  M.consoleRead = ({ pattern, only_errors, clear, limit = 100 }) => {
    let list = M.logs;
    if (only_errors) list = list.filter((l) => l.level === 'error' || l.level === 'exception');
    if (pattern) { const re = new RegExp(pattern, 'i'); list = list.filter((l) => re.test(l.text)); }
    const out = list.slice(-limit).map((l) => '[' + new Date(l.time).toISOString().slice(11, 23) + '] ' + l.level.toUpperCase() + ': ' + l.text);
    if (clear) M.logs.length = 0;
    return { capturing_since: new Date(M.installedAt).toISOString(), count: out.length, messages: out };
  };
  M.networkRead = ({ url_pattern, clear, limit = 100 }) => {
    const hooked = M.net.map((r) => Object.assign({}, r));
    const seen = new Set(hooked.map((r) => r.url));
    const perf = performance.getEntriesByType('resource')
      .filter((e) => !(e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') || !seen.has(e.name))
      .map((e) => ({ type: e.initiatorType, url: e.name, status: e.responseStatus || undefined, duration: Math.round(e.duration), size: e.transferSize || undefined, start: Math.round(performance.timeOrigin + e.startTime) }));
    const nav = performance.getEntriesByType('navigation')[0];
    let list = perf.concat(hooked).sort((a, b) => (a.start || 0) - (b.start || 0));
    if (nav) list.unshift({ type: 'document', url: nav.name, status: nav.responseStatus || undefined, duration: Math.round(nav.duration) });
    if (url_pattern) { const re = new RegExp(url_pattern, 'i'); list = list.filter((r) => re.test(r.url)); }
    list = list.slice(-limit).map((r) => (r.method || 'GET') + ' ' + (r.status != null ? r.status : r.error ? 'ERR' : '-') + ' ' + r.type + ' ' + r.url + (r.duration != null ? ' (' + r.duration + 'ms)' : '') + (r.error ? ' ' + r.error : ''));
    if (clear) { M.net.length = 0; performance.clearResourceTimings(); }
    return { count: list.length, requests: list };
  };
})();
