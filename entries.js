// 読み取った表・貼り付けた文から、語の一覧に入れる問題(番号・英語・日本語)を作る。
// DOM に依存しない(Node でテストできる)。

/** 番号のマスの文字から数を取り出す(読めなければ null) */
export function parseNo(text) {
  if (/[①-⑳]/.test(text || '')) return null; // 見出しの ①〜⑤
  const t = String(text || '')
    .normalize('NFKC')
    .replace(/[oO]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[^0-9]/g, '');
  if (!t || t.length > 4) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * 行ごとの番号を決める。読み違い・読めなかった番号は、前後の番号から補う。
 * - 読めた番号のうち、表の上から下へ「番号が増え、行の数より速くは増えない」並びになる、いちばん多い組を正しいとみなす
 *   (111 を 11 と読んだような読み違いは、この並びに入らない)
 * - 正しい番号の間で、行の数と番号の差が合えば、その間の行に番号を振る(guessed: 読んだ番号と違うとき)
 * - 番号の差が行の数より小さい所(「be 動詞」などの見出しの行)と、表の初めの見出しの行は使わない(null)
 * - 表の最後の、英語が入っている行は、前の番号の続きにする(guessed: true)
 * @param {(number | null)[]} nums 行ごとに読んだ番号
 * @param {boolean[]} filled 行に英語などが入っているか
 * @returns {{no: number | null, guessed: boolean}[]}
 */
export function fixNumbers(nums, filled = nums.map(() => true)) {
  const n = nums.length;
  const fits = (p, q) => nums[q] - nums[p] >= 1 && nums[q] - nums[p] <= q - p;
  // いちばん多い並び(同じ数なら、ちょうど続き番号になっている所の多い方)
  const score = new Array(n).fill(-1), prev = new Array(n).fill(-1);
  for (let q = 0; q < n; q++) {
    if (nums[q] == null) continue;
    score[q] = 10;
    for (let p = 0; p < q; p++) {
      if (score[p] < 0 || !fits(p, q)) continue;
      const v = score[p] + 10 + (nums[q] - nums[p] === q - p ? 1 : 0);
      if (v > score[q]) {
        score[q] = v;
        prev[q] = p;
      }
    }
  }
  let end = -1;
  for (let i = 0; i < n; i++) if (score[i] >= 0 && (end < 0 || score[i] > score[end])) end = i;
  const acc = [];
  for (let i = end; i >= 0; i = prev[i]) acc.unshift(i);
  // 1 つだけの番号(ほかと並ばない)は、読み違いかもしれないので使わない
  if (acc.length < 2) acc.length = 0;
  const out = nums.map(() => ({ no: null, guessed: false }));
  for (const i of acc) out[i] = { no: nums[i], guessed: false };
  for (let t = 1; t < acc.length; t++) {
    const p = acc[t - 1], q = acc[t];
    if (nums[q] - nums[p] === q - p) {
      for (let i = p + 1; i < q; i++) out[i] = { no: nums[p] + (i - p), guessed: nums[i] !== nums[p] + (i - p) };
      continue;
    }
    // 間に見出しの行がある(番号の差が行の数より小さい): 抜けた番号は、後ろの番号のすぐ前の行から数えて振る
    // (例: 20、be 動詞、見出し、[21 が読めない]、22 → 22 のすぐ前の行を 21 にする)
    for (let j = 1; j < nums[q] - nums[p]; j++) {
      const i = q - j;
      if (i <= p || !filled[i]) break;
      out[i] = { no: nums[q] - j, guessed: nums[i] !== nums[q] - j };
    }
  }
  // 表の最後の、番号が読めなかった(読み違えた)行
  const last = acc.length ? acc[acc.length - 1] : -1;
  if (last >= 0) {
    for (let i = last + 1; i < n; i++) {
      if (!filled[i]) break;
      out[i] = { no: nums[last] + (i - last), guessed: nums[i] !== nums[last] + (i - last) };
    }
  }
  return out;
}

const EN_CHARS = /[^A-Za-z' ~().,!?/\-]/g;

/** 英語のマスの文字をきれいにする(行が分かれていたら、つなげる: restauran / t → restaurant) */
export function cleanEn(lines) {
  let out = '';
  for (const raw of lines) {
    let t = String(raw)
      .normalize('NFKC')
      .replace(/[’‘`´]/g, "'")
      .replace(/[〜～]/g, '~')
      .replace(EN_CHARS, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,'\-]+|[\s.,\-]+$/g, '')
      .trim();
    if (!/[A-Za-z]/.test(t)) continue;
    // マスの端の罫線を l・I・| と読んだもの(1 字だけの語。I see の I は残す)
    // 記号だけの語・端の 1 字(罫線のかけら)を除く。大文字の I(I see)と a(a few)は残す
    const words = t.split(' ').filter((x) => /[A-Za-z]/.test(x));
    while (words.length > 1 && /^[lIi|1!]$/.test(words[words.length - 1])) words.pop();
    while (words.length > 1 && /^[li|1!]$/.test(words[0])) words.shift();
    for (let k = 0; k < words.length; k++) {
      words[k] = words[k].replace(/^[)!.,]+(?=[A-Za-z(])|(?<=[A-Za-z])[(!,]+$/g, '');
      if (words[k].startsWith('(') && !words[k].includes(')')) words[k] = words[k].slice(1); // 閉じていない (
    }
    t = words.join(' ');
    if (!out) out = t;
    // 次の行が 1〜2 字の小文字だけなら、前の語の続き(マスの中で折り返した語)
    else if (/^[a-z]{1,2}$/.test(t) && /[a-z]$/.test(out)) out += t;
    else out += ' ' + t;
  }
  return out;
}

/** 日本語のマスの文字をきれいにする(行をつなげ、字の間のスペースを除く) */
export function cleanJa(lines) {
  return lines
    .map((l) => String(l).normalize('NFKC'))
    .join('')
    .replace(/[〜～]/g, '~')
    .replace(/\s+/g, ' ')
    // 日本語の字・記号の間のスペース(OCR が字の間に入れる)を除く
    .replace(/(?<=[^\x00-\x7f]) (?=[^\x00-\x7f])/g, '')
    .replace(/(?<=[^\x00-\x7f]) (?=[~(])|(?<=[~)]) (?=[^\x00-\x7f])/g, '')
    // 「~」を長音の「ー」などと読んだもの(文の初め・、や ( ) のあと)
    .replace(/(^|[、,()・])[ー―‐−-]+/g, '$1~')
    .replace(/(?<=\))一/g, '~')
    // 「…」(三点リーダー)を「...」と読んだもの。前後の「*」、文の初めの「・」はごみ、「・・」は 1 つに
    .replace(/[.。*]*(?:\.{2,}|…+)[.。*]*/g, '…')
    .replace(/^・+/, '')
    .replace(/・{2,}/g, '・')
    .replace(/~+/g, '~')
    .replace(/^[\s|_.,]+|[\s|_]+$/g, '')
    .trim();
}

const LOW_CONF = 70; // OCR の確からしさがこれより低いマスは、確かめてもらう(黄色)

/**
 * 読み取った表の列(組ごと・行ごとのマス)から、問題を作る。
 * @param {'word' | 'past'} mode
 * @param {{no: object[] | null, en?: object[], ja: object[], base?: object[], past?: object[]}[]} groups
 *   組ごとの列。各列は行ごとの { lines: string[], conf: number }
 * @returns {{no: number | null, en: string, ja: string, base?: string, kind: string, check: string[]}[]}
 *   check: 確かめてほしい項目('no' | 'en' | 'ja' | 'base')
 */
export function tableEntries(mode, groups) {
  const out = [];
  for (const g of groups) {
    const answer = mode === 'past' ? g.past : g.en;
    const rows = answer.length;
    const filled = answer.map((c) => /[A-Za-z]{2,}/.test(c.lines.join(' ')));
    const nums = g.no ? fixNumbers(g.no.map((c) => parseNo(c.lines.join(''))), filled) : answer.map(() => ({ no: null, guessed: false }));
    for (let i = 0; i < rows; i++) {
      // 番号の列があるのに番号の決まらない行は、見出しなど
      if (g.no && nums[i].no == null) continue;
      const en = cleanEn(answer[i].lines);
      if (!en) continue;
      const ja = cleanJa(g.ja[i].lines);
      const check = [];
      if (nums[i].guessed) check.push('no');
      if (answer[i].conf < LOW_CONF) check.push('en');
      if (!ja || g.ja[i].conf < LOW_CONF) check.push('ja');
      const e = { no: nums[i].no, en, ja, kind: mode === 'past' ? 'past' : 'word', check };
      if (mode === 'past') {
        e.base = cleanEn(g.base[i].lines);
        if (!e.base || g.base[i].conf < LOW_CONF) check.push('base');
        // 原形・過去形は 1 語(was Ny のように、後ろにごみが付いたら除いて、確かめてもらう)
        for (const [key, flag] of [['en', 'en'], ['base', 'base']]) {
          if (!/\s/.test(e[key])) continue;
          e[key] = e[key].split(/\s+/)[0];
          if (!check.includes(flag)) check.push(flag);
        }
      }
      out.push(e);
    }
  }
  // 同じ番号の行(写真の端で、前の写真と重なった行など)は 1 つだけにする(先に読んだ方を残す)
  const seen = new Set();
  return out.filter((e) => {
    if (e.no == null) return true;
    if (seen.has(e.no)) return false;
    seen.add(e.no);
    return true;
  });
}

/**
 * 貼り付けた文から問題を作る。1 行に 1 問。区切りはタブ(表計算ソフトからの貼り付け)か、スペース。
 *   単語:   [番号] 英語 日本語     (例: 101 walk 歩く / 106	ago	(時間)~前に)
 *   過去形: [番号] 日本語 原形 過去形 (例: 1 食べる eat ate)
 * @returns {{no: number | null, en: string, ja: string, base?: string, kind: string, check: string[]}[]}
 */
export function parsePaste(text, mode) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.normalize('NFKC').replace(/\.{3}/g, '…').trim(); // NFKC は … を ... にするので戻す
    if (!line) continue;
    let no = null, rest = line;
    // 番号のあとの区切り(「1 」「1. 」「1) 」「1、」)。「21 …である」の … は区切りに含めない
    const m = rest.match(/^(\d{1,4})(?:[.)、:]\s*|\s+)/);
    if (m) {
      no = Number(m[1]);
      rest = rest.slice(m[0].length);
    }
    let cols = rest.includes('\t') ? rest.split('\t').map((s) => s.trim()).filter(Boolean) : null;
    if (mode === 'past') {
      if (!cols || cols.length < 3) {
        // 日本語の部分(英字でない所)と、英語の部分に分ける
        const mm = rest.match(/^([^A-Za-z]*?)\s*([A-Za-z].*)$/);
        if (!mm) continue;
        const en = mm[2].trim().split(/\s+/);
        if (en.length < 2) continue;
        cols = [mm[1].trim(), en.slice(0, -1).join(' '), en[en.length - 1]];
      }
      const [ja, base, past] = cols;
      if (!past) continue;
      out.push({ no, ja, base, en: past, kind: 'past', check: [] });
    } else {
      if (!cols || cols.length < 2) {
        // 英語の部分(英字・スペース・' ~ など)と、そのあとの日本語に分ける
        // 英語はスペースを含んでもよい(I see)。日本語の ( ) や ~ の前で止める
        const mm = rest.match(/^([A-Za-z](?:[A-Za-z' .\-/]*[A-Za-z.'])?)\s*(.*)$/);
        if (!mm) continue;
        cols = [mm[1].trim(), mm[2].trim()];
      }
      const [en, ja] = cols;
      if (!en || !/[A-Za-z]/.test(en)) continue;
      out.push({ no, en, ja: ja || '', kind: 'word', check: ja ? [] : ['ja'] });
    }
  }
  return out;
}
