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
const agentRoot = path.resolve(desktopRoot, '..', 'Alinhafood Print Agent');
const publishDir = path.join(agentRoot, 'publish', 'service');
const exeName = 'Alinhafood Print Agent Service.exe';
const outDir = path.join(desktopRoot, 'resources', 'print-agent');

if (!fs.existsSync(agentRoot)) {
  console.error(`[print-helper] repo do agente não encontrado em ${agentRoot}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(publishDir, exeName)) || process.argv.includes('--publish')) {
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
console.log(`[print-helper] ${exeName} (${size}MB) → resources/print-agent`);
