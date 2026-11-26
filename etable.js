// 単語テスト範囲のプリント(罫線で区切った横書きの表)から、列ごとに文字を読み取る。
//   単語の表:   [番号][英語][日本語] の組が横に何組か並ぶ(例: ①〜⑤ の 5 組)
//   過去形の表: [No][日本語の意味][原形][過去形](be 動詞のように、意味のマスが何行かにまたがってもよい)
// 計算の部分(白黒の配列を受け取る関数)は DOM に依存しないので、Node でテストできる。

// ---------- 白黒にする・傾きを求める ----------

/**
 * 局所しきい値で黒い画素を求める(写真の明るさのむら・影に強い)。
 * @returns {Uint8Array} 1 = 黒
 */
export function adaptiveDark(gray, W, H, win = 31, c = 14) {
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const r = win >> 1;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      out[y * W + x] = gray[y * W + x] < mean - c ? 1 : 0;
    }
  }
  return out;
}

/** 傾き t(= tan θ)で縦方向に足し合わせた、横位置ごとの黒い画素の数 */
function verticalProfile(dark, W, H, t) {
  const P = new Float64Array(W);
  const cy = H / 2;
  for (let y = 0; y < H; y++) {
    const shift = (y - cy) * t;
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!dark[row + x]) continue;
      const px = Math.round(x - shift);
      if (px >= 0 && px < W) P[px]++;
    }
  }
  return P;
}

/** 横方向に足し合わせた、縦位置ごとの黒い画素の数(傾き t) */
function horizontalProfile(dark, W, H, t) {
  const P = new Float64Array(H);
  const cx = W / 2;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!dark[row + x]) continue;
      const py = Math.round(y - (x - cx) * t);
      if (py >= 0 && py < H) P[py]++;
    }
  }
  return P;
}

/**
 * 罫線がいちばんまっすぐに揃う傾き(度)を求める。横長の表は横の罫線、縦長の表は縦の罫線で測る。
 * 正の値は、時計回りに傾いている(縦線は下に行くほど右へ、横線は右に行くほど下へずれる)ことを表す。
 */
