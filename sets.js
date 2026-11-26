// テスト(出題の範囲)ごとに語をまとめる。中間テスト・期末テストなど、テストごとに写真何枚か分の語を管理する。
// 語は setId(どのテストか)と photo(テストの中で何枚目の写真から取り込んだか)を持つ。
//   photo: 1, 2, 3 … = 写真(取り込み 1 回分)、0 = 手で追加した語
// DOM に依存しない(Node でテストできる)。

import { newId } from './util.js';

/** 保存データを読み込み、テストがなければ「テスト 1」を作って、これまでの語をすべて入れる */
export function migrate(data) {
  const sets = Array.isArray(data.sets) ? data.sets.filter((s) => s && s.id && typeof s.name === 'string') : [];
  const words = Array.isArray(data.words) ? data.words : [];
  if (!sets.length) sets.push({ id: newId(), name: 'テスト 1' });
  const ids = new Set(sets.map((s) => s.id));
  for (const w of words) {
    if (!ids.has(w.setId)) w.setId = sets[0].id;
    if (!Number.isInteger(w.photo)) w.photo = 0;
  }
  const currentSet = ids.has(data.currentSet) ? data.currentSet : sets[0].id;
  return { sets, words, currentSet };
}

/** テストの語 */
export function wordsOf(words, setId) {
  return words.filter((w) => w.setId === setId);
}

/** テストの中の写真の数(手で追加した語は数えない) */
export function photoCount(words, setId) {
  return new Set(wordsOf(words, setId).filter((w) => w.photo > 0).map((w) => w.photo)).size;
}

/** 次の写真の番号 */
export function nextPhoto(words, setId) {
  return wordsOf(words, setId).reduce((m, w) => Math.max(m, w.photo || 0), 0) + 1;
}

/** 同じ問題か(種類・英語・原形・日本語が同じ。英語の大文字・小文字は区別しない) */
export function sameEntry(a, b) {
  const k = (x) => [x.kind === 'past' ? 'past' : 'word', (x.en || '').toLowerCase(), (x.base || '').toLowerCase(), x.ja || ''].join('\u0000');
  return k(a) === k(b);
}

/**
 * 語をテストに追加する。同じテストに同じ問題があれば追加しない。
 * @param {object[]} words すべての語(書き換える)
 * @param {string} setId
 * @param {{en: string, ja?: string, kind?: 'word' | 'past', base?: string, no?: number, enabled?: boolean}[]} entries
 *   en: 答えの英語(過去形の問題は過去形)、ja: 日本語の意味、base: 過去形の問題の原形、no: プリントの番号
 * @param {'photo' | 'manual'} kind 写真 1 枚分の取り込み(新しい写真の番号を付ける)か、手で追加か
 * @returns {number} 追加した数
 */
export function addWords(words, setId, entries, kind = 'photo') {
  const photo = kind === 'manual' ? 0 : nextPhoto(words, setId);
  let added = 0;
  for (const e of entries) {
    if (!e.en) continue;
    if (words.some((w) => w.setId === setId && sameEntry(w, e))) continue;
    const past = e.kind === 'past';
    words.push({
      id: e.id || newId(),
      kind: past ? 'past' : 'word',
      en: e.en,
      ja: e.ja || '',
      ...(past ? { base: e.base || '' } : {}),
      ...(Number.isInteger(e.no) ? { no: e.no } : {}),
      enabled: e.enabled !== false,
      manual: kind === 'manual',
      result: null,
      misses: 0,
      passedAt: null,
      setId,
      photo,
      updatedAt: Date.now(), // ほかの端末のデータと合わせるときに、新しい方を残すため
    });
    added++;
  }
  return added;
}

/** 写真ごとのまとまり(写真 1, 2, … → 手で追加した語 の順) */
export function groupsOf(words, setId) {
  const map = new Map();
  for (const w of wordsOf(words, setId)) {
    const key = w.photo > 0 ? w.photo : 'manual';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }
  const rank = (k) => (k === 'manual' ? Infinity : k);
  return [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([key, list], _i, all) => ({
      key: String(key),
      // 写真の番号は、消した写真があっても 1 から詰めて表示する
      label: key === 'manual' ? '手で追加した語' : `写真 ${all.filter((g) => typeof g[0] === 'number' && g[0] <= key).length}`,
      // 番号順(単語 → 過去形の順。番号のない語は、入れた順のまま後ろ)。まとまりをまとめたときも番号順になる
      words: list
        .map((w, i) => ({ w, i }))
        .sort((a, b) => (a.w.kind === 'past') - (b.w.kind === 'past') || (a.w.no ?? Infinity) - (b.w.no ?? Infinity) || a.i - b.i)
        .map((x) => x.w),
    }));
}

/** 新しいテストを作る */
export function createSet(sets, name) {
  const set = { id: newId(), name: (name || '').trim() || `テスト ${sets.length + 1}`, updatedAt: Date.now() };
  sets.push(set);
  return set;
}

/**
 * テストを削除する(そのテストの語も消す)。テストが 1 つもなくなったら、空の「テスト 1」を作る。
 * @returns {{sets: object[], words: object[], currentSet: string}}
 */
export function deleteSet(sets, words, setId) {
  const restSets = sets.filter((s) => s.id !== setId);
  if (!restSets.length) restSets.push({ id: newId(), name: 'テスト 1' });
  return { sets: restSets, words: words.filter((w) => w.setId !== setId), currentSet: restSets[0].id };
}
