// 小さな共通の関数(DOM に依存しない。loadScript だけはブラウザ用)

let seq = 0;

/** 語・テストの id(端末をまたいでも重ならないよう、時刻と連番から作る) */
export function newId() {
  seq = (seq + 1) % 1e6;
  return Date.now().toString(36) + '-' + seq.toString(36) + Math.random().toString(36).slice(2, 5);
}

/** HTML に入れる文字を逃がす */
export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/** クラシックなスクリプト(Tesseract.js・jsQR)を 1 回だけ読み込む */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`${src} を読み込めませんでした(通信を確認してください)`));
    };
    document.head.appendChild(s);
  });
}
