import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resourcesDir } from '../config';
import { readMirrorTable } from '../data/db';

/**
 * Print agent embutido (v0.3.0) — o lojista instala UM instalador só.
 *
 * O Desktop empacota o Service do Alinhafood Print Agent (C#, headless) em
 * resources/print-agent e o gerencia como helper:
 *  - config (agent.json) escrita AQUI, com o token injetado do espelho local
 *    (adeus copiar/colar token) e a impressora escolhida dentro do Alinhafood;
 *  - ALINHAFOOD_AGENT_DATA_DIR isola config/logs numa pasta própria do Desktop
 *    (não conflita com uma instalação standalone do agente);
 *  - sobe junto do app, reinicia se cair (backoff), morre junto no quit.
 *
 * Windows-only (o motor usa winspool.drv). No Mac/dev, tudo é no-op exceto a
 * escrita de config — que dá pra testar.
 */

const HELPER_EXE = 'Alinhafood Print Agent Service.exe';
const MAX_RESTARTS = 5;

interface HelperConfigInput {
  printerName?: string;
  paperWidth?: number;
}

interface AgentJson {
  agentToken: string;
  printerName: string;
  paperWidth: number;
  mode: 'Spooler';
  autoStart: boolean;
  setupCompleted: boolean;
}

let child: ChildProcess | null = null;
let restarts = 0;
let lastExitCode: number | null = null;

function dataDir(): string {
  const dir = path.join(app.getPath('userData'), 'print-agent');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath(): string {
  return path.join(dataDir(), 'agent.json');
}

function helperExePath(): string {
  return path.join(resourcesDir(), 'print-agent', HELPER_EXE);
}

function mirrorAgentToken(): string | null {
  const s = readMirrorTable<{ print_agent_token?: string }>('store_settings')[0];
  const token = s?.print_agent_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function readHelperConfig(): AgentJson | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as AgentJson;
  } catch {
    return null;
  }
}

/** Escreve/atualiza o agent.json. Token SEMPRE re-injetado do espelho. */
export function writeHelperConfig(input: HelperConfigInput): { ok: boolean; error?: string } {
  const token = mirrorAgentToken();
  if (!token) {
    return {
      ok: false,
      error: 'Token de impressão ainda não sincronizado — abra o app com internet uma vez.',
    };
  }
  const previous = readHelperConfig();
  const next: AgentJson = {
    agentToken: token,
    printerName: input.printerName ?? previous?.printerName ?? '',
    paperWidth: input.paperWidth ?? previous?.paperWidth ?? 80,
    mode: 'Spooler',
    autoStart: true,
    setupCompleted: true,
  };
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return { ok: true };
}

export interface HelperStatus {
  supported: boolean;
  exeAvailable: boolean;
  running: boolean;
  printerName: string | null;
  paperWidth: number | null;
  hasToken: boolean;
  lastExitCode: number | null;
}

export function helperStatus(): HelperStatus {
  const cfg = readHelperConfig();
  return {
    supported: process.platform === 'win32',
    exeAvailable: fs.existsSync(helperExePath()),
    running: child !== null && child.exitCode === null,
    printerName: cfg?.printerName || null,
    paperWidth: cfg?.paperWidth ?? null,
    hasToken: mirrorAgentToken() !== null,
    lastExitCode,
  };
}

export function startHelper(): void {
  if (process.platform !== 'win32') return;
  if (child && child.exitCode === null) return;
  const exe = helperExePath();
  if (!fs.existsSync(exe)) {
    console.error('[print-helper] executável não encontrado:', exe);
    return;
  }
  const cfg = readHelperConfig();
  if (!cfg?.agentToken || !cfg.printerName) {
    console.log('[print-helper] aguardando configuração (token/impressora)');
    return;
  }

  child = spawn(exe, [], {
    env: { ...process.env, ALINHAFOOD_AGENT_DATA_DIR: dataDir() },
    windowsHide: true,
    stdio: 'pipe',
  });
  console.log(`[print-helper] iniciado (pid ${child.pid}, impressora "${cfg.printerName}")`);

  child.stdout?.on('data', (d: Buffer) => console.log(`[print-helper] ${String(d).trimEnd()}`));
  child.stderr?.on('data', (d: Buffer) => console.error(`[print-helper] ${String(d).trimEnd()}`));
  child.on('exit', (code) => {
    lastExitCode = code;
    child = null;
    if (code !== 0 && restarts < MAX_RESTARTS) {
      restarts += 1;
      const delay = Math.min(30_000, 2_000 * restarts);
      console.error(`[print-helper] caiu (código ${code}) — reiniciando em ${delay / 1000}s`);
      setTimeout(startHelper, delay);
    }
  });
}

export function stopHelper(): void {
  if (child && child.exitCode === null) child.kill();
  child = null;
}

/** Aplica config nova e (re)inicia o helper. */
export function configureHelper(input: HelperConfigInput): { ok: boolean; error?: string } {
  const result = writeHelperConfig(input);
  if (!result.ok) return result;
  restarts = 0;
  stopHelper();
  startHelper();
  return { ok: true };
}
