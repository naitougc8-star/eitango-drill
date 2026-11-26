// 通しテスト(Chromium と WebKit、タブレットサイズ)。
// 写真の取り込み(OCR)→ 確認 → 一覧に追加 → 出題(キーボード入力・違った字を赤で)→ 結果、フラッシュ出題、読み上げ、バックアップ。

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, '../fixtures');

/** 読み上げを記録する(端末の音声合成の代わり) */
async function stubSpeech(page) {
  await page.addInitScript(() => {
    window.__spoken = [];
    const fake = {
      speak: (u) => window.__spoken.push({ text: u.text, rate: u.rate, lang: u.lang }),
      cancel: () => {},
      getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }],
      addEventListener: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
  });
}

/** コンソールのエラー・失敗した通信・外部への通信を集める */
function watch(page, baseURL) {
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => problems.push('failed: ' + r.url()));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(baseURL) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push('external: ' + u);
  });
  return problems;
}

async function open(page) {
  await page.goto('./');
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
}

async function paste(page, kind, text) {
  await page.locator('input[name="src-mode"][value="paste"]').check({ force: true });
  await page.locator(`input[name="paste-kind"][value="${kind}"]`).check({ force: true });
  await page.fill('#paste', text);
  await page.click('#btn-paste');
  await page.click('#btn-review-add');
}

/** 確認表の行([番号, ...入力欄の値]) */
async function reviewRows(page) {
  return page.$$eval('#review-table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('input:not([type="checkbox"])')].map((i) => i.value)));
}

test('写真: 単語の表を読み取り、確かめて一覧に追加する(外部への通信なし)', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const problems = watch(page, baseURL);
  await open(page);
  await page.setInputFiles('#photo', path.join(FIX, 'print-words.png'));
  await expect(page.locator('#btn-read')).toBeEnabled();
  await page.click('#btn-read');
  await expect(page.locator('#review')).toBeVisible({ timeout: 180_000 });
  const want = JSON.parse(fs.readFileSync(path.join(FIX, 'print-words.json'), 'utf8'));
  const rows = await reviewRows(page);
  expect(rows.map((r) => Number(r[0]))).toEqual(want.map((w) => w.no));
  expect(rows.map((r) => r[1])).toEqual(want.map((w) => w.en)); // 英語はすべて正しく読む
  const jaOk = rows.filter((r, i) => r[2] === want[i].ja).length;
  expect(jaOk).toBeGreaterThanOrEqual(13); // 日本語は 16 語中 13 語以上(違うものは確認表で直す)
  // 直してから追加する
  for (let i = 0; i < want.length; i++) {
    if (rows[i][2] !== want[i].ja) await page.locator(`#review-table tbody tr:nth-child(${i + 1}) td:nth-child(4) input`).fill(want[i].ja);
  }
  await page.click('#btn-review-add');
  await expect(page.locator('#message-text')).toHaveText('「テスト 1」に 16 語を追加しました。');
  await expect(page.locator('#word-list li')).toHaveCount(16);
  await expect(page.locator('.tree-gname')).toHaveText(['写真 1']);
  // 同じ写真をもう一度読み取ると、もうある番号の行は初めから外れている
  await page.click('#btn-read');
  await expect(page.locator('#review')).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('#review-table .already')).toHaveCount(16);
  await expect(page.locator('#btn-review-add')).toBeDisabled();
  expect(problems).toEqual([]);
});

test('写真: 動詞の過去形の表を読み取り、「原形 → 過去形」で出題する', async ({ page }) => {
  test.setTimeout(240_000);
  await stubSpeech(page);
  await open(page);
  await page.locator('input[name="src-mode"][value="past"]').check({ force: true });
  await page.setInputFiles('#photo', path.join(FIX, 'print-past.png'));
  await page.click('#btn-read');
  await expect(page.locator('#review')).toBeVisible({ timeout: 180_000 });
  const want = JSON.parse(fs.readFileSync(path.join(FIX, 'print-past.json'), 'utf8'));
  const rows = await reviewRows(page);
  expect(rows.map((r) => [Number(r[0]), r[2], r[3]])).toEqual(want.map((w) => [w.no, w.base, w.en]));
  await page.click('#btn-review-add');
  await expect(page.locator('#word-list li.kind-past')).toHaveCount(6);
  await page.locator('input[name="order"][value="number"]').check({ force: true });
  await page.click('#btn-start');
  // 日本語の意味だけを見て、現在形と過去形を両方書く
  await expect(page.locator('#q-ja')).toHaveText('食べる');
  await expect(page.locator('#field-base')).toBeVisible();
  await page.fill('#answer-base', 'eat');
  await page.press('#answer-base', 'Enter'); // 過去形の欄へ
  await expect(page.locator('#answer')).toBeFocused();
  await page.fill('#answer', 'ate');
  await page.press('#answer', 'Enter');
  await expect(page.locator('#verdict-title')).toHaveText('○ 正解!(現在形・過去形とも)');
  expect(await page.evaluate(() => window.__spoken.map((s) => s.text))).toEqual(['eat, ate']);
  // 片方だけ合っていれば、それぞれに ○・× を付けて、不合格
  await page.click('#btn-next');
  await expect(page.locator('#q-ja')).toHaveText('行く');
  await page.fill('#answer-base', 'go');
  await page.fill('#answer', 'goed');
  await page.click('#btn-check');
  await expect(page.locator('#verdict-title')).toHaveText('× 過去形がちがいます');
  await expect(page.locator('.spell-part[data-part="base"] .spell-part-title')).toHaveText('現在形 ○');
  await expect(page.locator('.spell-part[data-part="past"] .spell-part-title')).toHaveText('過去形 × (4 か所)');
  await expect(page.locator('.spell-part[data-part="past"] .spell-answer')).toHaveText('went');
  await page.click('#btn-next');
  await expect(page.locator('#q-ja')).toHaveText('見る');
  await page.click('#btn-quit');
  await page.click('#ask-ok');
  await expect(page.locator('#word-list li[data-word="went"] .res')).toHaveText('× 1 回まちがい');
});

