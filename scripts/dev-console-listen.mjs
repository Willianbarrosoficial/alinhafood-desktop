// Escuta console + exceções + falhas de rede da janela do Electron via CDP
import { WebSocket } from 'undici';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.log('nenhuma página encontrada');
  process.exit(1);
}
console.log('conectado em:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));

ws.onopen = () => {
  send('Runtime.enable');
  send('Log.enable');
  send('Network.enable');
  send('Page.enable');
};

const fmt = (args) =>
  args
    .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview.properties?.map((p) => `${p.name}:${p.value}`)) : a.type))
    .join(' ');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const m = msg.method;
  if (m === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    console.log(`[console.${msg.params.type}]`, fmt(msg.params.args).slice(0, 500));
  }
  if (m === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('[EXCEPTION]', d.text, d.exception?.description?.slice(0, 600) ?? '');
  }
  if (m === 'Network.responseReceived' && msg.params.response.status >= 400) {
    console.log(`[http ${msg.params.response.status}]`, msg.params.response.url.slice(0, 140));
  }
  if (m === 'Network.loadingFailed' && !msg.params.canceled) {
    console.log('[net FAIL]', msg.params.errorText, msg.params.requestId);
  }
  if (m === 'Page.frameNavigated' && !msg.params.frame.parentId) {
    console.log('[navegou]', msg.params.frame.url);
  }
};

setTimeout(() => {
  console.log('--- fim da escuta (90s) ---');
  process.exit(0);
}, 90_000);
