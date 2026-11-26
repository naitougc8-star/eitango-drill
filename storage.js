// localStorage への保存。使えない環境(プライベートブラウズなど)でも例外を出さずに動く。

const KEY = 'eitango-drill.v1'; // 漢字書き取りドリルと同じサイト(github.io)に置くので、保存の名前を分ける

export function load() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function save(data) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
