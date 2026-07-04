// Lista cookies (inclui HttpOnly) da janela do Electron via CDP
import { WebSocket } from 'undici';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getAllCookies' }));
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id === 1) {
    for (const c of msg.result.cookies) {
      console.log(
        `${c.name} | domain=${c.domain} | path=${c.path} | httpOnly=${c.httpOnly} | secure=${c.secure} | sameSite=${c.sameSite ?? '-'} | len=${c.value.length}`,
      );
    }
    process.exit(0);
  }
};
setTimeout(() => process.exit(1), 10_000);
