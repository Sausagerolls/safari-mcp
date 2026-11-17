// End-to-end smoke test: spawns the server and drives the fixture page.
// Usage: node test/smoke.mjs <fixture-url>
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const url = process.argv[2];
const srv = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 1;
createInterface({ input: srv.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
let tab;
async function call(name, args = {}) {
  if (tab && !('tabId' in args) && name !== 'tabs_context' && name !== 'tabs_create') args.tabId = tab;
  const r = await rpc('tools/call', { name, arguments: args });
  const parts = r.result.content.map((c) => {
    if (c.type === 'image') { writeFileSync(process.env.SHOT || '/dev/null', Buffer.from(c.data, 'base64')); return `[image ${c.data.length} b64 chars]`; }
    return c.text;
  });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.result.isError ? ' ERROR' : ''}\n${parts.join('\n').slice(0, 1500)}`);
  return parts.join('\n');
}
await rpc('initialize', { protocolVersion: '2025-06-18' });
const created = await call('tabs_create', { url });
tab = /Created tab (\d+:\d+)/.exec(created)[1];
await call('read_page', { filter: 'interactive' });
const found = await call('find', { query: 'name' });
const nameRef = /textbox "Name" \[(ref_\d+)\]/.exec(found)?.[1];
await call('computer', { action: 'left_click', ref: nameRef });
await call('computer', { action: 'type', text: 'Ada' });
const sel = /combobox[^\[]*\[(ref_\d+)\]/.exec(await call('read_page', { filter: 'interactive' }))[1];
await call('form_input', { ref: sel, value: 'Green' });
await call('computer', { action: 'left_click', ref: nameRef });
await call('computer', { action: 'key', text: 'Enter' });
await call('javascript', { code: "document.getElementById('out').textContent" });
await call('javascript', { code: "({sel: document.getElementById('color').value, n: window.n})" });
await call('javascript', { code: "await new Promise(r=>setTimeout(r,200)); return 6*7" });
const cnt = /button "Click me" \[(ref_\d+)\]/.exec(await call('find', { query: 'click me' }))[1];
await call('computer', { action: 'left_click', ref: cnt });
await call('computer', { action: 'double_click', ref: cnt });
const danger = /button "Danger" \[(ref_\d+)\]/.exec(await call('find', { query: 'danger' }))[1];
await call('computer', { action: 'left_click', ref: danger });
await call('javascript', { code: "document.getElementById('out').textContent" });
await call('computer', { action: 'scroll', coordinate: [100, 100], scroll_direction: 'down', scroll_amount: 2 });
await call('computer', { action: 'screenshot' });
await call('read_console_messages', {});
await call('read_network_requests', {});
await call('get_page_text', {});
await call('wait_for', { selector: '#out', timeout_ms: 2000 });
await call('navigate', { url: 'reload' });
await call('javascript', { code: 'window.n' });
await call('tabs_context');
await call('tabs_close', { tabId: tab });
srv.stdin.end();
