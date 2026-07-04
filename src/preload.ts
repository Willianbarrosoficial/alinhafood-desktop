import { contextBridge } from 'electron';

/**
 * Superfície mínima exposta ao app web. As fases 2+ adicionam aqui o canal
 * de status offline/sync — nunca expor Node/Electron diretamente.
 */
contextBridge.exposeInMainWorld('alinhafoodDesktop', {
  version: process.env.npm_package_version ?? 'dev',
  runtime: 'desktop',
});
