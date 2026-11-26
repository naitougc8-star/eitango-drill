// 画面の制御: 設定(取り込み・語の一覧・出題の設定)→ 出題(通常 / フラッシュ)→ 結果
// テストのツリー・成績の色分け・フラッシュ出題・バックアップ・QR コードは、漢字書き取りドリルと同じ作り。

import { newId, loadScript } from './util.js';
import { loadImage, readTable } from './ocr.js';
import { Marker } from './marker.js';
import { parsePaste } from './entries.js';
import { checkSpelling, normalize, speakText } from './spell.js';
import { speak, canSpeak, stopSpeaking } from './speak.js';
import * as storage from './storage.js';
import { migrate, wordsOf, addWords, groupsOf, createSet, deleteSet, nextPhoto, sameEntry } from './sets.js';
import { makeBackup, backupFileName, parseBackup, mergeBackup, dataSize, formatSize, STORAGE_LIMIT } from './backup.js';
import { packBackup, unpackBackup, splitPayload, QrAssembler } from './qrsync.js';

const $ = (id) => document.getElementById(id);

const state = {
  words: [],
  sets: [], // テスト(出題の範囲)
  folders: [], // フォルダーの名前(テストの入っていない、作っただけのフォルダーも)
  currentSet: null, // 選んでいるテスト
  settings: {
    srcMode: 'word', // 取り込み方: 単語の表 / 過去形の表 / 貼り付け
    pasteKind: 'word',
    speech: 'normal', // 答えの発音: 読み上げる / ゆっくり / 読み上げない
    order: 'random', // 出題の順番: ばらばら / 番号順
    theme: 'auto',
    folds: {},
    groupFolds: [],
    drillSets: null,
    treeOpen: null,
    drillMode: 'normal',
  },
  session: null,
};

const FLASH_LABEL = { ok: 'OK', maybe: 'Maybe OK', again: 'もう一回' };
const KIND_LABEL = { word: '単語', past: '過去形' };

// ---------- 保存 ----------

function persist() {
  const ok = storage.save({ words: state.words, sets: state.sets, folders: state.folders, currentSet: state.currentSet, settings: state.settings });
  if (!ok && !persist.warned) {
    persist.warned = true;
    showMessage('この端末に保存できませんでした(保存領域がいっぱいか、プライベートブラウズかもしれません)。「書き出す」でバックアップを取り、古いテストを削除してください。');
  }
  renderStorage();
}

/** 保存していた語を、今の形にそろえる(足りない項目は初期値) */
function cleanWord(w) {
  return {
    id: w.id || newId(),
    kind: w.kind === 'past' ? 'past' : 'word',
    en: String(w.en || ''),
    ja: String(w.ja || ''),
    ...(w.kind === 'past' ? { base: String(w.base || '') } : {}),
    ...(Number.isInteger(w.no) ? { no: w.no } : {}),
    enabled: w.enabled !== false,
    manual: !!w.manual,
    result: w.result === 'pass' || w.result === 'fail' ? w.result : null, // 最後に出題したときの結果
    misses: Number.isInteger(w.misses) ? w.misses : w.result === 'fail' ? 1 : 0, // 続けて間違えた回数
    passedAt: Number.isInteger(w.passedAt) ? w.passedAt : null, // 何回目で合格したか
    setId: w.setId,
    updatedAt: Number(w.updatedAt) || 0,
    photo: Number.isInteger(w.photo) ? w.photo : 0,
    ...(FLASH_LABEL[w.flash] ? { flash: w.flash } : {}), // フラッシュ出題で選んだもの
  };
}

function restore() {
  const saved = storage.load();
  if (saved) {
    if (Array.isArray(saved.words)) state.words = saved.words.filter((w) => w && typeof w.en === 'string').map(cleanWord);
    if (Array.isArray(saved.sets)) state.sets = saved.sets;
    if (Array.isArray(saved.folders)) state.folders = saved.folders.filter((f) => typeof f === 'string' && f);
    if (typeof saved.currentSet === 'string') state.currentSet = saved.currentSet;
    const s = saved.settings;
    if (s) {
      if (['word', 'past', 'paste'].includes(s.srcMode)) state.settings.srcMode = s.srcMode;
      if (['word', 'past'].includes(s.pasteKind)) state.settings.pasteKind = s.pasteKind;
      if (['normal', 'slow', 'off'].includes(s.speech)) state.settings.speech = s.speech;
      if (['random', 'number'].includes(s.order)) state.settings.order = s.order;
      if (['auto', 'light', 'dark'].includes(s.theme)) state.settings.theme = s.theme;
      if (s.drillMode === 'flash') state.settings.drillMode = 'flash';
      if (s.folds && typeof s.folds === 'object') {
        for (const [k, v] of Object.entries(s.folds)) if (typeof v === 'boolean') state.settings.folds[k] = v;
      }
      if (Array.isArray(s.groupFolds)) state.settings.groupFolds = s.groupFolds.filter((k) => typeof k === 'string');
      if (Array.isArray(s.drillSets)) state.settings.drillSets = s.drillSets.filter((k) => typeof k === 'string');
      if (Array.isArray(s.treeOpen)) state.settings.treeOpen = s.treeOpen.filter((k) => typeof k === 'string');
    }
  }
  const m = migrate({ sets: state.sets, words: state.words, currentSet: state.currentSet });
  state.sets = m.sets;
  state.words = m.words;
  state.currentSet = m.currentSet;
}

// ---------- メッセージ・確認の窓 ----------

function showMessage(text, kind = 'error') {
  $('message-text').textContent = text;
  $('message').className = 'message' + (kind === 'info' ? ' info' : '');
  $('message').hidden = false;
}

function hideMessage() {
  $('message').hidden = true;
}

/**
 * 確認の窓(OK / キャンセル)。input に文字を渡すと、名前の入力欄も出す。choices を渡すと、選ぶ欄を出す。
 * ブラウザの confirm / prompt は、iPad の Safari で「このページのダイアログを表示しない」を選ぶと、
 * 何も聞かずにキャンセルになるので使わない。
 * @returns {Promise<boolean | string | null>}
 */
function ask(text, input = null, choices = null) {
  const dlg = $('ask');
  const select = $('ask-select');
  const field = choices ? select : $('ask-input');
  $('ask-text').textContent = text;
  $('ask-input').hidden = input === null || !!choices;
  select.hidden = !choices;
  select.textContent = '';
  for (const c of choices || []) {
    const o = document.createElement('option');
    o.value = c.value;
    o.textContent = c.label;
    select.appendChild(o);
  }
  field.value = input ?? '';
  return new Promise((resolve) => {
    const done = (ok) => {
      dlg.removeEventListener('close', onClose);
      $('ask-cancel').onclick = null;
      if (dlg.open) dlg.close();
      resolve(input === null && !choices ? ok : ok ? field.value : null);
    };
    const onClose = () => done(dlg.returnValue === 'ok');
    dlg.returnValue = '';
    dlg.addEventListener('close', onClose);
    $('ask-cancel').onclick = () => done(false);
    dlg.showModal();
    if (choices) select.focus();
    else if (input !== null) {
      field.focus();
      field.select();
    } else $('ask-ok').focus();
  });
}

function showScreen(name) {
  for (const s of ['setup', 'drill', 'flash', 'result']) $('screen-' + s).hidden = s !== name;
  globalThis.scrollTo?.(0, 0);
}

// ---------- 1. 取り込み ----------

let marker = null;
/** 読み取った(貼り付けた)問題の確認表 { entries, source: 'photo' | 'paste', mode } */
let review = null;

function setSrcMode(mode) {
  state.settings.srcMode = mode;
  for (const r of document.querySelectorAll('input[name="src-mode"]')) r.checked = r.value === mode;
  $('mode-photo').hidden = mode === 'paste';
  $('mode-paste').hidden = mode !== 'paste';
  $('photo-hint').innerHTML =
    mode === 'past'
      ? '動詞の過去形の練習リスト(<strong>番号・日本語の意味・原形・過去形</strong>の表)を撮影して選び、表を指か Apple Pencil で<strong>四角く囲んで</strong>' +
        '「読み取る」を押してください(囲まなければ写真全体を表として読みます)。出題は「原形 → 過去形」です。be 動詞のように、意味のマスが何行かにまたがっていても読めます。'
      : '単語テスト範囲のプリント(<strong>番号・英語・日本語</strong>の組が並んだ表)を撮影して選び、表を指か Apple Pencil で<strong>四角く囲んで</strong>' +
        '「読み取る」を押してください(囲まなければ写真全体を表として読みます)。罫線から 1 マスずつ読み取ります。' +
        '写真が何枚かあるときは、1 枚ずつ読み取って追加してください(前の写真と重なった行は、番号を見て外します)。';
}

async function onPhotoSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 同じ写真をもう一度選べるように
  if (!file) return;
  hideMessage();
  $('photo-status').textContent = '写真を読み込んでいます…';
  try {
    const img = await loadImage(file);
    $('marker-box').hidden = false;
    $('marker-tools').hidden = false;
    marker.setImage(img);
    $('btn-read').disabled = false;
    $('photo-status').textContent = `${file.name || '写真'}(${img.naturalWidth}×${img.naturalHeight})`;
    $('read-status').textContent = '表を四角く囲んで(囲まなければ写真全体)、「読み取る」を押してください。';
  } catch (err) {
    $('photo-status').textContent = '';
    showMessage(err.message || String(err));
  }
}

