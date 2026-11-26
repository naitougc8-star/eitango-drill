import { describe, it, expect } from 'vitest';
import { findTableGrid, assignRoles, mergedRows, linesToRows, boundsOf } from '../../etable.js';

/**
 * 罫線の表を、白黒の配列で描く。
 * @param {number[]} xs 縦線の位置(上端での x)、@param {number[]} ys 横線の位置
 * @param {number} slant 縦線の傾き(下に 1 px 行くごとに右へずれる量。斜めから撮った写真の代わり)
 * @param {(x: number, y: number) => boolean} skip 線を描かない所(上下にまたがったマス)
 */
function drawGrid(W, H, xs, ys, { slant = 0, thick = 3, skip = () => false, text = true } = {}) {
  const d = new Uint8Array(W * H);
  const set = (x, y) => x >= 0 && x < W && y >= 0 && y < H && (d[y * W + x] = 1);
  for (const x0 of xs) for (let y = ys[0]; y <= ys[ys.length - 1]; y++) for (let t = 0; t < thick; t++) set(Math.round(x0 + slant * y) + t, y);
  for (const y0 of ys) {
    for (let x = 0; x < W; x++) {
      if (skip(x, y0)) continue;
      for (let t = 0; t < thick; t++) set(x, y0 + t);
    }
  }
  // マスの中の字(線より太い塊が並ぶ)
  if (text) {
    for (let r = 1; r < ys.length; r++) {
      const cy = (ys[r - 1] + ys[r]) / 2;
      for (let c = 1; c < xs.length; c++) {
        const x0 = xs[c - 1] + 10, x1 = xs[c] - 10;
        for (let x = x0; x < x1; x += 9) for (let y = cy - 6; y < cy + 6; y++) for (let k = 0; k < 5; k++) set(Math.round(x + k + slant * y), Math.round(y));
      }
    }
  }
  return d;
}

describe('表の罫線を見つける', () => {
  it('単語の表(番号の細い列 + 英語 + 日本語 の組が 2 組)の行と列', () => {
    const W = 900, H = 385;
    const xs = [10, 50, 230, 440, 480, 660, 880];
    const ys = [10, 50, 90, 130, 170, 210, 250, 290, 330, 370];
    const g = findTableGrid(drawGrid(W, H, xs, ys), W, H);
    expect(g.rows).toHaveLength(ys.length - 1);
    expect(g.cols).toHaveLength(xs.length - 1);
    for (let i = 0; i < xs.length; i++) expect(Math.abs(g.v[i].p + 1 - xs[i])).toBeLessThan(3);
    const groups = assignRoles(g.cols.map(([a, b]) => b - a), 'word');
    expect(groups).toEqual([{ no: 0, en: 1, ja: 2 }, { no: 3, en: 4, ja: 5 }]);
  });

  it('斜めから撮った写真(縦線が少しずつ傾いている)でも、線ごとの傾きで見つける', () => {
    const W = 700, H = 870;
    const xs = [10, 80, 330, 520, 690].map((x) => x - 12);
    const ys = [10, 70, 130, 190, 250, 310, 370, 430, 490, 550, 610, 670, 730, 790, 850];
    const g = findTableGrid(drawGrid(W, H, xs, ys, { slant: 0.025 }), W, H);
    expect(g.rows).toHaveLength(ys.length - 1);
    expect(g.cols).toHaveLength(4);
    expect(g.v[1].s).toBeCloseTo(0.025, 2);
    expect(assignRoles(g.cols.map(([a, b]) => b - a), 'past')).toEqual([{ no: 0, ja: 1, base: 2, past: 3 }]);
  });

  it('意味のマスが 3 行にまたがる所(be 動詞)をまとめる', () => {
    const W = 700, H = 420;
    const xs = [10, 80, 330, 520, 690];
    const ys = [10, 90, 170, 250, 330, 410];
    // 2・3 行目の上の横線は、意味の列(80〜330)を横切らない
    const skip = (x, y) => (y === 170 || y === 250) && x > 82 && x < 328;
    const dark = drawGrid(W, H, xs, ys, { skip, text: false });
    const g = findTableGrid(dark, W, H);
    expect(g.rows).toHaveLength(5);
    expect(mergedRows(dark, W, H, g, 1)).toEqual([0, 1, 1, 1, 4]);
    expect(mergedRows(dark, W, H, g, 2)).toEqual([0, 1, 2, 3, 4]);
  });

  it('写真の端で切れた行・列も、ふつうの幅の 6 割以上あれば使う', () => {
    const lines = [{ p: 70, s: 0 }, { p: 170, s: 0 }, { p: 270, s: 0 }];
    expect(boundsOf(lines, 300).map((l) => l.p)).toEqual([0, 70, 170, 270]); // 左は 70(使う)、右は 30(使わない)
    expect(boundsOf(lines, 340).map((l) => l.p)).toEqual([0, 70, 170, 270, 340]);
  });
});

describe('読んだ行を表の行に振り分ける', () => {
  it('2 行に分かれたマスはつなげ、またがったマスは、そのすべての行に同じ文字を入れる', () => {
    const segs = [{ rows: [0], y0: 0, y1: 100 }, { rows: [1, 2], y0: 100, y1: 300 }];
    const lines = [
      { text: 'おそらく、もしか', confidence: 90, y: 30 },
      { text: 'したら', confidence: 80, y: 70 },
      { text: '…である', confidence: 95, y: 180 },
    ];
    const r = linesToRows(lines, segs, 3);
    expect(r[0].lines).toEqual(['おそらく、もしか', 'したら']);
    expect(r[0].conf).toBe(80);
    expect(r[1].text).toBe('…である');
    expect(r[2].text).toBe('…である');
  });
});
