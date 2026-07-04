// Avalia uma expressão JS na janela do Electron via CDP: node scripts/dev-eval.mjs '<expr>'
import { WebSocket } from 'undici';

const expr = process.argv[2] ?? 'document.location.href';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.log('nenhuma página');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
};
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id === 1) {
    console.log(JSON.stringify(msg.result?.result?.value ?? msg.result, null, 2));
    process.exit(0);
  }
};
setTimeout(() => process.exit(1), 10_000);