async function onRead() {
  if (!marker || !marker.src) return;
  hideMessage();
  const mode = state.settings.srcMode === 'past' ? 'past' : 'word';
  const src = marker.src;
  const rect = marker.box && marker.box.w > 20 && marker.box.h > 20 ? marker.box : { x: 0, y: 0, w: src.width, h: src.height };
  $('btn-read').disabled = true;
  try {
    const r = await readTable(src, rect, mode, { onProgress: (t) => ($('read-status').textContent = t) });
    if (!r.entries.length) {
      $('read-status').textContent = '';
      showMessage('問題を読み取れませんでした。表だけを四角く囲んで、もう一度「読み取る」を押してください(「貼り付け・入力」で入れることもできます)。');
      return;
    }
    $('read-status').textContent = `${r.entries.length} 問を読み取りました。下の表で確かめてください。`;
    showReview(r.entries, 'photo', mode);
  } catch (err) {
    $('read-status').textContent = '';
    showMessage(`読み取れませんでした(${err.message || err})。「貼り付け・入力」で入れることもできます。`);
  } finally {
    $('btn-read').disabled = false;
  }
}

function onPaste() {
  hideMessage();
  const mode = state.settings.pasteKind;
  const entries = parsePaste($('paste').value, mode);
  if (!entries.length) {
    showMessage(mode === 'past' ? '「1 食べる eat ate」の形で、1 行に 1 問ずつ書いてください。' : '「101 walk 歩く」の形で、1 行に 1 問ずつ書いてください。');
    return;
  }
  showReview(entries, 'paste', mode);
}

/** このテストにもう入っている問題か(同じ種類で番号が同じか、問題が同じ) */
function alreadyIn(e) {
  return wordsOf(state.words, state.currentSet).some((w) => (w.kind || 'word') === e.kind && ((e.no != null && w.no === e.no) || sameEntry(w, e)));
}

function showReview(entries, source, mode) {
  review = { source, mode, entries: entries.map((e) => ({ ...e, use: !alreadyIn(e) })) };
  renderReview();
  $('review').hidden = false;
  $('review').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
}

/** 確認表の 1 マス(直せる入力欄) */
function reviewInput(e, key, label, opts = {}) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.value = e[key] ?? '';
  inp.setAttribute('aria-label', label);
  inp.autocomplete = 'off';
  if (opts.en) {
    inp.lang = 'en';
    inp.setAttribute('autocapitalize', 'off');
    inp.setAttribute('autocorrect', 'off');
    inp.spellcheck = false;
  }
  if (opts.no) inp.inputMode = 'numeric';
  if (e.check.includes(key === 'en' ? 'en' : key)) td.classList.add('check');
  inp.addEventListener('change', () => {
    const v = inp.value.trim();
    e[key] = opts.no ? (/^\d+$/.test(v) ? Number(v) : null) : v;
    td.classList.remove('check'); // 直した(確かめた)
  });
  td.appendChild(inp);
  return td;
}

function renderReview() {
  const past = review.mode === 'past';
  const head = $('review-table').querySelector('thead');
  head.innerHTML = `<tr><th>追加</th><th>番号</th>${past ? '<th>日本語の意味</th><th>原形</th><th>過去形</th>' : '<th>英語</th><th>日本語</th>'}</tr>`;
  const body = $('review-table').querySelector('tbody');
  body.textContent = '';
  review.entries.forEach((e, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = i;
    if (!e.use) tr.classList.add('off');
    const c0 = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.use;
    cb.setAttribute('aria-label', `${e.no ?? ''} ${e.en} を追加する`);
    cb.addEventListener('change', () => {
      e.use = cb.checked;
      tr.classList.toggle('off', !e.use);
      updateReviewCount();
    });
    c0.appendChild(cb);
    if (alreadyIn(e)) {
      const note = document.createElement('span');
      note.className = 'already';
      note.textContent = 'もうある';
      c0.appendChild(note);
    }
    tr.appendChild(c0);
    tr.appendChild(reviewInput(e, 'no', '番号', { no: true }));
    if (past) {
      tr.appendChild(reviewInput(e, 'ja', '日本語の意味'));
      tr.appendChild(reviewInput(e, 'base', '原形', { en: true }));
      tr.appendChild(reviewInput(e, 'en', '過去形', { en: true }));
    } else {
      tr.appendChild(reviewInput(e, 'en', '英語', { en: true }));
      tr.appendChild(reviewInput(e, 'ja', '日本語', {}));
    }
    tr.querySelector('td:nth-child(2) input').classList.add('no-input');
    body.appendChild(tr);
  });
  updateReviewCount();
}

function updateReviewCount() {
  const n = review.entries.filter((e) => e.use).length;
  $('btn-review-add').textContent = `チェックした ${n} 語を一覧に追加`;
  $('btn-review-add').disabled = n === 0;
}

function onReviewAdd() {
  if (!review) return;
  const list = review.entries.filter((e) => e.use && e.en && e.en.trim());
  const photo = nextPhoto(state.words, state.currentSet);
  const added = addWords(state.words, state.currentSet, list.map((e) => ({ ...e, en: e.en.trim(), ja: (e.ja || '').trim() })), 'photo');
  // 貼り付けたまとまりは「貼り付け」と呼ぶ(写真のまとまりは「写真 1」など)
  if (added && review.source === 'paste') {
    const set = state.sets.find((s) => s.id === state.currentSet);
    const n = Object.values(set.groupNames || {}).filter((v) => /^貼り付け/.test(v)).length;
    set.groupNames = { ...(set.groupNames || {}), [photo]: n ? `貼り付け ${n + 1}` : '貼り付け' };
    set.updatedAt = Date.now();
  }
  persist();
  renderWordList();
  $('review-status').textContent = '';
  $('read-status').textContent = '';
  closeReview();
  showMessage(added ? `「${currentSetName()}」に ${added} 語を追加しました。` : 'このテストに新しく追加する語はありませんでした(同じ問題がもう入っています)。', 'info');
}

function closeReview() {
  review = null;
  $('review').hidden = true;
  $('review-table').querySelector('tbody').textContent = '';
}

// ---------- 2. 語の一覧 ----------

/** 語の一覧に出すテスト: チェックを入れたテストと、選んでいるテスト(ツリーと同じ順) */
function listSets() {
  const ids = new Set([...drillSetIds(), state.currentSet]);
  return state.sets.filter((s) => ids.has(s.id));
}

function listWords() {
  const ids = new Set(listSets().map((s) => s.id));
  return state.words.filter((w) => ids.has(w.setId));
}

function renderWordList() {
  renderSets();
  const box = $('word-list');
  box.textContent = '';
  const sets = listSets();
  const drill = new Set(drillSetIds());
  for (const set of sets) {
    if (sets.length > 1) box.append(setHead(set, drill.has(set.id)));
    for (const g of groupsOf(state.words, set.id)) {
      box.append(groupHead(g, set));
      const ul = document.createElement('ul');
      ul.dataset.group = g.key;
      ul.dataset.set = set.id;
      ul.hidden = groupClosed(set, g.key);
      for (const w of g.words) ul.appendChild(wordRow(w));
      box.appendChild(ul);
    }
  }
  updateCount();
}

function setHead(set, inDrill) {
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'set-head' + (set.id === state.currentSet ? ' current' : '');
  head.dataset.set = set.id;
  const n = wordsOf(state.words, set.id).length;
  head.textContent = `${set.folder ? `📁 ${set.folder} / ` : ''}${set.name}(${n} 語)${inDrill ? '' : ' … チェックが入っていないので、出題しません'}`;
  head.title = 'タップして、このテストを選ぶ(取り込んだ語を入れるテスト)';
  head.addEventListener('click', () => selectSet(set.id));
  return head;
}

function groupFoldKey(set, groupKey) {
  return `${set.id}:${groupKey}`;
}

function groupClosed(set, groupKey) {
  return state.settings.groupFolds.includes(groupFoldKey(set, groupKey));
}

/** 写真ごとのまとまりの見出し(開け閉め、まとめて出題する・しない、まとめて削除) */
function groupHead(g, set) {
  const head = document.createElement('div');
  head.className = 'group-head';
  head.dataset.group = g.key;
  head.dataset.set = set.id;
  const label = groupLabelOf(set, g);
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'gname';
  name.textContent = label;
  name.title = 'タップして名前を変える(12 文字まで)';
  name.addEventListener('click', () => renameGroup(g, set));
  const count = document.createElement('span');
  count.className = 'gcount';
  count.textContent = `${g.words.length} 問`;
  const stats = statsView(g.words, true);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn small greset';
  reset.textContent = '成績をリセット';
  reset.disabled = stats.count.none === stats.total;
  reset.addEventListener('click', async () => {
    if (!(await ask(`「${label}」の合格・不合格の記録を消しますか?`))) return;
    resetResults(g.words);
  });
  const on = document.createElement('label');
  on.className = 'check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = g.words.every((w) => w.enabled);
  cb.indeterminate = !cb.checked && g.words.some((w) => w.enabled);
  cb.setAttribute('aria-label', `${label}の語をまとめて出題する`);
  cb.addEventListener('change', () => {
    setEnabled(g.words, cb.checked);
    syncDrill([set.id]);
    persist();
    renderWordList();
  });
  const t = document.createElement('span');
  t.textContent = '出題する';
  on.append(cb, t);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn small';
  del.textContent = 'まとめて削除';
  del.addEventListener('click', async () => {
    if (!(await ask(`「${label}」の ${g.words.length} 問を、このテストから削除しますか?`))) return;
    const ids = new Set(g.words.map((w) => w.id));
    state.words = state.words.filter((w) => !ids.has(w.id));
    persist();
    renderWordList();
  });
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'gfold';
  const open = !groupClosed(set, g.key);
  fold.setAttribute('aria-expanded', open ? 'true' : 'false');
  fold.setAttribute('aria-label', `${label}の語を${open ? '閉じる' : '開く'}`);
  fold.addEventListener('click', () => {
    const key = groupFoldKey(set, g.key);
    const closed = new Set(state.settings.groupFolds);
    if (closed.has(key)) closed.delete(key);
    else closed.add(key);
    state.settings.groupFolds = [...closed];
    persist();
    renderWordList();
  });
  const title = document.createElement('span');
  title.className = 'gtitle';
  title.append(name, count);
  head.append(title, stats.box, reset, on);
  if (groupsOf(state.words, set.id).length > 1) head.append(mergeButton(g, set));
  head.append(del, fold);
  return head;
}