export function estimateSkew(dark, W, H, range = 6, step = 0.2) {
  let best = 0, bestScore = -1;
  for (let a = -range; a <= range + 1e-9; a += step) {
    const t = Math.tan((a * Math.PI) / 180);
    const P = W >= H ? horizontalProfile(dark, W, H, t) : verticalProfile(dark, W, H, t);
    let s = 0;
    for (let i = 0; i < P.length; i++) s += P[i] * P[i];
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return Math.round(best * 100) / 100;
}

// ---------- 罫線を探す ----------
// 斜めから撮った写真では、罫線が平行にならない(遠い方が狭くなる)。罫線は 1 本ずつ、それぞれの傾きで探す。
// 罫線は { p, s } で表す: p は画像の中央での位置、s は傾き(縦線: y が 1 増えたときの x の増え方、横線: その逆)。

const SPREAD = 2; // 線の太さ方向に ±2px の幅で黒を見る(少し曲がった線も 1 本の線として数える)
const LINE_MIN = 0.55; // 線とみなす割合(範囲の幅・高さに対して)
const TOPHAT_MIN = 0.25; // まわり(線から離れた所)より、これだけ多いこと(字の並びは幅が広いので、まわりも黒い)
const MAX_SLANT = 0.05; // 調べる傾き(約 ±3°。全体の傾きは先に直してある)
const SLANT_STEP = 0.0025;

/** 線の太さ方向に黒を広げる(axis: 'x' は横に、'y' は縦に) */
function dilate(dark, W, H, axis, r = SPREAD) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!dark[y * W + x]) continue;
      for (let d = -r; d <= r; d++) {
        if (axis === 'x') {
          const xx = x + d;
          if (xx >= 0 && xx < W) out[y * W + xx] = 1;
        } else {
          const yy = y + d;
          if (yy >= 0 && yy < H) out[yy * W + x] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * 傾きを変えながら足し合わせ、位置ごとに、いちばん線らしく揃う傾きでの黒の割合を求める。
 * @param {'v' | 'h'} kind 縦線 / 横線
 * @returns {{P: Float64Array, S: Float64Array, I: Int16Array, all: Float64Array[]}}
 *   P・S: 位置ごとの、いちばん揃う傾きでの割合とその傾き。I: その傾きの番号。all: 傾きごとの割合
 */
export function slantProfile(dark, W, H, kind) {
  const dd = dilate(dark, W, H, kind === 'v' ? 'x' : 'y');
  const N = kind === 'v' ? W : H; // 線の位置の数
  const L = kind === 'v' ? H : W; // 線の長さの方向
  const P = new Float64Array(N), S = new Float64Array(N), I = new Int16Array(N);
  const all = [];
  const mid = L / 2;
  const steps = Math.round((2 * MAX_SLANT) / SLANT_STEP);
  for (let si = 0; si <= steps; si++) {
    const s = -MAX_SLANT + si * SLANT_STEP;
    const cnt = new Float64Array(N);
    for (let t = 0; t < L; t++) {
      const shift = Math.round(s * (t - mid));
      const p0 = Math.max(0, -shift), p1 = Math.min(N, N - shift);
      if (kind === 'v') {
        const row = t * W + shift;
        for (let p = p0; p < p1; p++) if (dd[row + p]) cnt[p]++;
      } else {
        for (let p = p0; p < p1; p++) if (dd[(p + shift) * W + t]) cnt[p]++;
      }
    }
    for (let p = 0; p < N; p++) {
      const f = (cnt[p] /= L);
      if (f > P[p]) {
        P[p] = f;
        S[p] = s;
        I[p] = si;
      }
    }
    all.push(cnt);
  }
  return { P, S, I, all };
}

/**
 * 罫線の位置を探す。いちばん揃う傾きでの割合 P が LINE_MIN 以上の所を線の候補とし、
 * その候補の傾きでの割合(ほかの傾きで線を斜めに横切った分が混ざらない)で、
 * - 幅が maxThick 以下(字の並びは幅が広い)
 * - 線のすぐ外側(線の幅ぶん離れた所まで)の最大より TOPHAT_MIN 以上高い
 * ものを線とする。線の太さは写真によって違う(近くに写った所ほど太い)ので、候補ごとに測る。
 * @param {{P: Float64Array, S: Float64Array, I: Int16Array, all: Float64Array[]}} prof slantProfile の結果
 * @returns {{p: number, s: number}[]} 線の中心の位置と傾き
 */
export function linePeaks(prof, maxThick, mergeDist) {
  const { P, S, I, all } = prof;
  const n = P.length;
  const found = [];
  for (let i = 0; i < n; i++) {
    if (P[i] < LINE_MIN) continue;
    let e = i;
    while (e < n && P[e] >= LINE_MIN) e++;
    // 候補の中でいちばん高い所の傾きで、線の幅とまわりを測り直す
    let j0 = i;
    for (let j = i; j < e; j++) if (P[j] > P[j0]) j0 = j;
    const A = all[I[j0]];
    let s0 = j0, e0 = j0 + 1;
    while (s0 > 0 && A[s0 - 1] >= LINE_MIN) s0--;
    while (e0 < n && A[e0] >= LINE_MIN) e0++;
    const w = e0 - s0;
    if (w <= maxThick) {
      let wsum = 0, psum = 0;
      for (let j = s0; j < e0; j++) {
        wsum += A[j] * j;
        psum += A[j];
      }
      const m = Math.max(4, w);
      let around = 0;
      for (let d = 2; d <= m + 2; d++) {
        if (s0 - d >= 0) around = Math.max(around, A[s0 - d]);
        if (e0 - 1 + d < n) around = Math.max(around, A[e0 - 1 + d]);
      }
      if (A[j0] - around >= TOPHAT_MIN) found.push({ p: wsum / psum, s: S[j0], w });
    }
    i = e;
  }
  const merged = [];
  for (const l of found) {
    const last = merged[merged.length - 1];
    if (last && l.p - last.p < mergeDist) last.p = (last.p + l.p) / 2;
    else merged.push(l);
  }
  return merged;
}

/** 罫線の、ある所での位置(縦線: y での x、横線: x での y)。mid は線の長さの方向の中央 */
export function lineAt(line, t, mid) {
  return line.p + line.s * (t - mid);
}

/**
 * 罫線の一覧から、マスの境目の一覧を作る。端の、罫線の外側の部分は、隣のマスの幅の 0.6 倍以上あれば足す
 * (写真の端で切れた行・列)。ごく細いマス(二重線)は除く。
 * @returns {{p: number, s: number}[]} 境目(画像の端は { p: 0 } / { p: size })
 */
export function boundsOf(lines, size, minRatio = 0.6) {
  const xs = lines.slice().sort((p, q) => p.p - q.p);
  if (xs.length < 2) return [{ p: 0, s: 0 }, { p: size, s: 0 }];
  const widths = [];
  for (let i = 1; i < xs.length; i++) widths.push(xs[i].p - xs[i - 1].p);
  const med = widths.slice().sort((p, q) => p - q)[widths.length >> 1];
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i].p - out[out.length - 1].p > Math.min(med * 0.25, 12)) out.push(xs[i]);
  }
  if (out.length < 2) return [{ p: 0, s: 0 }, { p: size, s: 0 }];
  const first = out[1].p - out[0].p, last = out[out.length - 1].p - out[out.length - 2].p;
  if (out[0].p > Math.min(med, first) * minRatio) out.unshift({ p: 0, s: 0 });
  if (size - out[out.length - 1].p > Math.min(med, last) * minRatio) out.push({ p: size, s: 0 });
  return out;
}

