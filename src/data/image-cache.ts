import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';
import { readMirrorTable } from './db';

/**
 * Cache local das imagens do cardápio (Fase 3 — 1 PC).
 *
 * Durante o sync (online) as imagens dos produtos/loja são baixadas para
 * %APPDATA%/Alinhafood/images. Offline, o gateway serve daqui, então o
 * cardápio aparece com fotos mesmo sem internet. URLs do Supabase Storage são
 * públicas — baixar não expõe nada.
 */

function imagesDir(): string {
  const dir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function keyFor(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[
      ext
    ] ?? 'application/octet-stream'
  );
}

function cachedPath(url: string): string | null {
  const base = path.join(imagesDir(), keyFor(url));
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.bin']) {
    const p = base + ext;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function download(url: string): Promise<string | null> {
  try {
    const res = await request(url, { method: 'GET', headersTimeout: 15_000, bodyTimeout: 30_000 });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }
    const ct = String(res.headers['content-type'] ?? '');
    const ext = ct.includes('png')
      ? '.png'
      : ct.includes('webp')
        ? '.webp'
        : ct.includes('gif')
          ? '.gif'
          : ct.includes('svg')
            ? '.svg'
            : ct.includes('jpeg') || ct.includes('jpg')
              ? '.jpg'
              : path.extname(new URL(url).pathname) || '.bin';
    const dest = path.join(imagesDir(), keyFor(url) + ext);
    const buf = Buffer.from(await res.body.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

/** URLs de imagem do espelho (produtos + logo/capa da loja). */
function mirrorImageUrls(): string[] {
  const urls = new Set<string>();
  for (const p of readMirrorTable<{ image_url?: string }>('products')) {
    if (typeof p.image_url === 'string' && /^https?:\/\//.test(p.image_url)) urls.add(p.image_url);
  }
  for (const s of readMirrorTable<{ logo_url?: string; cover_url?: string }>('store_settings')) {
    for (const u of [s.logo_url, s.cover_url]) {
      if (typeof u === 'string' && /^https?:\/\//.test(u)) urls.add(u);
    }
  }
  return [...urls];
}

/** Baixa (com concorrência limitada) as imagens ainda não cacheadas. */
export async function syncImages(): Promise<void> {
  const pending = mirrorImageUrls().filter((u) => !cachedPath(u));
  if (pending.length === 0) return;
  const CONCURRENCY = 4;
  let i = 0;
  const worker = async () => {
    while (i < pending.length) {
      const url = pending[i++]!;
      await download(url);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  console.log(`[images] ${pending.length} imagem(ns) do cardápio cacheadas`);
}

export interface ServedImage {
  path: string;
  contentType: string;
}

/** Serve a imagem do cache; baixa sob demanda (útil quando online e ainda não sincronizou). */
export async function serveImage(url: string): Promise<ServedImage | null> {
  let file = cachedPath(url);
  if (!file) file = await download(url);
  if (!file) return null;
  return { path: file, contentType: contentTypeFor(file) };
}

/** Reescreve uma URL de imagem para passar pelo gateway local (cache offline). */
export function localImageUrl(original: string, gatewayPort: number): string {
  return `http://127.0.0.1:${gatewayPort}/api/local/image?u=${encodeURIComponent(original)}`;
}
