// 通しテスト用の、単語テスト範囲のプリントを模した画像を作る(tests/fixtures/*.png と、正解の *.json)。
//   node scripts/make-fixtures.mjs
// 語はこのプロジェクトで選んだ、よく使う英単語。写真らしく、少し灰色の紙・少しの傾き・ぼかしを付ける。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures');
fs.mkdirSync(OUT, { recursive: true });

const WORDS = [
  [301, 'apple', 'りんご'], [302, 'river', '川'], [303, 'bridge', '橋'], [304, 'happy', '幸せな'],
  [305, 'library', '図書館'], [306, 'yellow', '黄色の'], [307, 'jump', '跳ぶ'], [308, 'quiet', '静かな'],
  [309, 'summer', '夏'], [310, 'garden', '庭'], [311, 'window', '窓'], [312, 'teacher', '先生'],
  [313, 'busy', '忙しい'], [314, 'clock', '時計'], [315, 'dinner', '夕食'], [316, 'young', '若い'],
];
const PAST = [
  [1, '食べる', 'eat', 'ate'], [2, '行く', 'go', 'went'], [3, '見る', 'see', 'saw'], [4, '書く', 'write', 'wrote'],
  [5, '飲む', 'drink', 'drank'], [6, '走る', 'run', 'ran'],
];

const css = `body{margin:0;background:#bdbab3}
.sheet{position:absolute;left:40px;top:30px;background:#ecebe6;padding:18px;transform:rotate(0.8deg);filter:blur(0.5px)}
table{border-collapse:collapse;font:500 22px 'Yu Gothic','Meiryo','Segoe UI',sans-serif;color:#222}
td,th{border:2px solid #333;padding:6px 14px;text-align:center;height:34px}
th{font-weight:700;background:#dcdcd6}
.n{width:44px;font-size:18px}.e{width:150px}.j{width:170px}`;

async function shot(name, html, w, h) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(`<html><head><style>${css}</style></head><body><div class="sheet">${html}</div></body></html>`);
  await page.screenshot({ path: path.join(OUT, name) });
  await browser.close();
  console.log('tests/fixtures/' + name);
}

// 単語の表: 2 組([番号][英語][日本語])× 8 行
const half = WORDS.length / 2;
let rows = '<tr><th>①</th><th>英語</th><th>日本語</th><th>②</th><th>英語</th><th>日本語</th></tr>';
for (let i = 0; i < half; i++) {
  const a = WORDS[i], b = WORDS[i + half];
  rows += `<tr><td class="n">${a[0]}</td><td class="e">${a[1]}</td><td class="j">${a[2]}</td><td class="n">${b[0]}</td><td class="e">${b[1]}</td><td class="j">${b[2]}</td></tr>`;
}
await shot('print-words.png', `<table>${rows}</table>`, 1000, 520);
fs.writeFileSync(path.join(OUT, 'print-words.json'), JSON.stringify(WORDS.map(([no, en, ja]) => ({ no, en, ja })), null, 1));

// 過去形の表: [No][日本語の意味][原形][過去形]
rows = '<tr><th>No</th><th>日本語の意味</th><th>原形</th><th>過去形</th></tr>';
for (const [no, ja, base, past] of PAST) rows += `<tr><td class="n">${no}</td><td class="j">${ja}</td><td class="e">${base}</td><td class="e">${past}</td></tr>`;
await shot('print-past.png', `<table>${rows}</table>`, 760, 440);
fs.writeFileSync(path.join(OUT, 'print-past.json'), JSON.stringify(PAST.map(([no, ja, base, en]) => ({ no, ja, base, en })), null, 1));
