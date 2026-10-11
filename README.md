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
   `npx electron-rebuild -f -m .` para devolver o `better-sqlite3` ao binário do Mac antes de outro `npm run dev`).

**Atualizar o Desktop depois de mudanças no painel** = repetir 3, 4 e 5 e gerar versão nova: o .exe embute um
build do painel, o agente de impressão e a notinha — nada disso acompanha o deploy da nuvem sozinho.
O agente embutido também não: só a bandeja do agente avulso se atualiza sozinha, o Service que vai
dentro do .exe fica na versão com que foi empacotado.

### Build de versão para as lojas — sempre de cópia limpa

As pastas irmãs costumam ter trabalho de outras sessões por cima (e a do agente, um `publish/` antigo).
Para o .exe que vai para as lojas, monte painel, notinha e agente a partir da `main` de cada repo:

```bash
git -C "../Alinhafood 01" fetch origin main
git -C "../Alinhafood 01" worktree add --detach /tmp/af-web origin/main
(cd /tmp/af-web && npm ci)
git -C "../Alinhafood Print Agent" fetch origin main
git -C "../Alinhafood Print Agent" worktree add --detach /tmp/af-agent origin/main

export ALINHAFOOD_WEB_ROOT=/tmp/af-web ALINHAFOOD_AGENT_ROOT=/tmp/af-agent
npm run build:app
node scripts/build-print-helper.mjs --publish   # imprime a versão do agente que entrou
npm run build:main
npm run dist
```

Anote no commit da versão o commit do painel e a versão do agente embutidos — é o que diz, depois,
o que a loja está rodando. Ao terminar: `git worktree remove /tmp/af-web` e `/tmp/af-agent`.

## Publicação / auto-update

`electron-builder.yml` publica em GitHub Releases (`Willianbarrosoficial/alinhafood-desktop`).
O app checa atualização no boot e a cada 6h (electron-updater). Para publicar:
`GH_TOKEN=<token> npx electron-builder --win nsis --publish always`.

## Pendências conhecidas

- Ícone `.ico` (usando o padrão do Electron por enquanto).
- Code signing (SmartScreen avisa "editor desconhecido" — fast-follow).
- Fases 2-4: SQLite local, sync engine, LAN/KDS, impressão offline — ver plano.