test('出題: キーボードで入力し、違った字を赤で示す。結果は語の一覧に残る', async ({ page }) => {
  await stubSpeech(page);
  await open(page);
  await paste(page, 'word', "101 walk 歩く\n223 I see 理解を表す\n225 don't ~するな、~しない");
  await expect(page.locator('#word-list li')).toHaveCount(3);
  await page.locator('input[name="order"][value="number"]').check({ force: true });
  // 入力欄: 自動修正・自動の大文字・スペルチェックを切り、Pencil で書けるように背を高く
  await page.click('#btn-start');
  const input = page.locator('#answer');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('autocapitalize', 'off');
  await expect(input).toHaveAttribute('spellcheck', 'false');
  expect((await input.boundingBox()).height).toBeGreaterThanOrEqual(64);

  await expect(page.locator('#q-ja')).toHaveText('歩く');
  await input.fill('wlak');
  await page.click('#btn-check');
  await expect(page.locator('#verdict-title')).toHaveText('× ちがいます(2 か所)');
  await expect(page.locator('.spell-answer .bad')).toHaveText(['a', 'l']);
  await expect(page.locator('.spell-input .bad')).toHaveText(['l', 'a']);
  await page.click('#btn-next');

  await expect(page.locator('#q-ja')).toHaveText('理解を表す');
  await input.fill('i see');
  await page.press('#answer', 'Enter');
  await expect(page.locator('#verdict-title')).toHaveText('○ 正解!');
  await expect(page.locator('.spell-answer')).toHaveText('I see');
  await page.press('#answer', 'Enter'); // Enter をもう一度で次へ

  await expect(page.locator('#q-ja')).toHaveText('~するな、~しない');
  await input.fill('dont');
  await page.click('#btn-check');
  await expect(page.locator('.spell-input .gap')).toHaveCount(1); // 書き落とした ' の所に _
  await page.click('#btn-override'); // 合格にする
  await expect(page.locator('#verdict-title')).toHaveText('○ 合格にしました');
  await page.click('#btn-next');

  await expect(page.locator('#score')).toHaveText('3 問中 2 問正解');
  expect(await page.evaluate(() => window.__spoken.map((s) => s.text))).toEqual(['walk', 'I see', "don't"]);
  await page.click('#btn-retry');
  await expect(page.locator('#q-ja')).toHaveText('歩く');
  await page.fill('#answer', 'walk');
  await page.click('#btn-check');
  await page.click('#btn-next');
  await expect(page.locator('#history tbody tr')).toHaveCount(2);
  await page.click('#btn-setup');
  // 再読み込みしても成績が残る(「○ 2 回目で合格」)
  await page.reload();
  await expect(page.locator('#word-list li[data-word="walk"] .res')).toHaveText('○ 2 回目で合格');
  await expect(page.locator('#word-list li[data-word="I see"] .res')).toHaveText('○ 1 回目で合格');
});

test('読み上げ: 「読み上げない」なら流さず、🔊 では流す。「ゆっくり」は遅く読む', async ({ page }) => {
  await stubSpeech(page);
  await open(page);
  await paste(page, 'word', '101 walk 歩く');
  await page.locator('input[name="speech"][value="off"]').check({ force: true });
  await page.click('#btn-start');
  await page.fill('#answer', 'walk');
  await page.click('#btn-check');
  expect(await page.evaluate(() => window.__spoken.length)).toBe(0);
  await page.click('#btn-say');
  expect(await page.evaluate(() => window.__spoken.map((s) => s.text))).toEqual(['walk']);
  await page.click('#btn-next');
  await page.click('#btn-setup');
  await page.locator('input[name="speech"][value="slow"]').check({ force: true });
  await page.click('#btn-start');
  await page.fill('#answer', 'walk');
  await page.click('#btn-check');
  const last = await page.evaluate(() => window.__spoken.at(-1));
  expect(last).toEqual({ text: 'walk', rate: 0.7, lang: 'en-US' });
});

