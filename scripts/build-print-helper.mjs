import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Empacota o print agent (Service C#, headless) em resources/print-agent.
 * Publica via dotnet (cross-compile win-x64) a partir do repo irmão
 * "Alinhafood Print Agent" — o Desktop o gerencia como helper embutido.
 */

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ALINHAFOOD_AGENT_ROOT aponta para uma cópia LIMPA da main do agente (git
// worktree), como ALINHAFOOD_WEB_ROOT faz com o painel. A 0.6.0, a 0.6.1 e a
// 0.6.2 saíram com o 1.3.6 embutido enquanto as lojas já tinham o 1.16.1 — o
// Service embutido não se atualiza sozinho (só a bandeja do agente avulso faz
// isso), então a versão que entra aqui é a que a loja roda até o próximo .exe.
const agentRoot = process.env.ALINHAFOOD_AGENT_ROOT
  ? path.resolve(process.env.ALINHAFOOD_AGENT_ROOT)
  : path.resolve(desktopRoot, '..', 'Alinhafood Print Agent');
const publishDir = path.join(agentRoot, 'publish', 'service');
const exeName = 'Alinhafood Print Agent Service.exe';
const outDir = path.join(desktopRoot, 'resources', 'print-agent');

if (!fs.existsSync(agentRoot)) {
  console.error(`[print-helper] repo do agente não encontrado em ${agentRoot}`);
  process.exit(1);
}

const props = fs.readFileSync(path.join(agentRoot, 'Directory.Build.props'), 'utf8');
const agentVersion = props.match(/<Version>([^<]+)<\/Version>/)?.[1] ?? '?';
let agentCommit = '?';
try {
  agentCommit = execSync('git rev-parse --short HEAD', { cwd: agentRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {
  // Pasta sem git (cópia solta): segue, a versão do props já identifica.
}
console.log(`[print-helper] agente ${agentVersion} (${agentCommit}) em ${agentRoot}`);

const publish = process.argv.includes('--publish');
if (!publish && fs.existsSync(path.join(publishDir, exeName))) {
  console.warn('[print-helper] AVISO: reaproveitando publish/service sem recompilar — pode ser de outra versão.');
  console.warn('  Para o .exe que vai para as lojas, rode com --publish.');
}

if (!fs.existsSync(path.join(publishDir, exeName)) || publish) {
  console.log('[print-helper] publicando Service (dotnet, win-x64)...');
  const dotnetRoot = path.join(os.homedir(), '.dotnet');
  execSync(
    `dotnet publish src/AlinhafoodPrintAgent.Service -c Release -r win-x64 --self-contained ` +
      `-p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true ` +
      `-p:EnableCompressionInSingleFile=true -o publish/service --nologo -v quiet`,
    {
      cwd: agentRoot,
      stdio: 'inherit',
      env: { ...process.env, DOTNET_ROOT: dotnetRoot, PATH: `${dotnetRoot}:${process.env.PATH}` },
    },
  );
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(path.join(publishDir, exeName), path.join(outDir, exeName));

const size = (fs.statSync(path.join(outDir, exeName)).size / 1024 / 1024).toFixed(0);
console.log(`[print-helper] ${exeName} ${agentVersion} (${size}MB) → resources/print-agent`);