/** 「まとめる」ボタン(このまとまりの語を、同じテストのほかのまとまりへ移す) */
function mergeButton(g, set) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small gmerge';
  b.textContent = 'まとめる';
  b.setAttribute('aria-label', `「${groupLabelOf(set, g)}」をほかのまとまりにまとめる`);
  b.addEventListener('click', () => mergeGroup(g, set));
  return b;
}

/**
 * まとまりを、同じテストのほかのまとまりにまとめる。語(成績も)はそのまま移し、移した先では番号順に並ぶ。
 * 移したあとの、空になったまとまりの名前は消す。
 */
async function mergeGroup(g, set) {
  const others = groupsOf(state.words, set.id).filter((x) => x.key !== g.key);
  if (!others.length) return;
  const choices = others.map((x) => ({ value: x.key, label: `${groupLabelOf(set, x)}(${x.words.length} 問)` }));
  const to = await ask(`「${groupLabelOf(set, g)}」の ${g.words.length} 問を、どのまとまりにまとめますか?(成績はそのまま。まとめたあとは番号順に並びます)`, choices[0].value, choices);
  if (to === null) return;
  const fromName = groupLabelOf(set, g), toName = groupLabelOf(set, others.find((x) => x.key === to));
  const photo = to === 'manual' ? 0 : Number(to);
  const now = Date.now();
  for (const w of g.words) {
    w.photo = photo;
    w.manual = photo === 0;
    w.updatedAt = now;
  }
  if (set.groupNames && set.groupNames[g.key]) {
    set.groupNames = { ...set.groupNames };
    delete set.groupNames[g.key];
  }
  set.updatedAt = now;
  hideMessage();
  persist();
  renderWordList();
  showMessage(`「${fromName}」を「${toName}」にまとめました。`, 'info');
}

function groupLabelOf(set, g) {
  return (set && set.groupNames && set.groupNames[g.key]) || g.label;
}

const GROUP_NAME_MAX = 12;

async function renameGroup(g, set) {
  if (!set) return;
  const input = await ask(`「${groupLabelOf(set, g)}」の新しい名前(${GROUP_NAME_MAX} 文字まで。空にすると「${g.label}」に戻ります)`, groupLabelOf(set, g));
  if (input === null) return;
  const name = input.trim();
  if ([...name].length > GROUP_NAME_MAX) {
    showMessage(`名前は ${GROUP_NAME_MAX} 文字までです(いまは ${[...name].length} 文字)。`);
    return;
  }
  hideMessage();
  set.groupNames = { ...(set.groupNames || {}) };
  if (!name || name === g.label) delete set.groupNames[g.key];
  else set.groupNames[g.key] = name;
  set.updatedAt = Date.now();
  persist();
  renderWordList();
}

function resetResults(words) {
  for (const w of words) {
    w.result = null;
    w.misses = 0;
    w.passedAt = null;
    delete w.flash;
    w.updatedAt = Date.now();
  }
  persist();
  renderWordList();
}

function rowClass(w) {
  return [w.enabled ? '' : 'off', `res-${statusOf(w)}`, `kind-${w.kind}`].join(' ').trim();
}

/** 語の一覧の入力欄(変えたら保存する) */
function fieldInput(w, key, cls, label, opts = {}) {
  const inp = document.createElement('input');
  inp.className = cls;
  inp.value = w[key] ?? '';
  inp.setAttribute('aria-label', label);
  inp.autocomplete = 'off';
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (opts.en) {
    inp.lang = 'en';
    inp.setAttribute('autocapitalize', 'off');
    inp.setAttribute('autocorrect', 'off');
    inp.spellcheck = false;
  }
  if (opts.no) inp.inputMode = 'numeric';
  inp.addEventListener('change', () => {
    const v = inp.value.trim();
    if (opts.no) {
      if (/^\d+$/.test(v)) w.no = Number(v);
      else delete w.no;
    } else w[key] = v;
    w.updatedAt = Date.now();
    persist();
    renderWordList();
  });
  return inp;
}

function wordRow(w) {
  const li = document.createElement('li');
  li.className = rowClass(w);
  li.dataset.id = w.id;
  li.dataset.word = w.en;
  li.dataset.result = statusOf(w);

  const on = document.createElement('label');
  on.className = 'on';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = w.enabled;
  cb.setAttribute('aria-label', `「${w.en}」を出題する`);
  cb.addEventListener('change', () => {
    w.enabled = cb.checked;
    w.updatedAt = Date.now();
    li.className = rowClass(w);
    syncDrill([w.setId]);
    persist();
    renderSets();
    updateCount();
  });
  on.appendChild(cb);

  const no = fieldInput(w, 'no', 'no', '番号', { no: true, placeholder: '番号' });
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn del';
  del.textContent = '×';
  del.setAttribute('aria-label', `「${w.en}」を一覧から消す`);
  del.addEventListener('click', async () => {
    if (!(await ask(`「${w.kind === 'past' ? `${w.base} → ${w.en}` : w.en}」(${w.ja || '意味なし'})を一覧から消しますか? 成績も消えます。`))) return;
    state.words = state.words.filter((x) => x !== w);
    persist();
    renderWordList();
  });
  const fields = document.createElement('span');
  fields.className = 'fields';
  if (w.kind === 'past') {
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    fields.append(fieldInput(w, 'base', 'w base', '原形', { en: true, placeholder: '原形' }), arrow, fieldInput(w, 'en', 'w', '過去形', { en: true, placeholder: '過去形' }));
  } else {
    fields.append(fieldInput(w, 'en', 'w', '英語', { en: true, placeholder: '英語' }));
  }
  fields.append(fieldInput(w, 'ja', 'r', `「${w.en}」の日本語の意味`, { placeholder: '日本語の意味' }));
  li.append(on, no, fields, del);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.appendChild(resultBadge(w));
  if (w.flash) {
    const f = document.createElement('span');
    f.className = `flash-tag ${w.flash}`;
    f.textContent = `⚡ ${FLASH_LABEL[w.flash]}`;
    f.title = 'フラッシュ出題で選んだもの';
    meta.appendChild(f);
  }
  if (w.kind === 'past') {
    const k = document.createElement('span');
    k.className = 'kind-tag past';
    k.textContent = KIND_LABEL.past;
    meta.appendChild(k);
  }
  const say = document.createElement('button');
  say.type = 'button';
  say.className = 'btn small btn-say';
  say.textContent = '🔊';
  say.setAttribute('aria-label', `「${w.en}」の発音を聞く`);
  say.addEventListener('click', () => speak(w.en, { rate: state.settings.speech === 'slow' ? 'slow' : 'normal' }));
  meta.appendChild(say);
  li.appendChild(meta);
  const why = unplayableReason(w);
  if (why) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = why;
    li.appendChild(warn);
  }
  return li;
}

// 色分けの区分: 合格(緑)・1 回まちがい(黄)・2 回まちがい(オレンジ)・3 回以上まちがい(赤)・未出題(灰)
const STATUS_ORDER = ['pass', 'fail1', 'fail2', 'fail3', 'none'];
const STATUS_LABEL = { pass: '○ 合格', fail1: '× 1 回まちがい', fail2: '× 2 回まちがい', fail3: '× 3 回以上', none: '未出題' };

function statusOf(w) {
  if (w.result === 'pass') return 'pass';
  if (w.result === 'fail') return w.misses >= 3 ? 'fail3' : w.misses === 2 ? 'fail2' : 'fail1';
  return 'none';
}

function statusText(w) {
  const s = statusOf(w);
  if (s === 'pass') return w.passedAt ? `○ ${w.passedAt} 回目で合格` : '○ 合格';
  if (s === 'none') return '未出題';
  return `× ${w.misses || 1} 回まちがい`;
}

function resultBadge(w) {
  const b = document.createElement('span');
  b.className = `res ${statusOf(w)}`;
  b.textContent = statusText(w);
  return b;
}

/** 出題の結果を語に記録する(保存される) */
function recordResult(w, pass) {
  w.updatedAt = Date.now();
  if (pass) {
    if (w.result !== 'pass') w.passedAt = (w.misses || 0) + 1;
    w.misses = 0;
    w.result = 'pass';
  } else {
    w.misses = (w.result === 'fail' ? w.misses || 1 : 0) + 1;
    w.result = 'fail';
  }
}

/** 出題できない理由(出題できるなら空) */
function unplayableReason(w) {
  if (!normalize(w.en)) return '英語が入っていないので出題しません';
  if (w.kind === 'past' ? !w.base && !w.ja : !w.ja) return w.kind === 'past' ? '原形か日本語の意味を入れてください(出題しません)' : '日本語の意味が入っていないので出題しません';
  return '';
}

function canPlay(w) {
  return !unplayableReason(w);
}

function setDrill(setId, on) {
  const next = new Set(drillSetIds());
  if (on) next.add(setId);
  else next.delete(setId);
  state.settings.drillSets = state.sets.map((s) => s.id).filter((id) => next.has(id));
}

function setEnabled(words, on) {
  for (const w of words) {
    w.enabled = on;
    w.updatedAt = Date.now();
  }
}

/** テストのチェックを入れる・外す(中の写真・語にも、すべて入れる・外す) */
function checkSet(setId, on) {
  setEnabled(wordsOf(state.words, setId), on);
  setDrill(setId, on);
}

