import { describe, it, expect } from 'vitest';
import { migrate, wordsOf, photoCount, addWords, groupsOf, createSet, deleteSet, nextPhoto } from '../../sets.js';

describe('テスト(出題の範囲)', () => {
  it('テストのない以前のデータは「テスト 1」にまとめ、語と成績はそのまま残す', () => {
    const old = { words: [{ id: 'a', en: '山', ja: 'やま', result: 'pass', passedAt: 2 }, { id: 'b', en: '川', ja: 'かわ' }] };
    const m = migrate(old);
    expect(m.sets).toHaveLength(1);
    expect(m.sets[0].name).toBe('テスト 1');
    expect(m.currentSet).toBe(m.sets[0].id);
    expect(m.words.every((w) => w.setId === m.sets[0].id)).toBe(true);
    expect(m.words[0].result).toBe('pass');
    expect(m.words[0].passedAt).toBe(2);
    expect(groupsOf(m.words, m.currentSet).map((g) => g.label)).toEqual(['手で追加した語']);
  });

  it('何もないときも、空の「テスト 1」を作る', () => {
    const m = migrate({});
    expect(m.sets.map((s) => s.name)).toEqual(['テスト 1']);
    expect(m.words).toEqual([]);
  });

  it('取り込むたびに写真の番号を付け、写真ごとにまとめる。手で追加した語は最後', () => {
    const words = [];
    const { id } = createSet([], '中間テスト');
    expect(addWords(words, id, [{ en: '天井', ja: 'てんじょう' }, { en: '乾かす', ja: 'かわかす' }])).toBe(2);
    expect(addWords(words, id, [{ en: '期限', ja: 'きげん' }])).toBe(1);
    expect(addWords(words, id, [{ en: '保護', ja: 'ほご' }], 'manual')).toBe(1);
    expect(nextPhoto(words, id)).toBe(3);
    expect(photoCount(words, id)).toBe(2);
    const groups = groupsOf(words, id);
    expect(groups.map((g) => `${g.label}:${g.words.map((w) => w.en).join('・')}`)).toEqual([
      '写真 1:天井・乾かす',
      '写真 2:期限',
      '手で追加した語:保護',
    ]);
  });

  it('同じテストに同じ問題は入れない。別のテストには入れられる', () => {
    const words = [];
    const sets = [];
    const a = createSet(sets, '中間'), b = createSet(sets, '期末');
    addWords(words, a.id, [{ en: '天井', ja: 'てんじょう' }]);
    expect(addWords(words, a.id, [{ en: '天井', ja: 'てんじょう' }])).toBe(0);
    expect(addWords(words, b.id, [{ en: '天井', ja: 'てんじょう' }])).toBe(1);
    expect(wordsOf(words, a.id)).toHaveLength(1);
    expect(wordsOf(words, b.id)).toHaveLength(1);
  });

  it('写真を消しても、写真の番号は 1 から詰めて表示する', () => {
    const words = [];
    const { id } = createSet([], 'x');
    addWords(words, id, [{ en: '一', ja: 'いち' }]);
    addWords(words, id, [{ en: '二', ja: 'に' }]);
    addWords(words, id, [{ en: '三', ja: 'さん' }]);
    const rest = words.filter((w) => w.en !== '二');
    expect(groupsOf(rest, id).map((g) => g.label)).toEqual(['写真 1', '写真 2']);
  });

  it('テストを削除すると、その語も消える。最後のテストを消すと空の「テスト 1」を作る', () => {
    const sets = [];
    const words = [];
    const a = createSet(sets, '中間'), b = createSet(sets, '期末');
    addWords(words, a.id, [{ en: '山', ja: 'やま' }]);
    addWords(words, b.id, [{ en: '川', ja: 'かわ' }]);
    let r = deleteSet(sets, words, a.id);
    expect(r.sets.map((s) => s.name)).toEqual(['期末']);
    expect(r.words.map((w) => w.en)).toEqual(['川']);
    expect(r.currentSet).toBe(b.id);
    r = deleteSet(r.sets, r.words, b.id);
    expect(r.sets.map((s) => s.name)).toEqual(['テスト 1']);
    expect(r.words).toEqual([]);
  });

  it('名前を空にして作ると「テスト N」になる', () => {
    const sets = [{ id: 'x', name: 'テスト 1' }];
    expect(createSet(sets, '  ').name).toBe('テスト 2');
  });
});

describe('まとまりの中の並び', () => {
  it('番号順(単語 → 過去形。番号のない語は入れた順で後ろ)。まとめたあとも番号順', () => {
    const words = [];
    const { id } = createSet([], 'x');
    addWords(words, id, [{ en: 'real', ja: '実際の', no: 105 }, { en: 'walk', ja: '歩く', no: 101 }, { en: 'ate', ja: '食べる', base: 'eat', kind: 'past', no: 1 }, { en: 'cat', ja: 'ねこ' }]);
    addWords(words, id, [{ en: 'stay', ja: 'いる', no: 102 }]);
    for (const w of words) w.photo = 1; // 写真 2 を写真 1 にまとめる
    expect(groupsOf(words, id)[0].words.map((w) => w.en)).toEqual(['walk', 'stay', 'real', 'cat', 'ate']);
  });
});
