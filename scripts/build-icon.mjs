import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

/** Gera resources/icon.ico (multi-tamanho) e icon.png a partir de resources/icon.svg */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'resources', 'icon.svg');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const svg = fs.readFileSync(svgPath);
const pngs = await Promise.all(
  sizes.map((size) => sharp(svg, { density: 300 }).resize(size, size).png().toBuffer()),
);

fs.writeFileSync(path.join(root, 'resources', 'icon.ico'), await pngToIco(pngs));
fs.writeFileSync(
  path.join(root, 'resources', 'icon.png'),
  await sharp(svg, { density: 300 }).resize(512, 512).png().toBuffer(),
);

console.log(`[build-icon] icon.ico (${sizes.join(', ')}px) e icon.png (512px) gerados`);
