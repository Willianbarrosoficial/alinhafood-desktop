import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Publica o instalador de dist-installer/ como release do GitHub, em dois passos:
 *
 *   node scripts/publicar-release.mjs            → cria o release como RASCUNHO e
 *                                                  sobe os 3 arquivos. Ninguém vê.
 *   node scripts/publicar-release.mjs --publicar → tira o rascunho do ar: a partir
 *                                                  daí o auto-update de TODOS os PCs
 *                                                  instalados oferece a versão, e o
 *                                                  link /api/desktop/baixar do painel
 *                                                  passa a entregar ela.
 *
 * O segundo passo é o lançamento de fato — só com o "pode" do dono.
 *
 * Antes de subir, confere que o latest.yml fala da mesma versão do package.json
 * e que o sha512 dele bate com o .exe: um latest.yml de outro build faria os PCs
 * baixarem um arquivo que o electron-updater recusa (e ficarem sem atualizar).
 *
 * ⚠️ ARMADILHA: o arquivo sobe com HÍFEN (Alinhafood-Setup-X.Y.Z.exe), não com o
 * espaço do nome local. É o nome que o latest.yml cita e o que o link do painel
 * monta; subir com espaço deixa o auto-update e o download em 404.
 *
 * Token: GH_TOKEN do .env.desktop (nunca impresso).
 */

const OWNER = 'Willianbarrosoficial';
const REPO = 'alinhafood-desktop';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versao = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${versao}`;
const dir = path.join(root, 'dist-installer');
const exeLocal = path.join(dir, `Alinhafood Setup ${versao}.exe`);
const nomeExe = `Alinhafood-Setup-${versao}.exe`;
const arquivos = [
  { local: exeLocal, nome: nomeExe, tipo: 'application/octet-stream' },
  { local: `${exeLocal}.blockmap`, nome: `${nomeExe}.blockmap`, tipo: 'application/octet-stream' },
  { local: path.join(dir, 'latest.yml'), nome: 'latest.yml', tipo: 'text/yaml' },
];

function commitDoBuild() {
  return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
}

function token() {
  const env = fs.readFileSync(path.join(root, '.env.desktop'), 'utf8');
  const t = env.match(/^GH_TOKEN=(.+)$/m)?.[1]?.trim();
  if (!t) throw new Error('GH_TOKEN ausente no .env.desktop');
  return t;
}

async function gh(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', ...init.headers },
  });
  const corpo = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status}: ${JSON.stringify(corpo).slice(0, 300)}`);
  return corpo;
}

function conferirPacote() {
  for (const a of arquivos) {
    if (!fs.existsSync(a.local)) throw new Error(`falta ${path.relative(root, a.local)} — rode o npm run dist`);
  }
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  const ymlVersao = yml.match(/^version:\s*(\S+)/m)?.[1];
  const ymlPath = yml.match(/^path:\s*(\S+)/m)?.[1];
  const ymlSha = yml.match(/^sha512:\s*(\S+)/m)?.[1];
  if (ymlVersao !== versao) throw new Error(`latest.yml é da ${ymlVersao}, package.json é da ${versao}`);
  if (ymlPath !== nomeExe) throw new Error(`latest.yml cita ${ymlPath}, esperado ${nomeExe}`);
  const sha = crypto.createHash('sha512').update(fs.readFileSync(exeLocal)).digest('base64');
  if (sha !== ymlSha) throw new Error('sha512 do .exe não bate com o latest.yml — build trocado?');
  console.log(`[release] pacote ${versao} conferido (${(fs.statSync(exeLocal).size / 1e6).toFixed(1)} MB, sha512 bate)`);
}

async function releaseDaTag() {
  const lista = await gh(`${API}/releases?per_page=30`);
  // ⚠️ ARMADILHA: um PATCH num rascunho sem `tag_name` (ex.: só trocar o
  // target_commitish) faz o GitHub esquecer a tag — ela vira "untagged-…" e só
  // o nome continua v0.8.0. Por isso procura também pelo nome, e o --publicar
  // regrava a tag.
  return lista.find((r) => r.tag_name === tag) ?? lista.find((r) => r.draft && r.name === tag) ?? null;
}

async function rascunho() {
  conferirPacote();
  let rel = await releaseDaTag();
  if (rel && !rel.draft) throw new Error(`${tag} já está publicado — nada a fazer`);
  if (!rel) {
    rel = await gh(`${API}/releases`, {
      method: 'POST',
      // O commit do build, não 'main': a versão nasce numa branch release/X.Y.Z
      // que só entra na main depois, e a tag sairia sem o código do .exe.
      body: JSON.stringify({ tag_name: tag, target_commitish: commitDoBuild(), name: tag, draft: true, body: `Alinhafood Desktop ${versao}` }),
    });
    console.log(`[release] rascunho ${tag} criado (id ${rel.id})`);
  }
  for (const a of arquivos) {
    const antigo = rel.assets.find((x) => x.name === a.nome);
    if (antigo) await gh(`${API}/releases/assets/${antigo.id}`, { method: 'DELETE' });
    const dados = fs.readFileSync(a.local);
    const up = await gh(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(a.nome)}`, {
      method: 'POST',
      headers: { 'Content-Type': a.tipo, 'Content-Length': String(dados.length) },
      body: dados,
    });
    console.log(`[release] ${up.name} enviado (${up.size} bytes)`);
  }
  console.log(`[release] rascunho pronto: ${rel.html_url}`);
  console.log('[release] para lançar: node scripts/publicar-release.mjs --publicar');
}

async function publicar() {
  conferirPacote();
  const rel = await releaseDaTag();
  if (!rel) throw new Error(`não há rascunho ${tag} — rode sem --publicar primeiro`);
  if (!rel.draft) throw new Error(`${tag} já está publicado`);
  const faltando = arquivos.filter((a) => !rel.assets.some((x) => x.name === a.nome && x.state === 'uploaded'));
  if (faltando.length) throw new Error(`rascunho sem ${faltando.map((a) => a.nome).join(', ')}`);
  const publicado = await gh(`${API}/releases/${rel.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ tag_name: tag, target_commitish: rel.target_commitish, draft: false, make_latest: 'true' }),
  });
  if (publicado.tag_name !== tag) throw new Error(`publicado com a tag ${publicado.tag_name}, esperado ${tag} — conferir no GitHub`);
  const feed = await fetch(`https://github.com/${OWNER}/${REPO}/releases/latest/download/latest.yml`).then((r) => r.text());
  console.log(`[release] ${tag} publicado. Feed do auto-update agora diz: ${feed.match(/^version:.*$/m)?.[0]}`);
}

(process.argv.includes('--publicar') ? publicar() : rascunho()).catch((err) => {
  console.error(`[release] ERRO: ${err.message}`);
  process.exit(1);
});
