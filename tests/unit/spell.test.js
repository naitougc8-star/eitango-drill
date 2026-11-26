import { describe, it, expect } from 'vitest';
import { checkSpelling, align, normalize, answerForms, speakText } from '../../spell.js';
import { pickVoice } from '../../speak.js';

const ops = (r) => r.ops.map((o) => o.op[0]).join('');

describe('つづりの答え合わせ', () => {
  it('合っていれば正解(大文字・小文字、前後・続いたスペースは問わない)', () => {
    expect(checkSpelling('walk', 'walk').ok).toBe(true);
    expect(checkSpelling(' Walk ', 'walk').ok).toBe(true);
    expect(checkSpelling('i  see', 'I see').ok).toBe(true);
    expect(checkSpelling('I SEE', 'I see').form).toBe('I see'); // 見せる形は答えのまま
  });

  it('iPad のスマート句読点(’)と全角の英字も、同じ字として比べる', () => {
    expect(checkSpelling('don’t', "don't").ok).toBe(true);
    expect(checkSpelling("let's", 'let’s').ok).toBe(true);
    expect(checkSpelling('ｗａｌｋ', 'walk').ok).toBe(true);
  });

  it('答えの ~ は書かなくてよく、( ) の中は書いても書かなくてもよい。/ はどれか 1 つ', () => {
    expect(checkSpelling('go', '~ go').ok).toBe(true);
    expect(checkSpelling('few', '(a) few').ok).toBe(true);
    expect(checkSpelling('a few', '(a) few').ok).toBe(true);
    expect(checkSpelling('colour', 'color / colour').ok).toBe(true);
    expect(answerForms('(a) few')).toEqual(['few', 'a few']);
  });

  it('違った字を、違う字・書き落とした字・余分な字に分けて示す', () => {
    const sub = checkSpelling('beautifel', 'beautiful');
    expect(sub.ok).toBe(false);
    expect(sub.errors).toBe(1);
    expect(ops(sub)).toBe('oooooooso');
    const miss = checkSpelling('restauran', 'restaurant');
    expect(ops(miss)).toBe('ooooooooom');
    expect(miss.ops.at(-1)).toEqual({ op: 'miss', a: 't', b: '' });
    const extra = checkSpelling('walkk', 'walk');
    expect(extra.ops.filter((o) => o.op === 'extra')).toHaveLength(1);
  });

  it('隣どうしの入れ替え(wlak)は 2 字の違いとして示し、数は 1 つ', () => {
    const r = checkSpelling('wlak', 'walk');
    expect(r.errors).toBe(2); // 2 字とも赤
    expect(ops(r)).toBe('osso');
    expect(align('receive', 'recieve').filter((o) => o.op !== 'ok')).toHaveLength(2);
  });

  it('何も書かなければ不正解(空)', () => {
    const r = checkSpelling('', 'walk');
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(true);
  });

  it('normalize と読み上げる文', () => {
    expect(normalize('  Don’t  ')).toBe("don't");
    expect(speakText('~ go / went')).toBe('go');
    expect(speakText('(a) few')).toBe('a few');
  });
});

describe('読み上げの声', () => {
  it('英語の声を選ぶ(アメリカ英語の Samantha を優先)', () => {
    const voices = [
      { name: 'Kyoko', lang: 'ja-JP' },
      { name: 'Daniel', lang: 'en-GB' },
      { name: 'Samantha', lang: 'en-US' },
    ];
    expect(pickVoice(voices).name).toBe('Samantha');
    expect(pickVoice([{ name: 'Kyoko', lang: 'ja-JP' }])).toBe(null);
    expect(pickVoice([{ name: 'X', lang: 'en_AU' }]).name).toBe('X');
  });
});

describe('読み上げの声(端末の中の声・品質)', () => {
  it('一覧にあっても端末に入っていない声は選ばず、同じ名前ならプレミアム・拡張の声を先に選ぶ', () => {
    const voices = [
      { name: 'Ava', lang: 'en-US', localService: false, voiceURI: 'Ava' },
      { name: 'Samantha', lang: 'en-US', localService: true, voiceURI: 'com.apple.voice.compact.en-US.Samantha' },
      { name: 'Samantha (Enhanced)', lang: 'en-US', localService: true, voiceURI: 'com.apple.voice.enhanced.en-US.Samantha' },
    ];
    expect(pickVoice(voices).name).toBe('Samantha (Enhanced)');
  });
});