/** 境目の一覧から、マスの範囲(中央での位置)の一覧 */
function spans(bounds) {
  const out = [];
  for (let i = 1; i < bounds.length; i++) out.push([bounds[i - 1].p, bounds[i].p]);
  return out;
}

/**
 * 傾きを直した画像から、表の行と列を見つける。
 * @returns {{h: object[], v: object[], hb: object[], vb: object[], rows: number[][], cols: number[][]}}
 *   h・v: 横・縦の罫線、hb・vb: 行・列の境目(端を含む)、rows・cols: 行・列の範囲(画像の中央での位置)
 */
export function findTableGrid(dark, W, H) {
  const thick = Math.max(14, Math.round(Math.max(W, H) * 0.02)); // 線の太さの上限(線の太さ方向に広げた分を含む)
  const hp = slantProfile(dark, W, H, 'h');
  const vp = slantProfile(dark, W, H, 'v');
  const h = linePeaks(hp, thick, Math.max(4, H * 0.008));
  const v = linePeaks(vp, thick, Math.max(4, W * 0.006));
  const hb = boundsOf(h, H), vb = boundsOf(v, W);
  return { h, v, hb, vb, rows: spans(hb), cols: spans(vb) };
}

/**
 * 列の役目を決める。番号の列は、ほかの列よりずっと細い。
 *   単語の表:   番号の列のあとに [英語, 日本語]
 *   過去形の表: 番号の列のあとに [日本語の意味, 原形, 過去形]
 * 番号の列が見つからないときは、左から順に [英語, 日本語](過去形: [日本語の意味, 原形, 過去形])の組とする。
 * @param {number[]} widths 列の幅(左から)
 * @param {'word' | 'past'} mode
 * @returns {{no: number | null, en?: number, ja: number, base?: number, past?: number}[]} 列の番号(左から 0, 1, …)の組
 */
