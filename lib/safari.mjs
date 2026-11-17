// Bridge between Node and Safari: JXA (osascript) and screencapture.
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_LIB = await readFile(join(HERE, 'page.js'), 'utf8');

function run(cmd, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        if (err.killed) return reject(new Error(`${cmd} timed out after ${timeout}ms. A page dialog or a busy page may be blocking Safari.`));
        return reject(new Error(explain(msg)));
      }
      resolve(stdout.replace(/\n$/, ''));
    });
  });
}

function explain(msg) {
  if (/Allow JavaScript from Apple Events/i.test(msg))
    return 'Safari blocks scripted JavaScript. Enable it: Safari > Settings > Advanced > "Show features for web developers", then Develop menu > "Allow JavaScript from Apple Events".';
  if (/-1743|Not authorized to send Apple events/i.test(msg))
    return 'macOS denied Automation access to Safari. Open System Settings > Privacy & Security > Automation and allow your terminal app to control Safari.';
  if (/-25211|assistive access|not allowed to send keystrokes/i.test(msg))
    return 'Native input needs Accessibility permission. Open System Settings > Privacy & Security > Accessibility and enable your terminal app.';
  if (/could not create image from window/i.test(msg))
    return 'Screenshot failed. Grant Screen Recording permission to your terminal app (System Settings > Privacy & Security > Screen & System Audio Recording), and make sure the Safari window is not minimized.';
  return msg.replace(/^execution error: /, '').replace(/^Error: /, '');
}

