// アイコン(icons/*.png)を作る。生成物はリポジトリに入れてある。
//   node scripts/make-icons.mjs
// Playwright の Chromium で HTML を描いてスクリーンショットを撮る(英語ノートの 4 本線に「Ab」)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function icon(size, file) {
  await page.setViewportSize({ width: size, height: size });
  const s = size;
  await page.setContent(`<html><body style="margin:0">
    <div style="width:${s}px;height:${s}px;background:#1f4e8c;display:flex;align-items:center;justify-content:center;">
      <div style="width:${s * 0.7}px;height:${s * 0.56}px;background:#fdfdfb;border-radius:${s * 0.06}px;position:relative;overflow:hidden;">
        <svg width="100%" height="100%" style="position:absolute;inset:0" viewBox="0 0 100 80" preserveAspectRatio="none">
          <g stroke="#9db5d6" stroke-width="0.9"><line x1="0" y1="18" x2="100" y2="18"/><line x1="0" y1="62" x2="100" y2="62"/></g>
          <g stroke="#9db5d6" stroke-width="0.9" stroke-dasharray="3 2"><line x1="0" y1="33" x2="100" y2="33"/></g>
          <line x1="0" y1="48" x2="100" y2="48" stroke="#d9534f" stroke-width="1.2"/>
        </svg>
        <span style="position:absolute;left:0;right:0;top:${s * 0.02}px;text-align:center;font:700 ${s * 0.34}px 'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#1d1d1f;">Ab</span>
      </div>
    </div></body></html>`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  console.log(path.relative(ROOT, file));
}

await icon(192, path.join(ROOT, 'icons/icon-192.png'));
await icon(512, path.join(ROOT, 'icons/icon-512.png'));
await icon(180, path.join(ROOT, 'icons/apple-touch-icon.png'));
await browser.close();
