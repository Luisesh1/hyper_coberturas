import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const iconsDir = path.join(publicDir, 'icons');

const BG = '#0f1117';
const FG = '#22c55e';

const glyphSvg = (size, padding = 0) => {
  const inner = size - padding * 2;
  const fontSize = Math.round(inner * 0.78);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}" rx="${Math.round(size * 0.18)}" ry="${Math.round(size * 0.18)}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="${fontSize}" fill="${FG}">◈</text>
</svg>`;
};

const maskableSvg = (size) => {
  const fontSize = Math.round(size * 0.56);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-family="system-ui, sans-serif" font-size="${fontSize}" fill="${FG}">◈</text>
</svg>`;
};

async function renderPng(svg, size, outPath) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
}

async function main() {
  await mkdir(iconsDir, { recursive: true });

  await renderPng(glyphSvg(192), 192, path.join(iconsDir, 'icon-192.png'));
  await renderPng(glyphSvg(512), 512, path.join(iconsDir, 'icon-512.png'));
  await renderPng(maskableSvg(512), 512, path.join(iconsDir, 'icon-maskable-512.png'));
  await renderPng(glyphSvg(180), 180, path.join(iconsDir, 'apple-touch-icon-180.png'));

  await writeFile(path.join(publicDir, 'favicon.svg'), glyphSvg(64), 'utf8');

  console.log('PWA icons generated in', iconsDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
