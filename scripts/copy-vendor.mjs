// node_modules から、ブラウザで使うファイルを vendor/ にコピーする(npm install のあとに 1 回実行)。
//   node scripts/copy-vendor.mjs
//
// vendor/tesseract/tesseract.min.js, worker.min.js
// vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js, tesseract-core-lstm.wasm.js
// vendor/tesseract/lang/eng.traineddata.gz, jpn.traineddata.gz (4.0.0_best_int)
// vendor/qrcode/qrcode.mjs           … QR コードを作る(qrcode-generator、MIT。ライセンスはファイルの先頭)
// vendor/jsqr/jsQR.js                … QR コードを読む(jsQR、Apache-2.0)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const V = path.join(ROOT, 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(path.relative(ROOT, to), (fs.statSync(to).size / 1024).toFixed(0) + ' KB');
}

fs.rmSync(V, { recursive: true, force: true });

// ---- Tesseract.js ----
for (const f of ['tesseract.min.js', 'worker.min.js']) copy(path.join(NM, 'tesseract.js/dist', f), path.join(V, 'tesseract', f));
copy(path.join(NM, 'tesseract.js/LICENSE.md'), path.join(V, 'tesseract/LICENSE.md'));
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
  copy(path.join(NM, 'tesseract.js-core', f), path.join(V, 'tesseract/core', f));
}
copy(path.join(NM, 'tesseract.js-core/LICENSE'), path.join(V, 'tesseract/core/LICENSE'));
for (const lang of ['eng', 'jpn']) {
  copy(
    path.join(NM, `@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`),
    path.join(V, `tesseract/lang/${lang}.traineddata.gz`),
  );
}

// ---- QR コード(ほかの端末とのデータのやりとり) ----
copy(path.join(NM, 'qrcode-generator/dist/qrcode.mjs'), path.join(V, 'qrcode/qrcode.mjs'));
copy(path.join(NM, 'jsqr/dist/jsQR.js'), path.join(V, 'jsqr/jsQR.js'));
copy(path.join(NM, 'jsqr/LICENSE'), path.join(V, 'jsqr/LICENSE'));
