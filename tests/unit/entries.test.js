import { describe, it, expect } from 'vitest';
import { fixNumbers, parseNo, cleanEn, cleanJa, tableEntries, parsePaste } from '../../entries.js';

const nos = (a, f) => fixNumbers(a, f).map((o) => (o.no == null ? null : o.guessed ? o.no + '?' : o.no));

describe('番号を決める', () => {
  it('番号のマスの読み違い(O → 0、l → 1)を直す', () => {
    expect(parseNo('1O1')).toBe(101);
    expect(parseNo('l23')).toBe(123);
    expect(parseNo('①')).toBe(null);
  });

  it('先頭の 1 が抜けた番号(11・12)や、読めなかった番号は、前後の番号から補う', () => {
    expect(nos([114, 115, 1, 17, 18, 19, 120, 21, 122, 123, 124, 125])).toEqual(
      [114, 115, '116?', '117?', '118?', '119?', 120, '121?', 122, 123, 124, 125],
    );
    expect(nos([null, 101, 102, 103, 10, 105])).toEqual([null, 101, 102, 103, '104?', 105]);
  });

  it('見出しの行(番号なし)は使わず、番号の飛ぶ所(be 動詞の見出し)にも番号を振らない', () => {
    expect(nos([15, 16, 17, 18, 19, 20, null, null, 21, 22, 23])).toEqual([15, 16, 17, 18, 19, 20, null, null, 21, 22, 23]);
    // 見出しのすぐあとの 21 が読めなくても、22 の前の行として補う(見出しの行には振らない)
    const filled = [true, true, false, false, true, true];
    expect(nos([19, 20, null, null, 2, 22], filled)).toEqual([19, 20, null, null, '21?', 22]);
  });

  it('表の最後の、英語の入っている行は、前の番号の続きにする', () => {
    expect(nos([1, 2, 3, null], [true, true, true, true])).toEqual([1, 2, 3, '4?']);
    expect(nos([1, 2, 3, null], [true, true, true, false])).toEqual([1, 2, 3, null]);
  });
});

describe('マスの文字をきれいにする', () => {
  it('英語: マスの中で折り返した語をつなげ、端の罫線(l・|)を除く', () => {
    expect(cleanEn(['restauran', 't'])).toBe('restaurant');
    expect(cleanEn(['became l'])).toBe('became');
    expect(cleanEn(['eat )'])).toBe('eat');
    expect(cleanEn(['i ate'])).toBe('ate');
    expect(cleanEn(['(a) few'])).toBe('(a) few');
    expect(cleanEn(['I see'])).toBe('I see');
    expect(cleanEn(['don’t'])).toBe("don't");
    expect(cleanEn(['英語'])).toBe('');
  });

  it('日本語: 字の間のスペースを除き、~ を「ー」と読んだものを直す', () => {
    expect(cleanJa(['お そらく、 もしか', 'したら'])).toBe('おそらく、もしかしたら');
    expect(cleanJa(['ーですか?'])).toBe('~ですか?');
    expect(cleanJa(['ーするな、ーしない'])).toBe('~するな、~しない');
    expect(cleanJa(['(時間)一前に'])).toBe('(時間)~前に');
    expect(cleanJa(['・...*である・・...にいる'])).toBe('…である・…にいる');
    expect(cleanJa(['一番目'])).toBe('一番目'); // 文の初めの漢字の「一」はそのまま
  });
});

const cell = (text, conf = 90) => ({ lines: text ? text.split('\n') : [], text, conf });

describe('読み取った表から問題を作る', () => {
  it('単語の表: 組ごとに [番号, 英語, 日本語]。見出しの行は除き、自信のないマスに印を付ける', () => {
    const g = {
      no: [cell(''), cell('101'), cell('102'), cell('103')],
      en: [cell('pS'), cell('walk'), cell('stay'), cell('food', 40)],
      ja: [cell('日本語'), cell('歩く'), cell('いる、とどまる'), cell('食べ物')],
    };
    const r = tableEntries('word', [g]);
    expect(r.map((e) => `${e.no} ${e.en} ${e.ja}`)).toEqual(['101 walk 歩く', '102 stay いる、とどまる', '103 food 食べ物']);
    expect(r[2].check).toEqual(['en']);
    expect(r[0].kind).toBe('word');
  });

  it('過去形の表: [番号, 日本語の意味, 原形, 過去形]。前の写真と重なった番号は 1 回だけ', () => {
    const g = {
      no: [cell('15'), cell('16'), cell('')],
      ja: [cell('乗る'), cell('言う'), cell('')],
      base: [cell('ride'), cell('say'), cell('')],
      past: [cell('rode'), cell('said'), cell('')],
    };
    const r = tableEntries('past', [g, g]);
    expect(r).toEqual([
      { no: 15, en: 'rode', ja: '乗る', base: 'ride', kind: 'past', check: [] },
      { no: 16, en: 'said', ja: '言う', base: 'say', kind: 'past', check: [] },
    ]);
  });
});

describe('貼り付けた文から問題を作る', () => {
  it('単語: 番号・英語(スペースを含んでもよい)・日本語。タブ区切りも', () => {
    const r = parsePaste('101 walk 歩く\n106\tago\t(時間)~前に\n223 I see 理解を表す\nfood 食べ物', 'word');
    expect(r.map((e) => [e.no, e.en, e.ja])).toEqual([
      [101, 'walk', '歩く'],
      [106, 'ago', '(時間)~前に'],
      [223, 'I see', '理解を表す'],
      [null, 'food', '食べ物'],
    ]);
  });

  it('過去形: 番号・日本語・原形・過去形(「…である」の … を区切りとまちがえない)', () => {
    const r = parsePaste('1 食べる eat ate\n21 …である・…にいる am was\n3. 選ぶ choose chose', 'past');
    expect(r.map((e) => [e.no, e.ja, e.base, e.en])).toEqual([
      [1, '食べる', 'eat', 'ate'],
      [21, '…である・…にいる', 'am', 'was'],
      [3, '選ぶ', 'choose', 'chose'],
    ]);
  });
});