/** 写真・語のチェックを変えたあとに、テストのチェックを合わせる */
function syncDrill(setIds) {
  for (const id of setIds) setDrill(id, state.words.some((w) => w.setId === id && w.enabled));
}

function drillSetIds() {
  const stored = state.settings.drillSets;
  if (!Array.isArray(stored)) return [state.currentSet];
  const ids = new Set(state.sets.map((s) => s.id));
  const list = stored.filter((id) => ids.has(id));
  return !list.length && stored.length ? [state.currentSet] : list;
}

function playable() {
  const ids = new Set(drillSetIds());
  return state.words.filter((w) => ids.has(w.setId) && w.enabled && canPlay(w));
}

function drillTitle() {
  const names = state.sets.filter((s) => drillSetIds().includes(s.id)).map((s) => s.name);
  if (!names.length) return '';
  return names.length === 1 ? `「${names[0]}」` : `「${names[0]}」ほか ${names.length - 1} 件`;
}

function currentSetName() {
  const set = state.sets.find((x) => x.id === state.currentSet);
  return set ? set.name : '';
}

/**
 * テストのツリー。
 * テスト: [開け閉め][出題するチェック][名前(タップで選ぶ)][語の数] → 写真ごとのまとまり: [出題するチェック][名前][問の数]
 */
function renderSets() {
  const tree = $('set-tree');
  tree.textContent = '';
  const drill = new Set(drillSetIds());
  const cur = state.sets.find((s) => s.id === state.currentSet);
  const open = new Set(state.settings.treeOpen || [state.currentSet, ...(cur && cur.folder ? [folderKey(cur.folder)] : [])]);
  const folders = new Map();
  for (const set of state.sets) {
    let parent = tree;
    if (set.folder) {
      if (!folders.has(set.folder)) folders.set(set.folder, folderNode(set.folder, tree, drill, open));
      parent = folders.get(set.folder);
    }
    const words = wordsOf(state.words, set.id);
    const li = document.createElement('li');
    li.className = 'tree-set' + (set.id === state.currentSet ? ' current' : '');
    li.dataset.set = set.id;
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-expanded', open.has(set.id) ? 'true' : 'false');
    const row = document.createElement('div');
    row.className = 'tree-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.textContent = open.has(set.id) ? '▼' : '▶';
    toggle.setAttribute('aria-label', `「${set.name}」の写真を${open.has(set.id) ? '閉じる' : '開く'}`);
    toggle.addEventListener('click', () => {
      if (open.has(set.id)) open.delete(set.id);
      else open.add(set.id);
      state.settings.treeOpen = [...open];
      persist();
      renderSets();
    });
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tree-check';
    check.checked = drill.has(set.id);
    check.setAttribute('aria-label', `「${set.name}」から出題する`);
    check.addEventListener('change', () => {
      checkSet(set.id, check.checked);
      persist();
      renderWordList();
    });
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tree-name';
    name.textContent = set.name;
    name.setAttribute('aria-current', set.id === state.currentSet ? 'true' : 'false');
    name.title = 'タップして、このテストを選ぶ(下の一覧で直す・取り込んだ語を入れる)';
    name.addEventListener('click', () => selectSet(set.id));
    const count = document.createElement('span');
    count.className = 'tree-count';
    count.textContent = `(${words.length} 語)`;
    row.append(toggle, check, name, count);
    li.appendChild(row);
    if (open.has(set.id)) {
      const ul = document.createElement('ul');
      ul.className = 'tree-groups';
      ul.setAttribute('role', 'group');
      for (const g of groupsOf(state.words, set.id)) {
        const gl = document.createElement('li');
        gl.className = 'tree-group';
        gl.dataset.group = g.key;
        // [出題するチェック][名前(タップで名前を変える)][問の数][まとめる]
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = g.words.every((w) => w.enabled);
        cb.indeterminate = !cb.checked && g.words.some((w) => w.enabled);
        cb.setAttribute('aria-label', `「${groupLabelOf(set, g)}」から出題する`);
        cb.addEventListener('change', () => {
          setEnabled(g.words, cb.checked);
          syncDrill([set.id]);
          persist();
          renderWordList();
        });
        label.append(cb);
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'tree-gname';
        t.textContent = groupLabelOf(set, g);
        t.title = 'タップして名前を変える(12 文字まで)';
        t.addEventListener('click', () => renameGroup(g, set));
        const n = document.createElement('span');
        n.className = 'tree-count';
        n.textContent = `(${g.words.length} 問)`;
        gl.append(label, t, n);
        if (groupsOf(state.words, set.id).length > 1) gl.append(mergeButton(g, set));
        ul.appendChild(gl);
      }
      if (!ul.children.length) {
        const empty = document.createElement('li');
        empty.className = 'tree-empty';
        empty.textContent = 'まだ語がありません';
        ul.appendChild(empty);
      }
      li.appendChild(ul);
    }
    parent.appendChild(li);
  }
  for (const name of state.folders) if (!folders.has(name)) folderNode(name, tree, drill, open);
  $('set-name-inline').textContent = listSets().map((s) => `「${s.name}」`).join('');
  renderStorage();
}

function folderKey(name) {
  return `folder:${name}`;
}

/** フォルダーの行を tree に足し、中のテストを入れる ul を返す */
function folderNode(name, tree, drill, open) {
  const sets = state.sets.filter((s) => s.folder === name);
  const nWords = state.words.filter((w) => sets.some((s) => s.id === w.setId)).length;
  const key = folderKey(name);
  const isOpen = open.has(key);
  const li = document.createElement('li');
  li.className = 'tree-folder';
  li.dataset.folder = name;
  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  const row = document.createElement('div');
  row.className = 'tree-row';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.textContent = isOpen ? '▼' : '▶';
  toggle.setAttribute('aria-label', `フォルダー「${name}」を${isOpen ? '閉じる' : '開く'}`);
  toggle.addEventListener('click', () => {
    const next = new Set(state.settings.treeOpen || [...open]);
    if (isOpen) next.delete(key);
    else next.add(key);
    state.settings.treeOpen = [...next];
    persist();
    renderSets();
  });
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'tree-check';
  const on = sets.filter((s) => drill.has(s.id)).length;
  check.checked = on === sets.length;
  check.indeterminate = on > 0 && on < sets.length;
  check.setAttribute('aria-label', `フォルダー「${name}」のテストから出題する`);
  check.disabled = !sets.length;
  if (!sets.length) check.checked = false;
  check.addEventListener('change', () => {
    for (const s of sets) checkSet(s.id, check.checked);
    persist();
    renderWordList();
  });
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'tree-name tree-folder-name';
  nameBtn.textContent = `📁 ${name}`;
  nameBtn.title = 'タップして、フォルダーの名前を変える';
  nameBtn.addEventListener('click', () => renameFolder(name));
  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = `(テスト ${sets.length} 件・${nWords} 語)`;
  row.append(toggle, check, nameBtn, count);
  li.appendChild(row);
  const ul = document.createElement('ul');
  ul.className = 'tree-folder-sets';
  ul.setAttribute('role', 'group');
  if (isOpen) li.appendChild(ul);
  tree.appendChild(li);
  return ul;
}

const FOLDER_NAME_MAX = 20;

function folderNames() {
  return [...new Set([...state.folders, ...state.sets.map((s) => s.folder).filter(Boolean)])];
}

async function onFolderNew() {
  const input = await ask(`新しいフォルダーの名前(${FOLDER_NAME_MAX} 文字まで。例: 2学期中間テスト)`, '');
  if (input === null) return;
  const name = input.trim();
  if (!name) return;
  if ([...name].length > FOLDER_NAME_MAX) {
    showMessage(`フォルダーの名前は ${FOLDER_NAME_MAX} 文字までです。`);
    return;
  }
  if (folderNames().includes(name)) {
    showMessage(`「${name}」というフォルダーは、もうあります。`);
    return;
  }
  hideMessage();
  state.folders = [...state.folders, name];
  state.settings.treeOpen = [...new Set([...(state.settings.treeOpen || [state.currentSet]), folderKey(name)])];
  persist();
  renderWordList();
}

async function onSetFolder() {
  const set = state.sets.find((s) => s.id === state.currentSet);
  if (!set) return;
  const names = folderNames();
  if (!names.length) {
    showMessage('先に「フォルダーを作る」で、フォルダーを作ってください。');
    return;
  }
  const choices = names.map((n) => ({ value: n, label: `📁 ${n}` }));
  if (set.folder) choices.push({ value: '', label: '(フォルダーから出す)' });
  const name = await ask(`「${set.name}」を入れるフォルダーを選んでください`, set.folder || names[0], choices);
  if (name === null) return;
  hideMessage();
  if (name) set.folder = name;
  else delete set.folder;
  set.updatedAt = Date.now();
  if (name) state.settings.treeOpen = [...new Set([...(state.settings.treeOpen || [state.currentSet]), folderKey(name)])];
  persist();
  renderWordList();
}

async function renameFolder(old) {
  const input = await ask(`フォルダー「${old}」の新しい名前(${FOLDER_NAME_MAX} 文字まで。空にするとフォルダーをなくします。中のテストはそのまま残ります)`, old);
  if (input === null) return;
  const name = input.trim();
  if ([...name].length > FOLDER_NAME_MAX) {
    showMessage(`フォルダーの名前は ${FOLDER_NAME_MAX} 文字までです。`);
    return;
  }
  hideMessage();
  for (const s of state.sets) {
    if (s.folder !== old) continue;
    if (name) s.folder = name;
    else delete s.folder;
    s.updatedAt = Date.now();
  }
  state.folders = [...new Set(state.folders.map((f) => (f === old ? name : f)).filter(Boolean))];
  if (state.settings.treeOpen) {
    state.settings.treeOpen = state.settings.treeOpen.map((k) => (k === folderKey(old) && name ? folderKey(name) : k)).filter((k) => k !== folderKey(old));
  }
  persist();
  renderWordList();
}

