// 英語の読み上げ(端末の音声合成: Web Speech API の speechSynthesis)。
// iPad・iPhone の Safari では、ボタンを押したとき(ユーザーの操作)から呼ぶと声が出る。
// 声は英語(アメリカ)を優先し、端末に入っている声から選ぶ。読み上げられない端末では何もしない。

import { speakText } from './spell.js';

// よく聞きやすい声(iOS・macOS の英語の声)。端末にあれば、この順で選ぶ
const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Karen', 'Daniel', 'Google US English', 'Microsoft Aria', 'Microsoft Zira'];

export const RATES = { slow: 0.7, normal: 0.95 };

let voices = [];

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

/** 読み上げが使えるか */
export function canSpeak() {
  return !!(globalThis.speechSynthesis && globalThis.SpeechSynthesisUtterance);
}

/** 英語の声を選ぶ(アメリカ英語 → イギリス英語 → そのほかの英語) */
export function pickVoice(list = voices) {
  const en = list.filter((v) => /^en([-_]|$)/i.test(v.lang));
  if (!en.length) return null;
  for (const name of PREFERRED) {
    const v = en.find((x) => x.name.startsWith(name) && /US/i.test(x.lang)) || en.find((x) => x.name.startsWith(name));
    if (v) return v;
  }
  return en.find((v) => /en[-_]US/i.test(v.lang) && v.localService) || en.find((v) => /en[-_]US/i.test(v.lang)) || en[0];
}

/**
 * 英語を読み上げる(読み上げ中のものは止めてから)。
 * @param {string} answer 語の一覧の英語(~ や ( ) は読まない)
 * @param {{rate?: 'slow' | 'normal'}} opts
 * @returns {boolean} 読み上げを始めたか
 */
export function speak(answer, opts = {}) {
  if (!canSpeak()) return false;
  const text = speakText(answer);
  if (!text) return false;
  try {
    if (!voices.length) loadVoices();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = RATES[opts.rate] || RATES.normal;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/** 読み上げを止める */
export function stopSpeaking() {
  try {
    globalThis.speechSynthesis?.cancel();
  } catch {
    // 何もしない
  }
}
