#!/usr/bin/env node
// Safari MCP server: browser automation for Claude Code through AppleScript/JXA.
// Zero dependencies. Speaks MCP (JSON-RPC 2.0) over stdio, one message per line.
import { createInterface } from 'node:readline';
import {
  jxa, parseTab, tabKey, resolveTab, callPage, execCode, installLib, waitForLoad,
  markForNav, screenshot, toCss, screenPoint,
} from './lib/safari.mjs';

const VERSION = '0.1.0';
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const INSTRUCTIONS = `Safari browser automation for macOS. Controls the user's real Safari (their sign-ins and cookies).
- Start with tabs_context. Tab ids are "windowId:tabIndex"; indexes shift when tabs close, so re-check tabs_context after closing tabs. Prefer to work in a new tab from tabs_create rather than the user's existing tabs, unless asked.
- Omitting tabId targets the front window's current tab.
- Prefer read_page / find (element refs like ref_12) over screenshot coordinates. Screenshot pixel coordinates map to page viewport coordinates.
- Clicks and typing are synthesized DOM events by default. If a site ignores them (needs trusted events, CSS :hover, file pickers, native menus), retry with native: true (moves the real mouse/keyboard, brings Safari to front, needs Accessibility permission).
- Console and network capture start when a tool first touches a page after it loads. Navigate with this server's navigate tool so capture is installed right after load; reload to catch startup logs.
- alert/confirm/prompt are replaced with non-blocking stubs once a page is touched: confirm() returns false unless you set window.__mcp.confirmResult = true via javascript.`;

const tabProp = { tabId: { type: 'string', description: 'Tab id "windowId:tabIndex" from tabs_context. Omit for the front window\'s current tab.' } };
const coord = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