// One JXA program handles every Safari operation. Request arrives as JSON in argv[0].
const JXA = String.raw`
function run(argv) {
  const req = JSON.parse(argv[0]);
  const S = Application('Safari');
  const docWindows = () => S.windows().filter(w => { try { return w.tabs.length > 0; } catch (e) { return false; } });
  const win = (id) => { const w = S.windows.byId(id); w.id(); return w; };
  const tab = (t) => {
    const w = win(t.w);
    const n = w.tabs.length;
    if (t.i < 1 || t.i > n) throw new Error('Tab ' + t.w + ':' + t.i + ' does not exist (window has ' + n + ' tabs). Call tabs_context.');
    return w.tabs[t.i - 1];
  };
  const front = () => {
    const ws = docWindows();
    if (!ws.length) throw new Error('No Safari window is open. Call tabs_create.');
    const w = ws[0];
    return { w: w.id(), i: w.currentTab.index() };
  };
  const js = (t, code) => S.doJavaScript(code, { in: tab(t) });
  switch (req.op) {
    case 'list': {
      return JSON.stringify(docWindows().map(w => {
        const cur = w.currentTab.index();
        return { windowId: w.id(), bounds: w.bounds(), tabs: w.tabs().map(t => ({ index: t.index(), title: t.name(), url: t.url(), active: t.index() === cur })) };
      }));
    }
    case 'front': return JSON.stringify(front());
    case 'create': {
      let ws = docWindows();
      let w;
      if (req.newWindow || !ws.length) {
        S.Document().make();
        delay(0.3);
        w = docWindows()[0];
        if (req.url) w.currentTab.url = req.url;
      } else {
        w = req.w ? win(req.w) : ws[0];
        const t = S.Tab({ url: req.url || 'about:blank' });
        w.tabs.push(t);
        w.currentTab = w.tabs[w.tabs.length - 1];
      }
      return JSON.stringify({ w: w.id(), i: w.currentTab.index() });
    }
    case 'close': { tab(req.t).close(); return 'ok'; }
    case 'select': {
      const w = win(req.t.w);
      w.currentTab = tab(req.t);
      if (req.activate) { S.activate(); w.index = 1; delay(0.15); }
      return 'ok';
    }
    case 'info': {
      const w = win(req.t.w); const t = tab(req.t);
      return JSON.stringify({ url: t.url(), title: t.name(), current: w.currentTab.index() === req.t.i, bounds: w.bounds(), windowId: w.id(), miniaturized: w.miniaturized() });
    }
    case 'seturl': { tab(req.t).url = req.url; return 'ok'; }
    case 'bounds': {
      const w = win(req.w);
      if (req.set) w.bounds = req.set;
      return JSON.stringify(w.bounds());
    }
    case 'js': return js(req.t, req.code);
    case 'exec': {
      // Run async code in the page, then poll for its settled result.
      const id = 'r' + Date.now() + Math.floor(Math.random() * 1e6);
      js(req.t, 'window.__mcpRes = window.__mcpRes || {}; window.__mcpRes["' + id + '"] = null; (async () => {' + req.code + '\n})().then(v => { window.__mcpRes["' + id + '"] = { ok: true, v: v === undefined ? null : v }; }, e => { window.__mcpRes["' + id + '"] = { ok: false, e: String((e && e.message) || e) }; }); "started"');
      const poll = '(function(){ if (!window.__mcpRes || !("' + id + '" in window.__mcpRes)) return JSON.stringify({ ok: true, v: null, navigated: true }); var r = window.__mcpRes["' + id + '"]; if (!r) return ""; delete window.__mcpRes["' + id + '"]; try { return JSON.stringify(r); } catch (e) { return JSON.stringify({ ok: true, v: String(r.v) }); } })()';
      const end = Date.now() + (req.timeout || 30000);
      let wait = 0.02;
      while (Date.now() < end) {
        let r;
        try { r = js(req.t, poll); } catch (e) { r = ''; }
        if (r) return r;
        delay(wait);
        wait = Math.min(wait * 1.5, 0.25);
      }
      return JSON.stringify({ ok: false, e: 'Timed out after ' + (req.timeout || 30000) + 'ms waiting for page script' });
    }
    case 'nativeMouse': {
      // macOS drops synthetic mouse events silently without Accessibility trust, so fail loudly.
      ObjC.import('ApplicationServices');
      if (!$.AXIsProcessTrusted()) throw new Error('not allowed to send keystrokes: assistive access required');
      ObjC.import('CoreGraphics');
      const p = $.CGPointMake(req.x, req.y);
      const post = (type, btn, clicks) => {
        const e = $.CGEventCreateMouseEvent($(), type, p, btn);
        if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
        $.CGEventPost(0, e);
      };
      post(5, 0, 0); delay(0.03);
      if (req.kind === 'move') return 'ok';
      const right = req.button === 'right';
      for (let c = 1; c <= (req.count || 1); c++) {
        post(right ? 3 : 1, right ? 1 : 0, c);
        post(right ? 4 : 2, right ? 1 : 0, c);
        delay(0.03);
      }
      return 'ok';
    }
    case 'nativeKeys': {
      const se = Application('System Events');
      const codes = { enter: 36, return: 36, tab: 48, space: 49, backspace: 51, delete: 117, escape: 53, esc: 53, left: 123, arrowleft: 123, right: 124, arrowright: 124, down: 125, arrowdown: 125, up: 126, arrowup: 126, home: 115, end: 119, pageup: 116, pagedown: 121 };
      const modMap = { cmd: 'command down', command: 'command down', meta: 'command down', ctrl: 'control down', control: 'control down', shift: 'shift down', alt: 'option down', option: 'option down' };
      if (req.text != null) { se.keystroke(req.text); return 'ok'; }
      for (let r = 0; r < (req.repeat || 1); r++) for (const combo of req.keys) {
        const parts = combo.split('+'); const k = parts.pop();
        const using = parts.map(m => modMap[m.toLowerCase()]).filter(Boolean);
        const code = codes[k.toLowerCase()];
        if (code != null) se.keyCode(code, { using }); else se.keystroke(k.length === 1 ? k.toLowerCase() : k, { using });
        delay(0.02);
      }
      return 'ok';
    }
  }
  throw new Error('unknown op ' + req.op);
}`;

export async function jxa(req, timeout) {
  return run('osascript', ['-l', 'JavaScript', '-e', JXA, JSON.stringify(req)], { timeout: timeout || 60000 });
}

export const parseTab = (id) => {
  const m = /^(\d+):(\d+)$/.exec(String(id || '').trim());
  if (!m) throw new Error(`Invalid tabId "${id}". Use the "windowId:tabIndex" form from tabs_context.`);
  return { w: +m[1], i: +m[2] };
};
export const tabKey = (t) => `${t.w}:${t.i}`;

export async function resolveTab(tabId) {
  if (tabId) return parseTab(tabId);
  return JSON.parse(await jxa({ op: 'front' }));
}

// Run a function with the helper library available as M. fnSource: "(M, args) => {...}".
export async function callPage(t, fnSource, args = {}, timeout = 30000) {
  const code = `${PAGE_LIB};\nreturn await (${fnSource})(window.__mcp, ${JSON.stringify(args)});`;
  return execCode(t, code, timeout);
}

// Run raw async-function-body code in the page (library installed first).
export async function execCode(t, code, timeout = 30000) {
  const full = code.startsWith(PAGE_LIB) ? code : `${PAGE_LIB};\n${code}`;
  const out = await jxa({ op: 'exec', t, code: full, timeout }, timeout + 10000);
  const r = JSON.parse(out);
  if (!r.ok) throw new Error(r.e);
  if (r.navigated) return { navigated: true };
  return r.v;
}