function selectSet(id) {
  if (id === state.currentSet) return;
  state.currentSet = id;
  const open = new Set(state.settings.treeOpen || []);
  open.add(id);
  state.settings.treeOpen = [...open];
  if (review) renderReview(); // 「もうある」の印を、選んだテストで付け直す
  persist();
  renderWordList();
}

async function onSetNew() {
  const name = await ask('新しいテストの名前(例: 1 学期 中間テスト)', `テスト ${state.sets.length + 1}`);
  if (name === null) return;
  const set = createSet(state.sets, name);
  state.currentSet = set.id;
  state.settings.drillSets = [set.id]; // 新しいテストから出題する(ほかのテストのチェックは外す)
  state.settings.treeOpen = [...new Set([...(state.settings.treeOpen || []), set.id])];
  if (review) renderReview();
  persist();
  renderWordList();
}

async function onSetRename() {
  const set = state.sets.find((x) => x.id === state.currentSet);
  const name = await ask('テストの名前', set.name);
  if (name === null || !name.trim()) return;
  set.name = name.trim();
  set.updatedAt = Date.now();
  persist();
  renderWordList();
}

/** チェックを入れたテスト(チェックを入れたフォルダーは、中のテストごと)を削除する */
async function onSetDelete() {
  const drill = new Set(drillSetIds());
  const targets = state.sets.filter((s) => drill.has(s.id));
  if (!targets.length) {
    showMessage('削除するテスト(またはフォルダー)にチェックを入れてください。');
    return;
  }
  const folders = folderNames().filter((f) => {
    const inside = state.sets.filter((s) => s.folder === f);
    return inside.length && inside.every((s) => drill.has(s.id));
  });
  const ids = new Set(targets.map((s) => s.id));
  const nWords = state.words.filter((w) => ids.has(w.setId)).length;
  const lines = [
    ...folders.map((f) => `📁「${f}」(中のテスト ${state.sets.filter((s) => s.folder === f).length} 件ごと)`),
    ...targets.filter((s) => !folders.includes(s.folder)).map((s) => `「${s.name}」`),
  ];
  const ok = await ask(`チェックを入れた ${lines.join('、')} を削除しますか? テスト ${targets.length} 件・${nWords} 語(成績も)が消えます。元に戻せません。`);
  if (!ok) return;
  hideMessage();
  let sets = state.sets, words = state.words, currentSet = state.currentSet;
  for (const s of targets) ({ sets, words, currentSet } = deleteSet(sets, words, s.id));
  state.sets = sets;
  state.words = words;
  state.currentSet = state.sets.some((s) => s.id === state.currentSet) ? state.currentSet : currentSet;
  state.folders = state.folders.filter((f) => !folders.includes(f));
  state.settings.drillSets = [state.currentSet];
  if (review) renderReview();
  persist();
  renderWordList();
}

function updateCount() {
  const list = playable();
  const n = list.length;
  const wrong = list.filter((w) => w.result === 'fail').length;
  const drill = new Set(drillSetIds());
  $('word-count').textContent = `出題する語: ${n} / ${state.words.filter((w) => drill.has(w.setId)).length}`;
  const titles = drillSetIds().map((id) => state.sets.find((s) => s.id === id)).filter(Boolean).map((s) => `「${s.name}」`);
  $('drill-scope').textContent = titles.length ? `出題するテスト: ${titles.join('')}` : '出題するテストが選ばれていません(上のテストのチェックを入れてください)';
  $('btn-start').disabled = n === 0;
  $('btn-start').textContent = `全問出題する(${n} 語)`;
  $('btn-start-wrong').disabled = wrong === 0;
  $('btn-start-wrong').textContent = `不合格の語だけ出題する(${wrong} 語)`;
  const miss3 = list.filter((w) => statusOf(w) === 'fail3').length;
  $('btn-start-miss3').disabled = miss3 === 0;
  $('btn-start-miss3').textContent = `3 回以上間違えた語だけ出題する(${miss3} 語)`;
  const fresh = list.filter((w) => !w.result).length;
  $('btn-start-new').disabled = fresh === 0;
  $('btn-start-new').textContent = `未出題の語だけ出題する(${fresh} 語)`;
  const fAgain = list.filter((w) => w.flash === 'again').length;
  const fMaybe = list.filter((w) => w.flash === 'again' || w.flash === 'maybe').length;
  $('btn-flash-all').disabled = n === 0;
  $('btn-flash-all').textContent = `全問出題する(${n} 語)`;
  $('btn-flash-again').disabled = fAgain === 0;
  $('btn-flash-again').textContent = `もう一回だけ(${fAgain} 語)`;
  $('btn-flash-maybe').disabled = fMaybe === 0;
  $('btn-flash-maybe').textContent = `Maybe OK 含む(${fMaybe} 語)`;
  const sum = $('result-summary');
  sum.textContent = '';
  sum.appendChild(statsView(list).box);
  $('btn-reset-results').disabled = listWords().filter(canPlay).every((w) => statusOf(w) === 'none');
}

/**
 * 成績の表示: 区分(合格・まちがいの回数・未出題)ごとの語の数と、立体の円柱の棒グラフ、右にその区分の割合。
 * @param {object[]} words 対象の語(出題できる語だけを数える)
 * @param {boolean} compact 写真ごとのまとまりの見出しに出す、小さな表示
 */
function statsView(words, compact = false) {
  const count = Object.fromEntries(STATUS_ORDER.map((k) => [k, 0]));
  for (const w of words) if (canPlay(w)) count[statusOf(w)]++;
  const total = STATUS_ORDER.reduce((n, k) => n + count[k], 0);
  const box = document.createElement('div');
  box.className = 'stats' + (compact ? ' compact' : '');
  const rows = document.createElement('div');
  rows.className = 'stats-rows';
  for (const key of STATUS_ORDER) {
    if (key.startsWith('fail') && count[key] === 0) continue;
    const b = document.createElement('span');
    b.className = `res ${key}`;
    b.dataset.status = key;
    b.textContent = `${STATUS_LABEL[key]} ${count[key]} 語`;
    const track = document.createElement('span');
    track.className = 'cyl-track';
    if (count[key] > 0) {
      const bar = document.createElement('span');
      bar.className = `cyl ${key}`;
      bar.style.width = `${(count[key] / total) * 100}%`;
      track.appendChild(bar);
    }
    const pct = document.createElement('span');
    pct.className = `stats-pct ${key}`;
    pct.dataset.status = key;
    pct.textContent = total ? `${Math.round((count[key] / total) * 100)}%` : '—';
    rows.append(b, track, pct);
  }
  box.append(rows);
  return { box, count, total };
}

function onAddWord(e) {
  e.preventDefault();
  const kind = $('add-kind').value;
  const en = $('add-en').value.trim();
  const ja = $('add-ja').value.trim();
  const base = $('add-base').value.trim();
  const noText = $('add-no').value.trim();
  if (!en) {
    showMessage(kind === 'past' ? '過去形を入力してください。' : '英語を入力してください。');
    return;
  }
  if (kind === 'past' ? !base && !ja : !ja) {
    showMessage(kind === 'past' ? '原形を入力してください。' : '日本語の意味を入力してください。');
    return;
  }
  hideMessage();
  const entry = { kind, en, ja, ...(kind === 'past' ? { base } : {}), ...(/^\d+$/.test(noText) ? { no: Number(noText) } : {}) };
  if (!addWords(state.words, state.currentSet, [entry], 'manual')) showMessage('この問題は、このテストにもう入っています。', 'info');
  for (const id of ['add-en', 'add-ja', 'add-base', 'add-no']) $(id).value = '';
  persist();
  renderWordList();
  $(kind === 'past' ? 'add-base' : 'add-en').focus();
}

function setAddKind(kind) {
  $('add-base').hidden = kind !== 'past';
  $('add-en').placeholder = kind === 'past' ? '過去形(例: ate)' : '英語(例: walk)';
  $('add-ja').placeholder = kind === 'past' ? '日本語の意味(例: 食べる)' : '日本語の意味(例: 歩く)';
}

// ---------- 3. 出題(通常: 入力して答え合わせ) ----------

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

/** 出題の順番に並べる(番号順: 単語 → 過去形、それぞれ番号の小さい順) */
function ordered(ids) {
  if (state.settings.order !== 'number') return shuffle(ids);
  const key = (w) => [w.kind === 'past' ? 1 : 0, w.no ?? Infinity];
  return ids
    .map(wordById)
    .sort((a, b) => {
      const [ka, na] = key(a), [kb, nb] = key(b);
      return ka - kb || na - nb;
    })
    .map((w) => w.id);
}

function wordById(id) {
  return state.words.find((w) => w.id === id);
}

/** 発音を読み上げる(設定で「読み上げない」のときは何もしない。force: 🔊 ボタン) */
function say(w, force = false) {
  if (!w) return;
  if (state.settings.speech === 'off' && !force) return;
  // 過去形は「現在形, 過去形」の順に読む(例: find, found)
  const text = asksBase(w) ? `${speakText(w.base)}, ${speakText(w.en)}` : w.en;
  speak(text, { rate: state.settings.speech === 'slow' ? 'slow' : 'normal' });
}

/**
 * 出題を始める。
 * @param {'all' | 'wrong' | 'miss3' | 'new'} which
 */