export function assignRoles(widths, mode) {
  const n = widths.length;
  const widest = Math.max(0, ...widths);
  const roles = mode === 'past' ? ['ja', 'base', 'past'] : ['en', 'ja'];
  const narrow = widths.map((w) => w < widest * 0.45);
  const groups = [];
  for (let i = 0; i < n; i++) {
    if (!narrow[i]) continue;
    const g = { no: i };
    roles.forEach((r, j) => (g[r] = i + 1 + j));
    // 後ろに列が足りない(表の端で切れた)組は使わない
    if (roles.every((r) => g[r] < n && !narrow[g[r]])) groups.push(g);
  }
  if (!groups.length) {
    for (let i = 0; i + roles.length <= n; i += roles.length) {
      const g = { no: null };
      roles.forEach((r, j) => (g[r] = i + j));
      groups.push(g);
    }
  }
  return groups;
}

/** マス(行 r・列 c)の範囲: 上下は列の中央で、左右は行の中央で測る(斜めの写真でも、そのマスに合う) */
export function cellBox(grid, W, H, r, c) {
  const T = grid.hb[r], B = grid.hb[r + 1], L = grid.vb[c], R = grid.vb[c + 1];
  const ym0 = (T.p + B.p) / 2;
  const xm = (lineAt(L, ym0, H / 2) + lineAt(R, ym0, H / 2)) / 2;
  const y0 = lineAt(T, xm, W / 2), y1 = lineAt(B, xm, W / 2);
  const ym = (y0 + y1) / 2;
  return { x0: lineAt(L, ym, H / 2), x1: lineAt(R, ym, H / 2), y0, y1 };
}

/**
 * 横の罫線が、マスの幅を横切っているか(マスが上下にまたがっていないか)。
 * 線に沿って ±3px に黒が 60% 以上あれば、線があるとみなす。
 */
export function hasRule(dark, W, H, line, x0, x1) {
  const a = Math.max(0, Math.round(x0)), b = Math.min(W, Math.round(x1));
  let on = 0;
  for (let x = a; x < b; x++) {
    const y = Math.round(lineAt(line, x, W / 2));
    for (let d = -3; d <= 3; d++) {
      const yy = y + d;
      if (yy >= 0 && yy < H && dark[yy * W + x]) {
        on++;
        break;
      }
    }
  }
  return on >= (b - a) * 0.6;
}

/**
 * 列の中で、上下にまたがったマス(be 動詞の「…である・…にいる」のように、横の罫線のない所)をまとめる。
 * @returns {number[]} 行ごとの、まとまりの最初の行の番号
 */
export function mergedRows(dark, W, H, grid, col) {
  const owner = grid.rows.map((_, i) => i);
  for (let i = 1; i < grid.rows.length; i++) {
    const line = grid.hb[i];
    if (!grid.h.includes(line)) continue; // 画像の端
    const box = cellBox(grid, W, H, i, col);
    const inset = (box.x1 - box.x0) * 0.1;
    if (!hasRule(dark, W, H, line, box.x0 + inset, box.x1 - inset)) owner[i] = owner[i - 1];
  }
  return owner;
}

/**
 * OCR で読んだ行を、表の行に振り分ける。
 * @param {{text: string, confidence: number, y: number}[]} lines y: 行の中心(列の画像の座標)
 * @param {{rows: number[], y0: number, y1: number}[]} segs 列の画像の中の、まとまりごとの範囲と、その行
 * @param {number} nRows 表の行の数
 * @returns {{text: string, conf: number, lines: string[]}[]} 行ごと(またがったマスは、そのすべての行に同じ文字)
 */
