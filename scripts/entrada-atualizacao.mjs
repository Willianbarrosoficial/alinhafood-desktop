import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prepara o lançamento de uma versão pelo R2 + painel, depois do `npm run dist`:
 *
 *   node scripts/entrada-atualizacao.mjs
 *
 * 1. Copia o instalador e o .blockmap para dist-installer/r2/desktop/vX.Y.Z/,
 *    já com o nome que vai ao ar (HÍFEN, não o espaço do nome local). Essa
 *    pasta é o que se envia ao bucket `alinhafood-downloads` do R2, na pasta
 *    `desktop/` — sai em https://download.alinhafood.com.br/desktop/vX.Y.Z/.
 * 2. Imprime a entrada de DESKTOP_RELEASES (Alinhafood 01/lib/server/
 *    desktop-releases.ts) com o sha512 e o tamanho EXATOS — um caractere errado
 *    à mão faz todos os PCs baixarem 190 MB e recusarem.
 *
 * Não rode outro build depois de gerar a entrada: cada build sai com outro
 * sha512. E nunca reenvie um arquivo com o mesmo nome ao R2 — o cache da
 * Cloudflare serve o velho; corrigiu, é versão nova.
 */

const BASE = 'https://download.alinhafood.com.br/desktop';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versao = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dir = path.join(root, 'dist-installer');
const exeLocal = path.join(dir, `Alinhafood Setup ${versao}.exe`);
const nome = `Alinhafood-Setup-${versao}.exe`;

function falha(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

for (const f of [exeLocal, `${exeLocal}.blockmap`, path.join(dir, 'latest.yml')]) {
  if (!fs.existsSync(f)) falha(`falta ${path.relative(root, f)} — rode o npm run dist da ${versao}`);
}

const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
if (yml.match(/^version:\s*(\S+)/m)?.[1] !== versao) falha('latest.yml é de outra versão — build trocado?');
const releaseDate = yml.match(/^releaseDate:\s*'?([^'\n]+)'?/m)?.[1];
if (!releaseDate) falha('latest.yml sem releaseDate');

const exe = fs.readFileSync(exeLocal);
const sha512 = crypto.createHash('sha512').update(exe).digest('base64');
if (sha512 !== yml.match(/^sha512:\s*(\S+)/m)?.[1]) falha('sha512 do .exe não bate com o latest.yml — build trocado?');

const saida = path.join(dir, 'r2', 'desktop', `v${versao}`);
fs.rmSync(saida, { recursive: true, force: true });
fs.mkdirSync(saida, { recursive: true });
fs.copyFileSync(exeLocal, path.join(saida, nome));
fs.copyFileSync(`${exeLocal}.blockmap`, path.join(saida, `${nome}.blockmap`));

console.log(`Arquivos para o R2 (bucket alinhafood-downloads, pasta desktop/v${versao}/):`);
console.log(`  ${path.relative(root, saida)}/${nome}  (${exe.length} bytes)`);
console.log(`  ${path.relative(root, saida)}/${nome}.blockmap`);
console.log(`Depois de enviar, abra ${BASE}/v${versao}/${nome} no navegador: tem que baixar.`);
console.log('');
console.log('Entrada para o topo de DESKTOP_RELEASES:');
console.log(`  {
    version: '${versao}',
    releaseDate: '${releaseDate}',
    file: {
      url: '${BASE}/v${versao}/${nome}',
      sha512: '${sha512}',
      size: ${exe.length},
    },
    // Primeira leva: uma ou duas lojas. Depois de conferir, troque por { stage: 'all' }.
    rollout: { stage: 'stores', restaurantIds: ['RESTAURANT_ID-DA-PRIMEIRA-LOJA'] },
  },`);
