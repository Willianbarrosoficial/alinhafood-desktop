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
4. `npm run dev` — abre o app em modo desenvolvimento.
5. `npm run dist` — gera o instalador NSIS em `dist-installer/` (rodar num Windows ou CI Windows).

## Publicação / auto-update

`electron-builder.yml` publica em GitHub Releases (`musemkt2024-cmd/alinhafood-desktop`).
O app checa atualização no boot e a cada 6h (electron-updater). Para publicar:
`GH_TOKEN=<token> npx electron-builder --win nsis --publish always`.

## Pendências conhecidas

- Ícone `.ico` (usando o padrão do Electron por enquanto).
- Code signing (SmartScreen avisa "editor desconhecido" — fast-follow).
- Fases 2-4: SQLite local, sync engine, LAN/KDS, impressão offline — ver plano.