function startSession(which = 'all') {
  hideMessage();
  const ids = playable()
    .filter((w) => (which === 'wrong' ? w.result === 'fail' : which === 'miss3' ? statusOf(w) === 'fail3' : which === 'new' ? !w.result : true))
    .map((w) => w.id);
  if (!ids.length) {
    showMessage({ wrong: '不合格の語はありません。', miss3: '3 回以上間違えた語はありません。', new: '未出題の語はありません。' }[which] || '出題する語がありません。');
    return;
  }
  state.session = { history: [], round: 0, title: drillTitle() };
  startRound(ids);
}

function startRound(ids) {
  const s = state.session;
  s.round++;
  s.queue = ordered(ids);
  s.index = 0;
  s.results = [];
  showScreen('drill');
  renderQuestion();
}

let current = null; // { word, judged, pass, overridden }

/** 過去形の問題で、現在形(原形)も書くか(原形が入っていないときは、過去形だけ) */
function asksBase(w) {
  return w.kind === 'past' && !!normalize(w.base);
}

function renderQuestion() {
  const s = state.session;
  const w = wordById(s.queue[s.index]);
  current = { word: w, judged: false, pass: false, overridden: false };
  $('progress').textContent = `${s.title} ${s.round} 回目 ${s.index + 1} / ${s.queue.length} 問`;
  $('screen-drill').dataset.word = w.en;
  $('screen-drill').dataset.kind = w.kind;
  $('q-no').textContent = [w.kind === 'past' ? '過去形' : '', w.no != null ? `No.${w.no}` : ''].filter(Boolean).join(' ');
  $('q-ja').textContent = w.ja || '';
  $('q-ja').classList.remove('small');
  // 過去形: 日本語の意味だけを見て、現在形と過去形を両方書く(原形がないときは、原形を見せて過去形だけ)
  const qb = $('q-base');
  qb.textContent = '';
  qb.hidden = !(w.kind === 'past' && !asksBase(w) && !w.ja);
  const two = asksBase(w);
  $('field-base').hidden = !two;
  $('answer-label').hidden = !two;
  $('answer-form').classList.toggle('two', two);
  $('answer').setAttribute('aria-label', two ? '過去形(英語)' : '答え(英語)');
  $('answer').setAttribute('enterkeyhint', 'done');
  for (const id of ['answer-base', 'answer']) {
    $(id).value = '';
    $(id).readOnly = false;
  }
  $('btn-check').hidden = false;
  $('verdict').hidden = true;
  $('btn-skip').disabled = false;
  // iPad ではキーボードが画面を隠すので、自動で入力欄にカーソルを置くのは、外付けキーボード・PC のときだけ
  if (!matchMedia('(pointer: coarse)').matches) $(two ? 'answer-base' : 'answer').focus();
}

/** 答え合わせ(入力欄で Enter / 「答え合わせ」) */
function onCheck(e) {
  e?.preventDefault();
  if (!current) return;
  if (current.judged) {
    onNext();
    return;
  }
  const w = current.word;
  // 過去形の問題: 現在形と過去形を、それぞれ確かめる(両方合っていれば正解)
  const parts = asksBase(w)
    ? [
        { label: '現在形', answer: w.base, r: checkSpelling($('answer-base').value, w.base) },
        { label: '過去形', answer: w.en, r: checkSpelling($('answer').value, w.en) },
      ]
    : [{ label: '', answer: w.en, r: checkSpelling($('answer').value, w.en) }];
  current.judged = true;
  current.pass = parts.every((p) => p.r.ok);
  for (const id of ['answer-base', 'answer']) {
    $(id).readOnly = true;
    $(id).blur();
  }
  $('btn-check').hidden = true;
  $('btn-skip').disabled = true;
  showVerdict(w, parts);
  say(w);
}

/** 1 字ずつの対応から、答えと書いたつづりを、違った字を赤で示して描く */
function spellView(part) {
  const { r, answer, label } = part;
  const box = document.createElement('div');
  box.className = 'spell-part ' + (r.ok ? 'ok' : 'ng');
  if (label) box.dataset.part = label === '現在形' ? 'base' : 'past';
  if (label) {
    const h = document.createElement('p');
    h.className = 'spell-part-title';
    h.textContent = `${label} ${r.ok ? '○' : r.empty ? '× (書いていない)' : `× (${r.errors} か所)`}`;
    box.appendChild(h);
  }
  const row = (name, cls) => {
    const d = document.createElement('div');
    d.className = 'spell-row';
    const l = document.createElement('span');
    l.className = 'spell-label';
    l.textContent = name;
    const sp = document.createElement('span');
    sp.className = 'spell ' + cls;
    sp.lang = 'en';
    d.append(l, sp);
    box.appendChild(d);
    return { d, sp };
  };
  const A = row('答え', 'spell-answer');
  const I = row('あなた', 'spell-input');
  const ans = A.sp, inp = I.sp;
  const ch = (c) => (c === ' ' ? '␣' : c);
  // 答えは見せる形(大文字・小文字そのまま)の字を、対応の順に出す
  const form = [...r.form];
  let ai = 0;
  for (const o of r.ops) {
    if (o.op === 'ok') {
      ans.append(form[ai++]);
      inp.append(o.b);
    } else if (o.op === 'sub') {
      const a = document.createElement('b');
      a.className = 'bad';
      a.textContent = ch(form[ai++]);
      ans.append(a);
      const b = document.createElement('b');
      b.className = 'bad';
      b.textContent = ch(o.b);
      inp.append(b);
    } else if (o.op === 'miss') {
      const a = document.createElement('b');
      a.className = 'bad miss';
      a.textContent = ch(form[ai++]);
      ans.append(a);
      const gap = document.createElement('b');
      gap.className = 'bad gap';
      gap.textContent = '_';
      inp.append(gap);
    } else {
      const b = document.createElement('s');
      b.className = 'bad extra';
      b.textContent = ch(o.b);
      inp.append(b);
    }
  }
  // 正解のときは、答えの全体(~ や ( ) も含めて)を見せ、「あなた」の行は出さない
  if (r.ok || !r.form) ans.textContent = answer;
  I.d.hidden = r.empty || r.ok;
  return box;
}

function showVerdict(w, parts) {
  const ok = parts.every((p) => p.r.ok);
  $('verdict').hidden = false;
  $('verdict').className = 'verdict ' + (ok ? 'pass' : 'fail');
  if (parts.length === 1) {
    const r = parts[0].r;
    $('verdict-title').textContent = r.ok ? '○ 正解!' : r.empty ? '× 答えを見て覚えましょう' : `× ちがいます(${r.errors} か所)`;
  } else {
    $('verdict-title').textContent = ok ? '○ 正解!(現在形・過去形とも)' : `× ${parts.filter((p) => !p.r.ok).map((p) => p.label).join('・')}がちがいます`;
  }
  const box = $('spell-box');
  box.textContent = '';
  box.classList.toggle('two', parts.length > 1);
  for (const p of parts) box.appendChild(spellView(p));
  const wrong = parts.filter((p) => !p.r.ok);
  $('verdict-note').textContent = ok
    ? ''
    : wrong.every((p) => p.r.empty)
      ? '何も書いていないので、まちがいとして記録します。'
      : '赤い字が違うところです(答え: 書き落とした字、あなた: 違う字・余分な字)。大文字・小文字の違いは数えません。';
  $('btn-override').hidden = ok;
  $('btn-next').focus();
}

/** 「合格にする」: つづりは合っているのに、空白や記号で違うと判定されたときなど */
function onOverride() {
  if (!current || !current.judged) return;
  current.pass = true;
  current.overridden = true;
  $('verdict').className = 'verdict pass';
  $('verdict-title').textContent = '○ 合格にしました';
  $('btn-override').hidden = true;
}

/** スキップ: 答え合わせをしないで、この回の最後にもう一度出す */
function onSkip() {
  const s = state.session;
  if (!current || current.judged) return;
  if (s.index >= s.queue.length - 1) {
    showMessage('残りはこの問題だけです。書いて「答え合わせ」を押してください。', 'info');
    return;
  }
  hideMessage();
  const [id] = s.queue.splice(s.index, 1);
  s.queue.push(id);
  renderQuestion();
}

function onNext() {
  if (!current || !current.judged) return;
  const s = state.session;
  s.results.push({ id: current.word.id, pass: current.pass });
  recordResult(current.word, current.pass);
  persist();
  stopSpeaking();
  s.index++;
  if (s.index < s.queue.length) renderQuestion();
  else finishRound();
}

