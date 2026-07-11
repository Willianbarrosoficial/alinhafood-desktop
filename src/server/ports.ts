import net from 'node:net';

/**
 * Acha uma porta REALMENTE bindável em 127.0.0.1.
 *
 * No Windows, Hyper-V/WSL/Docker reservam faixas de portas aleatórias a cada
 * boot; se a porta cair numa faixa reservada, o `listen` falha com
 * "UNKNOWN errno -4094" (visto em campo). Testar o bind antes de usar elimina
 * o problema — tentamos as portas preferidas e caímos numa aleatória livre.
 */

function tryBind(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Retorna a primeira porta bindável entre as preferidas; se nenhuma servir,
 * usa uma porta efêmera livre atribuída pelo SO (port 0).
 */
export async function findBindablePort(preferred: number[], host = '127.0.0.1'): Promise<number> {
  for (const port of preferred) {
    const ok = await tryBind(port, host);
    if (ok) return ok;
  }
  const ephemeral = await tryBind(0, host);
  if (ephemeral) return ephemeral;
  // Último recurso: devolve a primeira preferida (o erro aparecerá no boot com log)
  return preferred[0] ?? 3738;
}