export async function installLib(t) {
  try { await execCode(t, 'return true', 5000); } catch (e) { /* page may be mid-load */ }
}

export async function waitForLoad(t, { timeout = 20000, prevUrl } = {}) {
  const end = Date.now() + timeout;
  await new Promise((r) => setTimeout(r, 150));
  while (Date.now() < end) {
    try {
      const s = JSON.parse(await jxa({ op: 'js', t, code: 'JSON.stringify({rs: document.readyState, url: location.href, marker: !!window.__mcpNavMarker})' }, 10000));
      if (s.rs === 'complete' && (!s.marker || (prevUrl && s.url !== prevUrl))) return true;
    } catch (e) { /* tab is between documents */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function markForNav(t) {
  try {
    const s = await jxa({ op: 'js', t, code: 'window.__mcpNavMarker = true; location.href' }, 10000);
    return s;
  } catch (e) { return null; }
}

// Crop a window capture to the page viewport and scale it, using AppKit (sips cannot crop at an offset).
// argv: src dst windowWidthPts topPts viewportWPts viewportHPts outW outH
const CROP_JXA = String.raw`
ObjC.import('AppKit');
function run(argv) {
  const [src, dst] = argv;
  const [winW, top, vw, vh, ow, oh] = argv.slice(2).map(Number);
  const rep = $.NSBitmapImageRep.imageRepWithContentsOfFile(src);
  const k = rep.pixelsWide / winW;
  const h = Math.min(Math.round(vh * k), rep.pixelsHigh - Math.round(top * k));
  const sub = $.CGImageCreateWithImageInRect(rep.CGImage, $.CGRectMake(0, Math.round(top * k), Math.round(vw * k), h));
  const out = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, ow, oh, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  const g = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(out);
  $.CGContextSetInterpolationQuality(g.CGContext, 3);
  $.CGContextDrawImage(g.CGContext, $.CGRectMake(0, 0, ow, oh), sub);
  out.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({ NSImageCompressionFactor: 0.75 })).writeToFileAtomically(dst, true);
  return 'ok';
}`;

const shotScale = new Map(); // tabKey -> CSS px per screenshot px

export const toCss = (t, [x, y]) => {
  const s = shotScale.get(tabKey(t)) || 1;
  return [Math.round(x * s), Math.round(y * s)];
};

// Screenshot of the page viewport. Coordinates in the image map to CSS pixels (scaled if large).
export async function screenshot(t, { maxWidth = 1400 } = {}) {
  await jxa({ op: 'select', t });
  const info = JSON.parse(await jxa({ op: 'info', t }));
  if (info.miniaturized) throw new Error('Safari window is minimized; un-minimize it to take a screenshot.');
  let vp = null;
  try {
    vp = await callPage(t, '() => ({ iw: innerWidth, ih: innerHeight })', {}, 8000);
  } catch (e) { /* JS blocked: fall back to whole window */ }
  const b = info.bounds;
  const dir = await mkdtemp(join(tmpdir(), 'safari-mcp-'));
  try {
    const png = join(dir, 'w.png');
    const jpg = join(dir, 's.jpg');
    await run('screencapture', ['-x', '-o', '-l', String(info.windowId), png]);
    let cropTop = 0, cssW = b.width, cssH = b.height;
    if (vp && vp.iw && vp.ih) { cropTop = Math.max(0, b.height - vp.ih); cssW = vp.iw; cssH = vp.ih; }
    let outW = cssW, outH = cssH;
    if (outW > maxWidth) { outH = Math.round(outH * (maxWidth / outW)); outW = maxWidth; }
    await run('osascript', ['-l', 'JavaScript', '-e', CROP_JXA, png, jpg, b.width, cropTop, cssW, cssH, outW, outH].map(String));
    shotScale.set(tabKey(t), cssW / outW);
    const data = (await readFile(jpg)).toString('base64');
    return { data, width: outW, height: outH, viewportOnly: !!vp, url: info.url, title: info.title };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Screen position (points) of a CSS viewport coordinate, for native CGEvent input.
export async function screenPoint(t, [x, y]) {
  const info = JSON.parse(await jxa({ op: 'info', t }));
  const vp = await callPage(t, '() => ({ ih: innerHeight })', {}, 8000);
  const b = info.bounds;
  return { x: b.x + x, y: b.y + (b.height - vp.ih) + y };
}