function finishRound() {
  const s = state.session;
  const correct = s.results.filter((r) => r.pass).length;
  s.history.push({ round: s.round, total: s.results.length, correct });
  s.wrong = s.results.filter((r) => !r.pass).map((r) => r.id);
  current = null;
  $('score').textContent = s.wrong.length === 0 ? `全問正解です!(${correct} / ${s.results.length})` : `${s.results.length} 問中 ${correct} 問正解`;
  const ul = $('round-list');
  ul.textContent = '';
  const list = [...s.results.filter((r) => !r.pass), ...s.results.filter((r) => r.pass)];
  for (const r of list) {
    const w = wordById(r.id);
    const li = document.createElement('li');
    li.className = statusOf(w);
    li.dataset.word = w.en;
    li.textContent = `${r.pass ? '○' : '×'} ${w.kind === 'past' ? `${w.base} → ${w.en}` : w.en}`;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = statusText(w).replace(/^[○×] /, '');
    li.appendChild(st);
    const rd = document.createElement('span');
    rd.className = 'rd';
    rd.textContent = w.ja;
    li.appendChild(rd);
    ul.appendChild(li);
  }
  $('btn-retry').hidden = s.wrong.length === 0;
  const tb = $('history').querySelector('tbody');
  tb.textContent = '';
  for (const h of s.history) {
    const tr = document.createElement('tr');
    for (const v of [`${h.round} 回目`, h.total, h.correct, `${Math.round((h.correct / h.total) * 100)}%`]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  showScreen('result');
}

// ---------- フラッシュ出題 ----------

let flash = null; // { queue, index, counts, title }

function setDrillMode(mode) {
  state.settings.drillMode = mode;
  for (const r of document.querySelectorAll('input[name="drill-mode"]')) r.checked = r.value === mode;
  $('flash-start-row').hidden = mode !== 'flash';
  $('normal-start-row').hidden = mode === 'flash';
}

/** @param {'all' | 'again' | 'maybe'} which */
function startFlash(which = 'all') {
  hideMessage();
  const ids = playable()
    .filter((w) => (which === 'again' ? w.flash === 'again' : which === 'maybe' ? w.flash === 'again' || w.flash === 'maybe' : true))
    .map((w) => w.id);
  if (!ids.length) {
    showMessage({ again: '「もう一回」の語はありません。', maybe: '「もう一回」「Maybe OK」の語はありません。' }[which] || '出題する語がありません。');
    return;
  }
  flash = { queue: ordered(ids), index: 0, counts: { ok: 0, maybe: 0, again: 0 }, title: drillTitle() };
  showScreen('flash');
  $('flash-done').hidden = true;
  $('flash-card').hidden = false;
  $('flash-bar').hidden = false;
  renderFlash();
}

/** 文字を 1 行に収める大きさ(px)。units: 文字の幅の合計(全角 1 字 = 1、英字は約 0.6) */
function flashFit(units, max) {
  const width = Math.min(globalThis.innerWidth || 400, 900) - 48;
  return Math.max(20, Math.min(max, Math.floor((width / Math.max(1, units)) * 0.94)));
}

const enUnits = (s) => [...s].length * 0.62;

function renderFlash() {
  const w = wordById(flash.queue[flash.index]);
  $('flash-progress').textContent = `${flash.title} フラッシュ ${flash.index + 1} / ${flash.queue.length} 問`;
  $('screen-flash').dataset.word = w.en;
  $('screen-flash').dataset.kind = w.kind;
  const q = $('flash-q'), sub = $('flash-sub');
  q.textContent = w.ja || '';
  sub.textContent = '';
  // 過去形: 日本語の意味だけを見て、現在形と過去形を思い浮かべる
  if (w.kind === 'past') sub.textContent = asksBase(w) ? '現在形と過去形は?' : '過去形は?';
  else if (w.no != null) sub.textContent = `No.${w.no}`;
  const qSize = flashFit([...q.textContent].length, 72);
  q.style.fontSize = qSize + 'px';
  q.dataset.size = qSize;
  $('flash-card').classList.remove('answered');
  $('flash-a').hidden = true;
  $('flash-a').textContent = '';
  $('flash-show').hidden = false;
  $('flash-rate').hidden = true;
}

/** 答え: 英語を大きく 1 行で出して、発音を読み上げる */
function showFlashAnswer() {
  const w = wordById(flash.queue[flash.index]);
  const box = $('flash-a');
  box.textContent = '';
  const line = document.createElement('p');
  line.className = 'flash-word';
  line.lang = 'en';
  const text = w.kind === 'past' ? `${w.base} → ${w.en}` : w.en;
  line.style.fontSize = flashFit(enUnits(text), 120) + 'px';
  if (w.kind === 'past') {
    const b = document.createElement('span');
    b.className = 'okuri';
    b.textContent = `${w.base} → `;
    const p = document.createElement('span');
    p.textContent = w.en;
    line.append(b, p);
  } else line.textContent = w.en;
  const again = document.createElement('button');
  again.type = 'button';
  again.className = 'btn small btn-say';
  again.textContent = '🔊';
  again.setAttribute('aria-label', '発音をもう一度聞く');
  again.addEventListener('click', () => say(w, true));
  box.append(line, again);
  const q = $('flash-q');
  q.style.fontSize = Math.max(20, Math.round(Number(q.dataset.size || 60) * 0.55)) + 'px';
  $('flash-card').classList.add('answered');
  box.hidden = false;
  $('flash-show').hidden = true;
  $('flash-rate').hidden = false;
  say(w);
}

function rateFlash(rate) {
  const w = wordById(flash.queue[flash.index]);
  w.flash = rate;
  w.updatedAt = Date.now();
  flash.counts[rate]++;
  persist();
  stopSpeaking();
  flash.index++;
  if (flash.index < flash.queue.length) renderFlash();
  else finishFlash();
}

function finishFlash() {
  const c = flash.counts;
  $('flash-card').hidden = true;
  $('flash-bar').hidden = true;
  $('flash-done').hidden = false;
  $('flash-progress').textContent = `${flash.title} フラッシュ ${flash.queue.length} 問`;
  $('flash-summary').textContent = `OK! ${c.ok} 語 / Maybe OK ${c.maybe} 語 / もう一回 ${c.again} 語`;
  const again = flash.queue.filter((id) => wordById(id).flash === 'again').length;
  const maybe = flash.queue.filter((id) => ['again', 'maybe'].includes(wordById(id).flash)).length;
  $('flash-again-again').textContent = `もう一回だけ(${again} 語)`;
  $('flash-again-again').disabled = again === 0;
  $('flash-again-maybe').textContent = `Maybe OK 含む(${maybe} 語)`;
  $('flash-again-maybe').disabled = maybe === 0;
}

// ---------- 4. バックアップ・ほかの端末と共有 ----------

function setBackupStatus(text) {
  $('backup-status').textContent = text;
}

function renderStorage() {
  const size = dataSize({ sets: state.sets, words: state.words });
  const pct = Math.round((size / STORAGE_LIMIT) * 100);
  const el = $('storage-info');
  el.textContent =
    `この端末に保存しているデータ: ${formatSize(size)}(テスト ${state.sets.length} 件・${state.words.length} 語。保存できる量の目安 約 5 MB の ${pct}%。` +
    '漢字書き取りドリルと同じサイトに置いているので、その分も含めて約 5 MB です)。' +
    (pct >= 50 ? '多くなってきました。書き出してから、使い終わったテストを削除すると軽くなります。' : '');
  el.classList.toggle('warn-text', pct >= 50);
}

async function onExport() {
  hideMessage();
  const name = backupFileName();
  const file = new File([JSON.stringify(makeBackup(state.sets, state.words, new Date(), state.folders))], name, { type: 'application/json' });
  const summary = `テスト ${state.sets.length} 件・${state.words.length} 語`;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: '英単語書き取りドリルのバックアップ' });
      setBackupStatus(`${name} を書き出しました(${summary})。`);
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      setBackupStatus('書き出しをやめました。');
      return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setBackupStatus(`${name} を保存しました(${summary})。`);
}

async function onImport(e, mode) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  hideMessage();
  await importBackupText(await file.text(), mode, 'ファイル');
}

async function importBackupText(text, mode, from) {
  try {
    const inc = parseBackup(text);
    inc.words = inc.words.map(cleanWord);
    let message;
    if (mode === 'replace') {
      const ok = await ask(
        `この端末のテストと語(テスト ${state.sets.length} 件・${state.words.length} 語)を、` +
          `${from}の内容(テスト ${inc.sets.length} 件・${inc.words.length} 語)に置き換えますか? 元に戻せません。`,
      );
      if (!ok) return;
      applyData(inc.sets, inc.words, inc.folders);
      message = `置き換えました(テスト ${inc.sets.length} 件・${inc.words.length} 語)。`;
    } else {
      const fresh = state.sets.length === 1 && state.words.length === 0;
      const base = fresh ? { sets: [], words: [], folders: [] } : { sets: state.sets, words: state.words, folders: state.folders };
      const r = mergeBackup(base, inc);
      applyData(r.sets, r.words, r.folders);
      message = `合わせました: テスト ${r.addedSets} 件と語 ${r.addedWords} 語を追加し、${r.updatedWords} 語を新しい方の成績に更新しました。`;
    }
    persist();
    renderWordList();
    setBackupStatus(message);
  } catch (err) {
    setBackupStatus('');
    showMessage(`読み込めませんでした(${err.message || err})。`);
  }
}

let qrTimer = null;

async function onQrShow() {
  hideMessage();
  const scope = $('qr-scope').value;
  const sets = scope === 'current' ? state.sets.filter((s) => s.id === state.currentSet) : state.sets;
  const ids = new Set(sets.map((s) => s.id));
  const words = state.words.filter((w) => ids.has(w.setId));
  let svgs;
  try {
    const { default: qrcode } = await import('./vendor/qrcode/qrcode.mjs');
    const chunks = splitPayload(await packBackup(makeBackup(sets, words, new Date(), scope === 'current' ? [] : state.folders)));
    svgs = chunks.map((text) => {
      const qr = qrcode(0, 'M');
      qr.addData(text, 'Byte');
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    });
  } catch (err) {
    showMessage(`QR コードを作れませんでした(${err.message || err})。ファイルで渡してください。`);
    return;
  }
  let page = 0, playing = svgs.length > 1;
  const draw = () => {
    $('qr-img').innerHTML = svgs[page]; // QR コードの絵(qrcode-generator が作った SVG)
    $('qr-page').textContent = svgs.length > 1 ? `${page + 1} / ${svgs.length} 枚(${playing ? '自動で切り替え中' : '止めています'})` : '1 枚';
  };
  const step = (d) => {
    page = (page + d + svgs.length) % svgs.length;
    draw();
  };
  const play = (on) => {
    playing = on && svgs.length > 1;
    clearInterval(qrTimer);
    if (playing) qrTimer = setInterval(() => step(1), 1500);
    $('qr-pause').textContent = playing ? '止める' : '動かす';
    draw();
  };
  $('qr-show-title').textContent = `${scope === 'current' ? `「${currentSetName()}」` : 'すべてのテスト'}(テスト ${sets.length} 件・${words.length} 語)の QR コード`;
  for (const id of ['qr-prev', 'qr-next', 'qr-pause']) $(id).hidden = svgs.length < 2;
  $('qr-prev').onclick = () => (play(false), step(-1));
  $('qr-next').onclick = () => (play(false), step(1));
  $('qr-pause').onclick = () => play(!playing);
  $('qr-close').onclick = () => $('qr-show').close();
  $('qr-show').onclose = () => clearInterval(qrTimer);
  $('qr-show').showModal();
  play(playing);
}