const TOOLS = [
  {
    name: 'tabs_context',
    description: 'List open Safari windows and tabs with ids, titles and URLs. Call first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_create',
    description: 'Open a new Safari tab (optionally in a new window) and make it current. Returns the new tabId.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, new_window: { type: 'boolean' } } },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab. Other tab indexes in that window shift down.',
    inputSchema: { type: 'object', properties: tabProp, required: ['tabId'] },
  },
  {
    name: 'tabs_select',
    description: 'Make a tab the current tab of its window. bring_to_front also activates Safari.',
    inputSchema: { type: 'object', properties: { ...tabProp, bring_to_front: { type: 'boolean' } }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Go to a URL, or "back", "forward", "reload". Waits for the page to load.',
    inputSchema: { type: 'object', properties: { ...tabProp, url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'read_page',
    description: 'Accessibility-style tree of the page with element refs (ref_N) usable by computer, form_input and scroll_to. filter "interactive" lists only controls.',
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProp,
        filter: { type: 'string', enum: ['all', 'interactive'], default: 'all' },
        ref_id: { type: 'string', description: 'Only the subtree under this ref.' },
        viewport_only: { type: 'boolean', description: 'Only elements in the visible viewport.' },
        max_depth: { type: 'number', default: 25 },
        max_chars: { type: 'number', default: 40000 },
      },
    },
  },
  {
    name: 'find',
    description: 'Find elements by text/label/role/placeholder/id keywords (e.g. "search box", "sign in button"). Returns refs and viewport coordinates.',
    inputSchema: { type: 'object', properties: { ...tabProp, query: { type: 'string' }, limit: { type: 'number', default: 20 } }, required: ['query'] },
  },
  {
    name: 'get_page_text',
    description: 'Readable text of the page (article/main content when present, else body).',
    inputSchema: { type: 'object', properties: { ...tabProp, max_chars: { type: 'number', default: 100000 } } },
  },
  {
    name: 'javascript',
    description: 'Run JavaScript in the page. A single expression returns its value; otherwise use `return`. Top-level await works. Result is JSON-serialized.',
    inputSchema: { type: 'object', properties: { ...tabProp, code: { type: 'string' }, timeout_ms: { type: 'number', default: 30000 } }, required: ['code'] },
  },
  {
    name: 'computer',
    description: `Mouse/keyboard/screenshot actions on a tab.
Actions: screenshot | left_click | right_click | double_click | triple_click | hover | left_click_drag | type | key | scroll | scroll_to | wait.
- Target with coordinate [x,y] (from the latest screenshot) or ref (from read_page/find).
- key: space-separated keys/combos, e.g. "Enter", "Tab Tab", "cmd+a Backspace".
- scroll: direction up/down/left/right, amount in ticks (100px each).
- native: true uses real macOS mouse/keyboard events (Safari comes to front).
Clicks/keys/typing return a screenshot only if screenshot_after is true.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...tabProp,
        action: { type: 'string', enum: ['screenshot', 'left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'left_click_drag', 'type', 'key', 'scroll', 'scroll_to', 'wait'] },
        coordinate: coord,
        start_coordinate: { ...coord, description: 'Drag start' },
        ref: { type: 'string' },
        text: { type: 'string', description: 'Text for type; keys for key' },
        modifiers: { type: 'string', description: 'For clicks, e.g. "cmd" or "shift+alt"' },
        repeat: { type: 'number', description: 'Repeat count for key' },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', default: 3 },
        duration: { type: 'number', description: 'Seconds for wait (max 30)' },
        native: { type: 'boolean' },
        screenshot_after: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  {
    name: 'form_input',
    description: 'Set a form field value by ref: text inputs, textareas, selects (option value or text), checkboxes/radios (true/false), contenteditable.',
    inputSchema: { type: 'object', properties: { ...tabProp, ref: { type: 'string' }, value: { type: ['string', 'boolean', 'number'] } }, required: ['ref', 'value'] },
  },
  {
    name: 'wait_for',
    description: 'Wait until a CSS selector appears, text appears, or a JS expression is truthy.',
    inputSchema: {
      type: 'object',
      properties: { ...tabProp, selector: { type: 'string' }, text: { type: 'string' }, expression: { type: 'string' }, timeout_ms: { type: 'number', default: 10000 } },
    },
  },
  {
    name: 'read_console_messages',
    description: 'Console messages, uncaught exceptions and auto-dismissed dialogs captured from the page since capture was installed.',
    inputSchema: {
      type: 'object',
      properties: { ...tabProp, pattern: { type: 'string', description: 'Regex filter' }, only_errors: { type: 'boolean' }, clear: { type: 'boolean' }, limit: { type: 'number', default: 100 } },
    },
  },
  {
    name: 'read_network_requests',
    description: 'Network requests of the current page: all resources since load (Resource Timing) plus fetch/XHR with method and status since capture was installed.',
    inputSchema: { type: 'object', properties: { ...tabProp, url_pattern: { type: 'string', description: 'Regex filter' }, clear: { type: 'boolean' }, limit: { type: 'number', default: 100 } } },
  },
  {
    name: 'resize_window',
    description: 'Resize the Safari window containing the tab (size in points).',
    inputSchema: { type: 'object', properties: { ...tabProp, width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

async function withShot(t, msg, want) {
  if (!want) return text(msg);
  await new Promise((r) => setTimeout(r, 300));
  const s = await screenshot(t);
  return { content: [{ type: 'text', text: msg }, { type: 'image', data: s.data, mimeType: 'image/jpeg' }] };
}

async function computer(a) {
  const t = await resolveTab(a.tabId);
  const native = !!a.native;
  const cssCoord = a.coordinate ? toCss(t, a.coordinate) : undefined;

  const nativeClick = async (button, count) => {
    let c = cssCoord;
    if (a.ref) {
      const p = await callPage(t, '(M, a) => { const r = M.point(a); return [r.x, r.y]; }', { ref: a.ref });
      c = p;
    }
    if (!c) throw new Error('Provide coordinate or ref');
    await jxa({ op: 'select', t, activate: true });
    const p = await screenPoint(t, c);
    await jxa({ op: 'nativeMouse', x: p.x, y: p.y, button, count, kind: 'click' });
    return `Native ${button} click x${count} at viewport (${Math.round(c[0])},${Math.round(c[1])})`;
  };

  switch (a.action) {
    case 'screenshot': {
      const s = await screenshot(t);
      const note = `${tabKey(t)} ${s.title} — ${s.url}\nImage ${s.width}x${s.height}${s.viewportOnly ? ' (page viewport; use these pixel coordinates)' : ' (whole window: JavaScript unavailable)'}`;
      return { content: [{ type: 'text', text: note }, { type: 'image', data: s.data, mimeType: 'image/jpeg' }] };
    }
    case 'left_click': case 'right_click': case 'double_click': case 'triple_click': {
      const button = a.action === 'right_click' ? 'right' : 'left';
      const count = a.action === 'double_click' ? 2 : a.action === 'triple_click' ? 3 : 1;
      let msg;
      if (native) msg = await nativeClick(button, count);
      else msg = await callPage(t, '(M, a) => M.click(a)', { coordinate: cssCoord, ref: a.ref, button, count, modifiers: a.modifiers });
      if (msg && msg.navigated) msg = 'Clicked; page navigated';
      await new Promise((r) => setTimeout(r, 250));
      if (!native) await installLib(t);
      return withShot(t, msg, a.screenshot_after);
    }
    case 'hover': {
      if (native) {
        const c = a.ref ? await callPage(t, '(M, a) => { const r = M.point(a); return [r.x, r.y]; }', { ref: a.ref }) : cssCoord;
        await jxa({ op: 'select', t, activate: true });
        const p = await screenPoint(t, c);
        await jxa({ op: 'nativeMouse', x: p.x, y: p.y, kind: 'move' });
        return withShot(t, `Native hover at (${c[0]},${c[1]})`, a.screenshot_after);
      }
      return withShot(t, await callPage(t, '(M, a) => M.hover(a)', { coordinate: cssCoord, ref: a.ref }), a.screenshot_after);
    }
    case 'left_click_drag': {
      if (!a.start_coordinate || !a.coordinate) throw new Error('left_click_drag needs start_coordinate and coordinate');
      return withShot(t, await callPage(t, '(M, a) => M.drag(a)', { start: toCss(t, a.start_coordinate), end: cssCoord }), a.screenshot_after);
    }
    case 'type': {
      if (a.text == null) throw new Error('type needs text');
      if (native) {
        await jxa({ op: 'select', t, activate: true });
        await jxa({ op: 'nativeKeys', text: a.text });
        return withShot(t, `Native typed ${a.text.length} chars`, a.screenshot_after);
      }
      if (a.ref) await callPage(t, '(M, a) => { const e = M.get(a.ref); e.scrollIntoView({block:"center"}); e.focus(); }', { ref: a.ref });
      return withShot(t, await callPage(t, '(M, a) => M.type(a)', { text: a.text }, 120000), a.screenshot_after);
    }
    case 'key': {
      if (!a.text) throw new Error('key needs text, e.g. "Enter" or "cmd+a"');
      if (native) {
        await jxa({ op: 'select', t, activate: true });
        await jxa({ op: 'nativeKeys', keys: a.text.trim().split(/\s+/), repeat: a.repeat || 1 });
        await new Promise((r) => setTimeout(r, 200));
        return withShot(t, `Native pressed ${a.text}`, a.screenshot_after);
      }
      let msg = await callPage(t, '(M, a) => M.key(a)', { text: a.text, repeat: a.repeat || 1 });
      if (msg && msg.navigated) msg = `Pressed ${a.text}; page navigated`;
      await new Promise((r) => setTimeout(r, 150));
      await installLib(t);
      return withShot(t, msg, a.screenshot_after);
    }
    case 'scroll': {
      const msg = await callPage(t, '(M, a) => M.scroll(a)', { coordinate: cssCoord, direction: a.scroll_direction || 'down', amount: a.scroll_amount ?? 3 });
      return withShot(t, msg, a.screenshot_after);
    }
    case 'scroll_to': {
      if (!a.ref) throw new Error('scroll_to needs ref');
      const msg = await callPage(t, '(M, a) => { const e = M.get(a.ref); e.scrollIntoView({block:"center", behavior:"instant"}); const r = e.getBoundingClientRect(); return "Scrolled to " + M.describe(e) + " now at (" + Math.round(r.left + r.width/2) + "," + Math.round(r.top + r.height/2) + ")"; }', { ref: a.ref });
      return withShot(t, msg, a.screenshot_after);
    }
    case 'wait': {
      const s = Math.min(Math.max(a.duration ?? 1, 0), 30);
      await new Promise((r) => setTimeout(r, s * 1000));
      return withShot(t, `Waited ${s}s`, a.screenshot_after);
    }
  }
  throw new Error(`Unknown action ${a.action}`);
}

async function navigate(a) {
  const t = await resolveTab(a.tabId);
  const u = String(a.url).trim();
  const prev = await markForNav(t);
  if (u === 'back' || u === 'forward' || u === 'reload') {
    const code = u === 'back' ? 'history.back()' : u === 'forward' ? 'history.forward()' : 'location.reload()';
    await jxa({ op: 'js', t, code: code + '; "ok"' });
  } else {
    let url = u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url) ? 'http://' : 'https://') + url;
    await jxa({ op: 'seturl', t, url });
  }
  const loaded = await waitForLoad(t, { prevUrl: u === 'reload' ? null : prev });
  await installLib(t);
  const info = JSON.parse(await jxa({ op: 'info', t }));
  return text(`${loaded ? 'Loaded' : 'Still loading (timed out waiting)'}: ${info.title || '(no title)'} — ${info.url} [tab ${tabKey(t)}]`);
}

async function javascript(a) {
  const t = await resolveTab(a.tabId);
  let body = a.code;
  try { new AsyncFunction(`return (${a.code}\n)`); body = `return (${a.code}\n);`; } catch {
    try { new AsyncFunction(a.code); } catch (e) { throw new Error(`Syntax error: ${e.message}`); }
  }
  const v = await execCode(t, `return await (async () => {\n${body}\n})();`, a.timeout_ms || 30000);
  if (v && v.navigated) return text('Script ran; page navigated before a result returned.');
  return text(v === null ? 'undefined/null' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

async function waitFor(a) {
  const t = await resolveTab(a.tabId);
  const timeout = a.timeout_ms || 10000;
  const r = await callPage(t, `async (M, a) => {
    const end = Date.now() + a.timeout;
    const test = () => {
      if (a.selector && !document.querySelector(a.selector)) return false;
      if (a.text && !(document.body && document.body.innerText.includes(a.text))) return false;
      if (a.expression && !(0, eval)(a.expression)) return false;
      return true;
    };
    while (Date.now() < end) { if (test()) return true; await new Promise(r => setTimeout(r, 100)); }
    return false;
  }`, { selector: a.selector, text: a.text, expression: a.expression, timeout }, timeout + 5000);
  if (r && r.navigated) return text('Page navigated while waiting; call wait_for again.');
  return text(r ? 'Condition met' : `Timed out after ${timeout}ms`);
}

const HANDLERS = {
  async tabs_context() {
    const wins = JSON.parse(await jxa({ op: 'list' }));
    if (!wins.length) return text('No Safari windows open. Use tabs_create.');
    const lines = [];
    wins.forEach((w, wi) => {
      lines.push(`Window ${w.windowId}${wi === 0 ? ' (front)' : ''} ${w.bounds.width}x${w.bounds.height}`);
      for (const tb of w.tabs) lines.push(`  ${tb.active ? '*' : ' '} ${w.windowId}:${tb.index}  ${tb.title || '(untitled)'} — ${tb.url || 'about:blank'}`);
    });
    lines.push('', '* = current tab of its window. tabId format: windowId:tabIndex');
    return text(lines.join('\n'));
  },
  async tabs_create(a) {
    let url = a.url;
    if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    const t = JSON.parse(await jxa({ op: 'create', url, newWindow: !!a.new_window }));
    if (url) { await waitForLoad(t, {}); await installLib(t); }
    return text(`Created tab ${tabKey(t)}${url ? ' at ' + url : ''}`);
  },
  async tabs_close(a) {
    const t = parseTab(a.tabId);
    await jxa({ op: 'close', t });
    return text(`Closed ${tabKey(t)}. Indexes after ${t.i} in window ${t.w} shifted down by one.`);
  },
  async tabs_select(a) {
    const t = parseTab(a.tabId);
    await jxa({ op: 'select', t, activate: !!a.bring_to_front });
    return text(`Selected ${tabKey(t)}`);
  },
  navigate,
  async read_page(a) {
    const t = await resolveTab(a.tabId);
    const r = await callPage(t, '(M, a) => M.tree(a)', { filter: a.filter, ref_id: a.ref_id, viewport_only: a.viewport_only, max_depth: a.max_depth, max_chars: a.max_chars });
    const v = r.viewport;
    return text(`${r.title} — ${r.url} [tab ${tabKey(t)}]\nViewport ${v.width}x${v.height}, scroll ${v.scrollX},${v.scrollY}, page height ${v.pageHeight}${r.truncated ? '\n(truncated: use ref_id, filter "interactive" or viewport_only)' : ''}\n\n${r.tree || '(no visible elements)'}`);
  },
  async find(a) {
    const t = await resolveTab(a.tabId);
    const r = await callPage(t, '(M, a) => M.find(a)', { query: a.query, limit: a.limit });
    return text(r.length ? r.join('\n') : `No elements match "${a.query}". Try read_page.`);
  },
  async get_page_text(a) {
    const t = await resolveTab(a.tabId);
    const r = await callPage(t, '(M, a) => M.text(a)', { max_chars: a.max_chars });
    return text(`${r.title} — ${r.url}${r.truncated ? ' (truncated)' : ''}\n\n${r.text}`);
  },
  javascript,
  computer,
  async form_input(a) {
    const t = await resolveTab(a.tabId);
    return text(await callPage(t, '(M, a) => M.formInput(a)', { ref: a.ref, value: a.value }));
  },
  wait_for: waitFor,
  async read_console_messages(a) {
    const t = await resolveTab(a.tabId);
    const r = await callPage(t, '(M, a) => M.consoleRead(a)', { pattern: a.pattern, only_errors: a.only_errors, clear: a.clear, limit: a.limit });
    return text(`Capturing since ${r.capturing_since}. ${r.count} message(s).\n${r.messages.join('\n')}`);
  },
  async read_network_requests(a) {
    const t = await resolveTab(a.tabId);
    const r = await callPage(t, '(M, a) => M.networkRead(a)', { url_pattern: a.url_pattern, clear: a.clear, limit: a.limit });
    return text(`${r.count} request(s). Status shows "-" when Safari does not expose it.\n${r.requests.join('\n')}`);
  },
  async resize_window(a) {
    const t = await resolveTab(a.tabId);
    const cur = JSON.parse(await jxa({ op: 'bounds', w: t.w }));
    const b = JSON.parse(await jxa({ op: 'bounds', w: t.w, set: { x: cur.x, y: cur.y, width: a.width, height: a.height } }));
    return text(`Window ${t.w} is now ${b.width}x${b.height}`);
  },
};

// ---- JSON-RPC over stdio ----
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let queue = Promise.resolve();

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'safari', version: VERSION },
          instructions: INSTRUCTIONS,
        } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const h = HANDLERS[params?.name];
        if (!h) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const result = await h(params.arguments || {});
          return send({ jsonrpc: '2.0', id, result });
        } catch (e) {
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  // Tool calls run one at a time so Safari state stays consistent.
  if (msg.method === 'tools/call') queue = queue.then(() => handle(msg));
  else handle(msg);
});
rl.on('close', () => queue.then(() => process.exit(0)));
