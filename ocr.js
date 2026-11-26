// 写真の表を読み取る(Tesseract.js v5)。ライブラリ・ワーカー・コア・言語データはすべて同じオリジンの vendor/ に置く。
// 表の罫線から列を切り出し、列ごとに 1 回ずつ読み取る(番号: 数字だけ、英語: eng と英字だけ、日本語: jpn)。

import { loadScript } from './util.js';
import { analyzeTable, columnImage, linesToRows, mergedRows } from './etable.js';
import { tableEntries } from './entries.js';

/**
 * 画像ファイルを読み込む。Image で読み込んで canvas に描くことで、EXIF の向きはブラウザが反映する。
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした(対応していない形式かもしれません)'));
    };
    img.src = url;
  });
}

const STATUS = {
  'loading tesseract core': 'OCR エンジンを読み込んでいます',
  'initializing tesseract': 'OCR エンジンを準備しています',
  'loading language traineddata': '言語のデータを読み込んでいます',
  'initializing api': '準備しています',
};

/** 同じオリジンの vendor/ を使う Tesseract のワーカーを作る */
async function createWorker(lang, progress) {
  await loadScript('vendor/tesseract/tesseract.min.js');
  const T = globalThis.Tesseract;
  if (!T) throw new Error('Tesseract.js を読み込めませんでした');
  const base = new URL('vendor/tesseract/', document.baseURI).href;
  return T.createWorker(lang, 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'core/', // ディレクトリを渡す(simd / 非 simd を自動で選ぶ)
    langPath: base + 'lang',
    gzip: true, // 言語データは .traineddata.gz
    logger: (m) => {
      if (!progress || !STATUS[m.status]) return;
      progress(`${STATUS[m.status]}… ${m.progress ? Math.round(m.progress * 100) + '%' : ''}`);
    },
    errorHandler: () => {},
  });
}

// 列の種類ごとの読み方
const READ = {
  no: { lang: 'eng', params: { tessedit_char_whitelist: '0123456789' } },
  en: { lang: 'eng', params: { tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'~().,!?/- " } },
  ja: { lang: 'jpn', params: { tessedit_char_whitelist: '' } },
};
const KIND_OF = { no: 'no', en: 'en', base: 'en', past: 'en', ja: 'ja' };

/** 読み取った結果の行(列の画像の中の y 付き) */
function linesOf(data) {
  const out = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const text = (l.text || '').replace(/\n/g, ' ').trim();
        if (!text) continue;
        out.push({ text, confidence: l.confidence, y: (l.bbox.y0 + l.bbox.y1) / 2 });
      }
    }
  }
  return out;
}

/**
 * 写真の表を読み取って、問題の一覧を作る。
 * @param {HTMLCanvasElement | HTMLImageElement} src 元の画像
 * @param {{x: number, y: number, w: number, h: number}} rect 表を囲んだ範囲(元画像の px)
 * @param {'word' | 'past'} mode 単語の表 / 過去形の表
 * @param {{onProgress?: (text: string) => void}} opts
 * @returns {Promise<{entries: object[], table: object}>}
 */
export async function readTable(src, rect, mode, opts = {}) {
  const progress = opts.onProgress || (() => {});
  progress('表の罫線を探しています…');
  await new Promise((r) => setTimeout(r, 0)); // 文を画面に出してから重い計算をする
  const table = analyzeTable(src, rect, mode);
  const { grid, groups } = table;
  if (grid.rows.length < 2 || grid.cols.length < 2) throw new Error('表の罫線が見つかりませんでした。表だけを四角で囲んで、もう一度読み取ってください');
  // 読む列の一覧(組 → 役目 → 列の番号)
  const jobs = [];
  for (const g of groups) for (const [role, col] of Object.entries(g)) if (col != null) jobs.push({ g, role, col });
  const workers = {};
  const cols = new Map(); // 列の番号 → 行ごとのマス
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { role, col } = jobs[i];
      if (cols.has(col)) continue;
      const read = READ[KIND_OF[role]];
      if (!workers[read.lang]) {
        progress(`OCR の準備をしています…(${read.lang === 'eng' ? '英語' : '日本語'})`);
        workers[read.lang] = await createWorker(read.lang, progress);
      }
      const w = workers[read.lang];
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', ...read.params });
      progress(`読み取っています… ${i + 1} / ${jobs.length} 列`);
      // 日本語の意味のマスは、何行かにまたがることがある(be 動詞の「…である・…にいる」)
      const owner = role === 'ja' ? mergedRows(table.dark, table.W, table.H, grid, col) : null;
      const img = columnImage(src, rect, table, col, owner);
      const { data } = await w.recognize(img.canvas, {}, { blocks: true, text: false });
      cols.set(col, linesToRows(linesOf(data), img.segs, grid.rows.length));
      if (opts.debug) opts.debug({ role, col, image: img.canvas.toDataURL() });
    }
  } finally {
    for (const w of Object.values(workers)) await w.terminate().catch(() => {});
  }
  const cellsOf = (col) => (col == null ? null : cols.get(col));
  const read = groups.map((g) => Object.fromEntries(Object.entries(g).map(([role, col]) => [role, cellsOf(col)])));
  return { entries: tableEntries(mode, read), table: { skew: table.skew, rows: grid.rows.length, cols: grid.cols.length, groups }, read };
}