let qrStream = null;

async function onQrScan(mode) {
  hideMessage();
  const dlg = $('qr-scan');
  const video = $('qr-video');
  const asm = new QrAssembler();
  let finished = false;
  const stop = () => {
    finished = true;
    if (qrStream) for (const t of qrStream.getTracks()) t.stop();
    qrStream = null;
    video.srcObject = null;
    if (dlg.open) dlg.close();
  };
  const progress = () => {
    $('qr-progress').textContent = asm.total ? `${asm.have} / ${asm.total} 枚 読みました` : 'まだ読めていません';
    const dots = $('qr-dots');
    dots.textContent = '';
    for (let i = 1; i <= asm.total; i++) {
      const d = document.createElement('span');
      d.className = 'qr-dot' + (asm.parts.has(i) ? ' on' : '');
      dots.appendChild(d);
    }
  };
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    showMessage('この端末・ブラウザでは、カメラが使えませんでした。ファイルで渡してください(カメラは https のページでだけ使えます)。');
    return;
  }
  try {
    await loadScript('vendor/jsqr/jsQR.js');
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    showMessage(`カメラが使えませんでした(${err.message || err})。ブラウザの設定で、このページのカメラの使用を許可してください。ファイルで渡すこともできます。`);
    return;
  }
  $('qr-scan-close').onclick = stop;
  dlg.onclose = () => !finished && stop();
  progress();
  dlg.showModal();
  video.srcObject = qrStream;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (finished) return;
    if (video.videoWidth) {
      const k = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = globalThis.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && asm.add(code.data).ok) progress();
      if (asm.done) {
        const payload = asm.payload;
        stop();
        try {
          await importBackupText(await unpackBackup(payload), mode, 'QR コード');
        } catch (err) {
          showMessage(`QR コードのデータを読み込めませんでした(${err.message || err})。`);
        }
        return;
      }
    }
    setTimeout(tick, 150);
  };
  tick();
}

function applyData(sets, words, folders = []) {
  const m = migrate({ sets, words, currentSet: state.currentSet });
  state.folders = folders;
  state.sets = m.sets;
  state.words = m.words;
  state.currentSet = m.currentSet;
  if (review) renderReview();
}

// ---------- 初期化 ----------

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

/** ラジオボタンの設定(選んだら保存する) */
function bindRadio(name, key, after = () => {}) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.checked = r.value === state.settings[key];
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.settings[key] = r.value;
      after(r.value);
      persist();
    });
  }
}

function init() {
  restore();
  bindRadio('theme', 'theme', applyTheme);
  applyTheme();
  bindRadio('speech', 'speech', (v) => {
    if (v !== 'off') speak('OK', { rate: v }); // 選んだ速さで試しに読み上げる(iPhone では、操作したときに声が出せるようになる)
  });
  bindRadio('order', 'order');
  bindRadio('paste-kind', 'pasteKind');
  if (!canSpeak()) {
    $('speech-note').hidden = false;
    $('speech-note').textContent = 'この端末・ブラウザでは、発音の読み上げが使えません。';
  }
  renderWordList();

  $('message-close').addEventListener('click', hideMessage);
  // 取り込み
  marker = new Marker($('marker-canvas'), {
    onChange: () => {
      if (marker && marker.box) $('read-status').textContent = '囲んだ表を読み取ります。「読み取る」を押してください。';
    },
  });
  marker.setTool('box');
  for (const r of document.querySelectorAll('input[name="src-mode"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      setSrcMode(r.value);
      persist();
    });
  }
  setSrcMode(state.settings.srcMode);
  for (const r of document.querySelectorAll('input[name="finger"]')) r.addEventListener('change', () => r.checked && marker.setMode(r.value));
  $('photo').addEventListener('change', onPhotoSelected);
  $('btn-zoom-in').addEventListener('click', () => marker.setZoom(marker.zoom * 1.5));
  $('btn-zoom-out').addEventListener('click', () => marker.setZoom(marker.zoom / 1.5));
  $('btn-rotate').addEventListener('click', () => marker.rotate());
  $('btn-mark-clear').addEventListener('click', () => marker.clear());
  $('btn-read').addEventListener('click', onRead);
  $('btn-paste').addEventListener('click', onPaste);
  $('btn-review-add').addEventListener('click', onReviewAdd);
  $('btn-review-clear').addEventListener('click', closeReview);
  let resizeTimer = null;
  globalThis.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => marker.src && !$('marker-box').hidden && marker.layout(), 200);
  });
  // 語の一覧
  $('btn-all').addEventListener('click', () => {
    setEnabled(listWords(), true);
    syncDrill(listSets().map((s) => s.id));
    persist();
    renderWordList();
  });
  $('btn-none').addEventListener('click', () => {
    setEnabled(listWords(), false);
    syncDrill(listSets().map((s) => s.id));
    persist();
    renderWordList();
  });
  $('add-form').addEventListener('submit', onAddWord);
  $('add-kind').addEventListener('change', () => setAddKind($('add-kind').value));
  setAddKind($('add-kind').value);
  $('btn-reset-results').addEventListener('click', async () => {
    const names = listSets().map((s) => `「${s.name}」`).join('');
    if (!(await ask(`${names}の合格・不合格の記録をすべて消しますか?`))) return;
    resetResults(listWords());
  });
  // テスト
  $('btn-set-new').addEventListener('click', onSetNew);
  $('btn-set-rename').addEventListener('click', onSetRename);
  $('btn-set-delete').addEventListener('click', onSetDelete);
  $('btn-set-folder').addEventListener('click', onSetFolder);
  $('btn-folder-new').addEventListener('click', onFolderNew);
  // バックアップ
  $('btn-export').addEventListener('click', onExport);
  for (const r of document.querySelectorAll('input[name="sync-mode"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      $('sync-file').hidden = r.value !== 'file';
      $('sync-qr').hidden = r.value !== 'qr';
    });
  }
  $('btn-qr-show').addEventListener('click', onQrShow);
  $('btn-qr-merge').addEventListener('click', () => onQrScan('merge'));
  $('btn-qr-replace').addEventListener('click', () => onQrScan('replace'));
  $('import-merge').addEventListener('change', (e) => onImport(e, 'merge'));
  $('import-replace').addEventListener('change', (e) => onImport(e, 'replace'));
  // 1・2・4 の欄の開閉を覚えておく
  for (const d of document.querySelectorAll('details.fold')) {
    const key = d.id.replace(/^fold-/, '');
    if (state.settings.folds[key] === false) d.open = false;
    d.addEventListener('toggle', () => {
      state.settings.folds[key] = d.open;
      persist();
      if (key === 'import' && d.open && marker && marker.src) marker.layout();
    });
  }
  // 出題
  $('btn-start').addEventListener('click', () => startSession('all'));
  $('btn-start-wrong').addEventListener('click', () => startSession('wrong'));
  $('btn-start-new').addEventListener('click', () => startSession('new'));
  $('btn-start-miss3').addEventListener('click', () => startSession('miss3'));
  $('answer-form').addEventListener('submit', onCheck);
  // 現在形の欄で Enter: 過去形の欄へ(答え合わせのあとは、次へ)
  $('answer-base').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (current && current.judged) onNext();
    else $('answer').focus();
  });
  $('btn-say').addEventListener('click', () => current && say(current.word, true));
  $('btn-override').addEventListener('click', onOverride);
  $('btn-next').addEventListener('click', onNext);
  $('btn-skip').addEventListener('click', onSkip);
  $('btn-quit').addEventListener('click', async () => {
    if (!(await ask('出題をやめて、設定の画面に戻りますか?(ここまでに答え合わせをした問題の結果は記録されています)'))) return;
    stopSpeaking();
    current = null;
    renderWordList();
    showScreen('setup');
  });
  // フラッシュ出題
  for (const r of document.querySelectorAll('input[name="drill-mode"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      setDrillMode(r.value);
      persist();
    });
  }
  setDrillMode(state.settings.drillMode);
  $('btn-flash-all').addEventListener('click', () => startFlash('all'));
  $('btn-flash-again').addEventListener('click', () => startFlash('again'));
  $('btn-flash-maybe').addEventListener('click', () => startFlash('maybe'));
  $('flash-show').addEventListener('click', showFlashAnswer);
  for (const b of document.querySelectorAll('#flash-rate [data-rate]')) b.addEventListener('click', () => rateFlash(b.dataset.rate));
  $('flash-again-again').addEventListener('click', () => startFlash('again'));
  $('flash-again-maybe').addEventListener('click', () => startFlash('maybe'));
  $('flash-again-all').addEventListener('click', () => startFlash('all'));
  const backFromFlash = () => {
    flash = null;
    stopSpeaking();
    renderWordList();
    showScreen('setup');
  };
  $('flash-back').addEventListener('click', backFromFlash);
  $('flash-quit').addEventListener('click', async () => {
    if (!(await ask('フラッシュ出題をやめて、設定の画面に戻りますか?(ここまでに選んだものは記録されています)'))) return;
    backFromFlash();
  });
  // 結果
  $('btn-retry').addEventListener('click', () => startRound(state.session.wrong));
  $('btn-restart').addEventListener('click', () => startSession('all'));
  $('btn-setup').addEventListener('click', () => {
    renderWordList();
    showScreen('setup');
  });
  document.body.dataset.ready = '1';
}

init();