export function linesToRows(lines, segs, nRows) {
  const cells = segs.map(() => ({ lines: [], confs: [] }));
  for (const l of lines.slice().sort((p, q) => p.y - q.y)) {
    const i = segs.findIndex((s) => l.y >= s.y0 && l.y < s.y1);
    if (i < 0) continue;
    cells[i].lines.push(l.text);
    cells[i].confs.push(l.confidence);
  }
  const out = Array.from({ length: nRows }, () => ({ lines: [], text: '', conf: 0 }));
  segs.forEach((s, i) => {
    const c = cells[i];
    for (const r of s.rows) out[r] = { lines: c.lines, text: c.lines.join('\n'), conf: c.confs.length ? Math.min(...c.confs) : 0 };
  });
  return out;
}

// ---------- ブラウザ用: 画像から読み取る ----------

function grayOf(canvas) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  return out;
}

/** 元画像の rect の部分を、傾き deg だけ戻して scale 倍にした画像(表の画像)を描く変換を当てて、描く */
function drawTable(g, src, rect, deg, scale) {
  const W = Math.round(rect.w * scale), H = Math.round(rect.h * scale);
  g.translate(W / 2, H / 2);
  g.rotate((-deg * Math.PI) / 180); // 時計回りに傾いている(deg > 0)なら、反時計回りに戻す
  g.scale(scale, scale);
  g.drawImage(src, -(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
}

/** 表の画像(傾きを直したもの)全体 */
function render(src, rect, deg, scale) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w * scale));
  c.height = Math.max(1, Math.round(rect.h * scale));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.save();
  drawTable(g, src, rect, deg, scale);
  g.restore();
  return c;
}

/** 明るさを伸ばして、紙を白・字を黒にはっきりさせる(紙の明るさは、多くを占める明るい所) */
function stretch(canvas, x = 0, y = 0, w = canvas.width, h = canvas.height) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const id = g.getImageData(x, y, w, h);
  const d = id.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)]++;
  const n = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.4) { hi = v; break; } }
  const range = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(id, x, y);
}

/**
 * 写真の、四角で囲んだ範囲(表)の罫線を見つける。
 * @param {HTMLCanvasElement | HTMLImageElement} src 元の画像
 * @param {{x: number, y: number, w: number, h: number}} rect 囲んだ範囲(元画像の px)
 * @param {'word' | 'past'} mode
 */
export function analyzeTable(src, rect, mode) {
  // 1. 全体の傾きを求める(処理を軽くするため、長い辺 1200px 程度に縮める)
  const s1 = Math.min(1, 1200 / Math.max(rect.w, rect.h));
  const small = render(src, rect, 0, s1);
  const W1 = small.width, H1 = small.height;
  const skew = estimateSkew(adaptiveDark(grayOf(small), W1, H1, Math.max(15, Math.round(Math.min(W1, H1) / 25) | 1)), W1, H1);
  // 2. 傾きを戻して、罫線を見つける(長い辺 1600px 程度)
  const scale = Math.min(2, 1600 / Math.max(rect.w, rect.h));
  const img = render(src, rect, skew, scale);
  const W = img.width, H = img.height;
  const dark = adaptiveDark(grayOf(img), W, H, Math.max(15, Math.round(Math.min(W, H) / 25) | 1));
  const grid = findTableGrid(dark, W, H);
  const groups = assignRoles(grid.cols.map(([a, b]) => b - a), mode);
  return { skew, scale, W, H, dark, grid, groups };
}

/**
 * 1 列ぶんの画像。マスを上から 1 つずつ(斜めの写真でも、それぞれのマスの範囲で)切り出して縦に並べ、
 * 罫線を除いて、字の高さが OCR に向いた大きさに拡大する。上下にまたがったマスは 1 つにまとめて切り出す。
 * @param {number[] | null} owner mergedRows の結果(省くと、またがりなし)
 * @returns {{canvas: HTMLCanvasElement, segs: {rows: number[], y0: number, y1: number}[]}}
 */