test('フラッシュ出題: 日本語を見て、答えで英語(と発音)、選んだものを ⚡ で記録する', async ({ page }) => {
  await stubSpeech(page);
  await open(page);
  await paste(page, 'word', '101 walk 歩く\n102 stay いる、とどまる');
  await page.locator('input[name="drill-mode"][value="flash"]').check({ force: true });
  await page.locator('input[name="order"][value="number"]').check({ force: true });
  await page.click('#btn-flash-all');
  await expect(page.locator('#flash-q')).toHaveText('歩く');
  await page.click('#flash-show');
  await expect(page.locator('#flash-a .flash-word')).toHaveText('walk');
  await page.click('#flash-rate [data-rate="ok"]');
  await page.click('#flash-show');
  await page.click('#flash-rate [data-rate="again"]');
  await expect(page.locator('#flash-summary')).toHaveText('OK! 1 語 / Maybe OK 0 語 / もう一回 1 語');
  expect(await page.evaluate(() => window.__spoken.map((s) => s.text))).toEqual(['walk', 'stay']);
  await page.click('#flash-back');
  await expect(page.locator('#word-list li[data-word="stay"] .flash-tag')).toHaveText('⚡ もう一回');
  await expect(page.locator('#btn-flash-again')).toHaveText('もう一回だけ(1 語)');
});

test('保存: 漢字書き取りドリルと同じサイトでも、保存の名前が別なので混ざらない', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('kakitori-drill.v1')) localStorage.setItem('kakitori-drill.v1', JSON.stringify({ words: [{ word: '山', reading: 'やま' }] }));
  });
  await open(page);
  await paste(page, 'word', '101 walk 歩く');
  const store = await page.evaluate(() => ({ kanji: localStorage.getItem('kakitori-drill.v1'), en: JSON.parse(localStorage.getItem('eitango-drill.v1')) }));
  expect(JSON.parse(store.kanji).words[0].word).toBe('山');
  expect(store.en.words.map((w) => w.en)).toEqual(['walk']);
});

test('バックアップ: 書き出したファイルを、ほかの端末(別の保存領域)で読み込んで合わせる', async ({ browser, baseURL }) => {
  const ipad = await (await browser.newContext({ baseURL })).newPage();
  await open(ipad);
  await paste(ipad, 'word', '101 walk 歩く\n102 stay いる、とどまる');
  await paste(ipad, 'past', '1 食べる eat ate');
  const [dl] = await Promise.all([ipad.waitForEvent('download'), ipad.click('#btn-export')]);
  // OneDrive の中の test-results はファイルが掴まれることがあるので、一時フォルダーに保存して読む
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eitango-')), dl.suggestedFilename());
  await dl.saveAs(file);
  expect(dl.suggestedFilename()).toMatch(/^eitango-drill-\d{8}-\d{4}\.json$/);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(data.app).toBe('eitango-drill');
  expect(data.words.map((w) => w.en)).toEqual(['walk', 'stay', 'ate']);

  const iphone = await (await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } })).newPage();
  await open(iphone);
  await iphone.locator('#fold-backup summary').scrollIntoViewIfNeeded();
  await iphone.setInputFiles('#import-merge', file);
  await expect(iphone.locator('#backup-status')).toContainText('語 3 語を追加');
  await expect(iphone.locator('#word-list li')).toHaveCount(3);
  await expect(iphone.locator('#word-list li.kind-past input.base')).toHaveValue('eat');
});

test('写真ごとのまとまり: ツリーで名前を変え、ほかのまとまりにまとめると番号順に並ぶ', async ({ page }) => {
  await open(page);
  await paste(page, 'word', '101 walk 歩く\n103 food 食べ物\n105 real 実際の');
  await paste(page, 'word', '104 win 勝つ\n102 stay いる、とどまる');
  await expect(page.locator('.tree-gname')).toHaveText(['貼り付け', '貼り付け 2']);
  // ツリーの名前をタップして変える
  await page.locator('.tree-gname').nth(1).click();
  await page.fill('#ask-input', '追加分');
  await page.click('#ask-ok');
  await expect(page.locator('.tree-gname')).toHaveText(['貼り付け', '追加分']);
  // 「追加分」を「貼り付け」にまとめる
  await page.locator('.tree-group .gmerge').nth(1).click();
  await page.selectOption('#ask-select', { label: '貼り付け(3 問)' });
  await page.click('#ask-ok');
  await expect(page.locator('.tree-gname')).toHaveText(['貼り付け']);
  await expect(page.locator('.tree-group .gmerge')).toHaveCount(0);
  await expect(page.locator('#word-list li')).toHaveCount(5);
  expect(await page.$$eval('#word-list li', (lis) => lis.map((li) => li.dataset.word))).toEqual(['walk', 'stay', 'food', 'win', 'real']);
  // 再読み込みしても残る
  await page.reload();
  await expect(page.locator('.tree-gname')).toHaveText(['貼り付け']);
});
