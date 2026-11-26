// 英語の読み上げ(端末の音声合成: Web Speech API の speechSynthesis)。
// 声は英語(アメリカ)を優先し、端末に入っている声から選ぶ。読み上げられない端末では何もしない。
//
// iPhone・iPad の Safari で声が出ないことへの手当て:
// - 最初に画面を触ったとき(ユーザーの操作の中)に、音量 0 の読み上げを 1 回して、読み上げを使えるようにしておく
// - 止めた直後に読み上げると、黙って捨てられることがあるので、読み上げ中のときだけ止め、少し待ってから読む
// - 一覧にあっても使えない声(端末に入っていない声)を選ぶと黙ることがあるので、端末の中の声(localService)を選ぶ。
//   それでも読み始めなければ、声を指定しないで(英語として)読み直す
// - 読み上げ中の発話は、ブラウザに捨てられないように持っておく

import { speakText } from './spell.js';

// よく聞きやすい声(iOS・macOS・Windows・Android の英語の声)。端末にあれば、この順で選ぶ
const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Karen', 'Daniel', 'Google US English', 'Microsoft Aria', 'Microsoft Zira'];

export const RATES = { slow: 0.7, normal: 0.95 };

let voices = [];
let unlocked = false;
const alive = new Set(); // 読み上げ中の発話(捨てられないように持っておく)

function loadVoices() {
  try {
    voices = globalThis.speechSynthesis ? speechSynthesis.getVoices() : [];
  } catch {
    voices = [];
  }
}

if (globalThis.speechSynthesis) {
  loadVoices();
  // 声の一覧はあとから届くことがある(Chrome・Safari)
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

/**
 * 使う声の名前(例: Samantha(en-US))。声の一覧が届いていないときは、端末の英語の声(en-US)。
 * 声の一覧はあるのに英語の声がないときは空。
 */
export function voiceName() {
  if (!voices.length) loadVoices();
  if (!voices.length) return '端末の英語の声(en-US)';
  const v = pickVoice();
  return v ? `${v.name}(${v.lang})` : '';
}

/** 声の一覧が届いたら呼ぶ */
export function onVoices(fn) {
  globalThis.speechSynthesis?.addEventListener?.('voiceschanged', fn);
}

/** 読み上げが使えるか */
export function canSpeak() {
  return !!(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
}

/**
 * 英語の声を選ぶ(アメリカ英語 → イギリス英語 → そのほかの英語)。端末の中の声(localService)を優先する。
 * プレミアム・拡張(Enhanced)の声が入っていれば、同じ名前の標準の声より先に選ぶ。
 */
export function pickVoice(list = voices) {
  const en = list.filter((v) => /^en([-_]|$)/i.test(v.lang));
  if (!en.length) return null;
  const local = en.filter((v) => v.localService !== false);
  const pool = local.length ? local : en;
  const quality = (v) => (/premium|プレミアム/i.test(v.name + v.voiceURI) ? 2 : /enhanced|拡張/i.test(v.name + v.voiceURI) ? 1 : 0);
  for (const name of PREFERRED) {
    const same = pool.filter((x) => x.name.startsWith(name)).sort((a, b) => /US/i.test(b.lang) - /US/i.test(a.lang) || quality(b) - quality(a));
    if (same.length) return same[0];
  }
  return pool.find((v) => /en[-_]US/i.test(v.lang)) || pool[0];
}

function utterance(text, opts, withVoice) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  if (withVoice) {
    const v = pickVoice();
    if (v) u.voice = v;
  }
  u.rate = RATES[opts.rate] || RATES.normal;
  alive.add(u);
  const done = () => alive.delete(u);
  u.onend = done;
  u.onerror = done;
  return u;
}

/**
 * 最初に画面を触ったとき(ユーザーの操作の中)に呼ぶ。音量 0 で 1 回読み上げて、iPhone で読み上げを使えるようにする。
 */
export function unlockSpeech() {
  if (unlocked || !canSpeak()) return;
  unlocked = true;
  try {
    loadVoices();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'en-US';
    speechSynthesis.speak(u);
  } catch {
    // 何もしない
  }
}

/**
 * 英語を読み上げる(読み上げ中のものは止めてから)。いくつか渡すと、1 つずつ分けて読む。
 * @param {string | string[]} answers 語の一覧の英語(~ や ( ) は読まない)
 * @param {{rate?: 'slow' | 'normal'}} opts
 * @returns {boolean} 読み上げを始めたか
 */
export function speak(answers, opts = {}) {
  if (!canSpeak()) return false;
  const texts = (Array.isArray(answers) ? answers : [answers]).map(speakText).filter(Boolean);
  if (!texts.length) return false;
  try {
    if (!voices.length) loadVoices();
    const ss = speechSynthesis;
    const busy = ss.speaking || ss.pending;
    if (busy) ss.cancel();
    const start = () => {
      if (ss.paused) ss.resume(); // iOS で止まったままになっていることがある
      let started = false;
      texts.forEach((t, i) => {
        const u = utterance(t, opts, true);
        if (i === 0) u.onstart = () => (started = true);
        ss.speak(u);
      });
      // 読み始めなければ、声を指定しないで読み直す(一覧にあっても使えない声だったとき)
      setTimeout(() => {
        if (started || ss.speaking) return;
        ss.cancel();
        for (const t of texts) ss.speak(utterance(t, opts, false));
      }, 1200);
    };
    // 止めた直後の読み上げは捨てられることがあるので、止めたときだけ少し待つ
    if (busy) setTimeout(start, 60);
    else start();
    return true;
  } catch {
    return false;
  }
}

/** 読み上げを止める */
export function stopSpeaking() {
  try {
    const ss = globalThis.speechSynthesis;
    if (ss && (ss.speaking || ss.pending)) ss.cancel();
  } catch {
    // 何もしない
  }
}