export function columnImage(src, rect, table, col, owner = null) {
  const { grid, skew, scale, W, H } = table;
  const nRows = grid.rows.length;
  const own = owner || grid.rows.map((_, i) => i);
  const heights = grid.rows.map(([a, b]) => b - a).sort((p, q) => p - q);
  const rowH = heights[heights.length >> 1] || 40;
  const k = Math.max(1, Math.min(4, 70 / rowH)); // 1 行の高さが 70px ほどになるように
  const inset = 2; // 罫線は下で白く塗るので、切り出しは罫線の中心から少し内側
  // まとまり(またがったマスは 1 つ)ごとの範囲
  const parts = [];
  for (let r = 0; r < nRows; r++) {
    const last = parts[parts.length - 1];
    if (last && own[r] === last.rows[0]) last.rows.push(r);
    else parts.push({ rows: [r] });
  }
  for (const p of parts) {
    const top = cellBox(grid, W, H, p.rows[0], col), bottom = cellBox(grid, W, H, p.rows[p.rows.length - 1], col);
    p.box = { x0: Math.min(top.x0, bottom.x0) + inset, x1: Math.max(top.x1, bottom.x1) - inset, y0: top.y0, y1: bottom.y1 };
  }
  const width = Math.round(Math.max(...parts.map((p) => p.box.x1 - p.box.x0)) * k);
  const gap = Math.round(10 * k); // まとまりの間のすき間(白)
  const pad = Math.round(14 * k); // 左右の余白(字が端に付いていると読みにくい)
  let y = gap;
  const segs = [];
  for (const p of parts) {
    const h = Math.max(1, Math.round((p.box.y1 - p.box.y0) * k));
    segs.push({ rows: p.rows, top: y, h, box: p.box, y0: y - gap / 2, y1: y + h + gap / 2 });
    y += h + gap;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width + pad * 2;
  canvas.height = y;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingQuality = 'high';
  for (const s of segs) {
    const { box } = s;
    g.save();
    g.beginPath();
    g.rect(pad, s.top, width, s.h);
    g.clip();
    // マスを、列の画像の (pad, top) に、幅 width・高さ h で描く
    g.translate(pad, s.top);
    g.scale(width / (box.x1 - box.x0), k);
    g.translate(-box.x0, -box.y0);
    g.save();
    drawTable(g, src, rect, skew, scale);
    g.restore();
    // マスを囲む罫線を、線の位置・傾き・太さに沿って白く塗る(斜めの線も残らないように)
    g.fillStyle = '#fff';
    const T = grid.hb[s.rows[0]], B = grid.hb[s.rows[s.rows.length - 1] + 1], L = grid.vb[col], R = grid.vb[col + 1];
    const ext = 40;
    for (const line of [T, B]) {
      if (!line.w) continue; // 画像の端(線がない)
      const t = Math.max(2, (line.w - 2 * SPREAD) / 2 + 2);
      const xa = box.x0 - ext, xb = box.x1 + ext;
      g.beginPath();
      g.moveTo(xa, lineAt(line, xa, W / 2) - t);
      g.lineTo(xb, lineAt(line, xb, W / 2) - t);
      g.lineTo(xb, lineAt(line, xb, W / 2) + t);
      g.lineTo(xa, lineAt(line, xa, W / 2) + t);
      g.fill();
    }
    for (const line of [L, R]) {
      if (!line.w) continue;
      const t = Math.max(2, (line.w - 2 * SPREAD) / 2 + 2);
      const ya = box.y0 - ext, yb = box.y1 + ext;
      g.beginPath();
      g.moveTo(lineAt(line, ya, H / 2) - t, ya);
      g.lineTo(lineAt(line, yb, H / 2) - t, yb);
      g.lineTo(lineAt(line, yb, H / 2) + t, yb);
      g.lineTo(lineAt(line, ya, H / 2) + t, ya);
      g.fill();
    }
    g.restore();
  }
  for (const s of segs) stretch(canvas, pad, s.top, width, s.h); // マスごとに(写真の明るさのむらに強い)
  return { canvas, segs: segs.map(({ rows, y0, y1 }) => ({ rows, y0, y1 })) };
}
