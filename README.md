# Alinhafood Desktop

Aplicativo Windows (.exe) do Alinhafood. Roda o mesmo app web servido localmente,
com proxy para a nuvem — e, nas próximas fases, operação de salão offline com
sincronização automática.

## Arquitetura (Fase 1 — shell online)

```
Electron main
 ├─ Next standalone (build da Alinhafood 01)  → 127.0.0.1:3738
 ├─ Gateway                                    → 127.0.0.1:3737
 │    /api/*  → proxy para a nuvem (cookies reescritos p/ origem local)
 │    demais  → Next standalone (páginas, /_next, assets)
 └─ BrowserWindow → http://127.0.0.1:3737/login
```

Regra de segurança inviolável: **nenhuma chave privada** (SERVICE_ROLE,
JWT_SECRET) entra neste projeto — o build aborta se encontrar uma no
`.env.desktop`.

## Como buildar

1. `cp .env.desktop.example .env.desktop` e preencha (valores públicos do painel Coolify).
2. `npm install`
3. `npm run build:app` — roda `next build` na `../Alinhafood 01` (só leitura) e copia o standalone para `resources/app-server`.
4. `node scripts/build-print-helper.mjs --publish` — compila o Print Agent (repo irmão, .NET 8 win-x64) para `resources/print-agent`.
5. `npm run build:main` — main/preload do Electron + `dist/receipt-lib.js` (formatador de notinha bundlado da Alinhafood 01).
6. `npm run dev` — abre o app em modo desenvolvimento.
7. `npm run dist` — gera o instalador NSIS x64 em `dist-installer/` (cross-compila do Mac; depois rode
   `npx electron-rebuild -f -m .` para devolver o `better-sqlite3-multiple-ciphers` ao binário do Mac antes de outro `npm run dev`).

**Atualizar o Desktop depois de mudanças no painel** = repetir 3, 4 e 5 e gerar versão nova: o .exe embute um
build do painel, o agente de impressão e a notinha — nada disso acompanha o deploy da nuvem sozinho.

## Dados locais cifrados (desde a versão seguinte à 0.6.1)

`%APPDATA%/Alinhafood/store.db` é o espelho local de pedidos e clientes da loja. Um PC roubado
levava a base inteira em texto puro (auditoria LGPD 2026-09-04, item L-24). Agora o arquivo é
cifrado pelo driver `better-sqlite3-multiple-ciphers` (mesma API do `better-sqlite3`, é um
fork 1:1), com chave aleatória de 256 bits guardada em `store.key`, protegida pelo
`safeStorage` do Electron (DPAPI no Windows) — ver `src/data/db-key.ts`.

- **Primeiro boot com a versão nova:** um `store.db` antigo em texto puro é cifrado **no lugar**
  (`PRAGMA rekey`), sem cópia intermediária. Se a cifra falhar, o app segue com o arquivo como
  está, registra `db_encryption = failed:…` em `local_meta` e avisa no log — operação da loja
  primeiro, cifra depois.
- **Backups** (`userData/backups/*.db`) saem cifrados com a mesma chave. Sem o `store.key` do
  mesmo PC, não abrem. A nuvem continua sendo o backup de verdade.
- **Perder o `store.key`** (perfil do Windows recriado, por exemplo) perde o espelho local; o
  app recria o banco vazio no boot e sincroniza da nuvem de novo.
- ⚠️ **Ainda não testado em Windows real** — a 0.6.1 também não foi. Antes de publicar: instalar
  sobre uma 0.6.1 com dados, conferir que `store.db` não abre no DB Browser sem chave, criar
  pedido offline, reiniciar, conferir que o pedido continua lá.

## Publicação / auto-update

`electron-builder.yml` publica em GitHub Releases (`Willianbarrosoficial/alinhafood-desktop`).
O app checa atualização no boot e a cada 6h (electron-updater). Para publicar:
`GH_TOKEN=<token> npx electron-builder --win nsis --publish always`.

## Pendências conhecidas

- Ícone `.ico` (usando o padrão do Electron por enquanto).
- Code signing (SmartScreen avisa "editor desconhecido" — fast-follow).
- Fases 2-4: SQLite local, sync engine, LAN/KDS, impressão offline — ver plano.
