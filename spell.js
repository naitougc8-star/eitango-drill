// つづりの答え合わせ。入力と答えを 1 字ずつ対応させ(編集距離)、違った字を示す。
// DOM に依存しない(Node でテストできる)。
//
// 比べ方:
// - 大文字・小文字は区別しない(I see の I も)
// - 前後のスペースは無視し、続いたスペースは 1 つとして数える
// - iPad・iPhone で出る ’ ‘ ` ´ は ' と同じに扱う(「スマート句読点」で don't が don’t になるため)
// - 答えの「~」「…」は書かなくてよい(~ing の形の語でも、~ を除いた所だけを比べる)
// - 答えの ( ) の中は、書いても書かなくてもよい(例: (a) few → few でも a few でも正解)
// - 答えに「/」があれば、どれか 1 つが合えば正解(例: color / colour)

/** 比べるための形にそろえる(全角英数字を半角に、アポストロフィをそろえ、小文字に、スペースを詰める) */
export function normalize(s) {
  return shown(s).toLowerCase();
}

/** 見せるための形(normalize の、小文字にしない形。字の数は normalize と同じ) */
export function shown(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[’‘`´′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[~〜～…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 答えとして認める書き方(/ で区切った別の書き方と、( ) の中を書く・書かない)。見せる形(大文字・小文字そのまま)で返す */
export function answerForms(answer) {
  const forms = new Map(); // 比べる形 → 見せる形
  for (const alt of String(answer || '').split('/')) {
    if (!alt.trim()) continue;
    for (const f of [shown(alt.replace(/\([^)]*\)/g, ' ')), shown(alt.replace(/[()]/g, ' '))]) {
      if (f && !forms.has(f.toLowerCase())) forms.set(f.toLowerCase(), f);
    }
  }
  return [...forms.values()];
}

/**
 * 1 字ずつの対応(編集距離が最小になる並べ方)。
 * @returns {{op: 'ok' | 'sub' | 'miss' | 'extra', a: string, b: string}[]}
 *   ok: 合っている字、sub: 違う字(a: 答えの字、b: 書いた字)、miss: 書き落とした字(a)、extra: 余分な字(b)
 */
export function align(answer, input) {
  const A = [...answer], B = [...input];
  const n = A.length, m = B.length;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) D[i][0] = i;
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = A[i - 1] === B[j - 1];
      D[i][j] = Math.min(D[i - 1][j - 1] + (same ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
      // 隣どうしの入れ替え(recieve → receive)は 1 つの間違いとして数える
      if (!same && i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) D[i][j] = Math.min(D[i][j], D[i - 2][j - 2] + 1);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1] && D[i][j] === D[i - 1][j - 1]) {
      ops.push({ op: 'ok', a: A[i - 1], b: B[j - 1] });
      i--, j--;
    } else if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1] && A[i - 1] !== B[j - 1] && D[i][j] === D[i - 2][j - 2] + 1) {
      // 入れ替え: 2 字とも違う字として示す
      ops.push({ op: 'sub', a: A[i - 1], b: B[j - 1] }, { op: 'sub', a: A[i - 2], b: B[j - 2] });
      i -= 2, j -= 2;
    } else if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + 1) {
      ops.push({ op: 'sub', a: A[i - 1], b: B[j - 1] });
      i--, j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: 'miss', a: A[i - 1], b: '' });
      i--;
    } else {
      ops.push({ op: 'extra', a: '', b: B[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

/**
 * つづりを確かめる。
 * @param {string} input 書いた(入力した)つづり
 * @param {string} answer 答え(語の一覧の英語)
 * @returns {{ok: boolean, empty: boolean, form: string, input: string, ops: object[], errors: number}}
 *   form: いちばん近い答えの書き方(見せる形)、ops: 1 字ずつの対応(a・b は小文字。form と同じ位置の字は form から取って見せる)、
 *   errors: 違った字の数
 */
export function checkSpelling(input, answer) {
  const got = normalize(input);
  const forms = answerForms(answer);
  if (!forms.length) return { ok: false, empty: !got, form: '', input: got, ops: [], errors: 0 };
  let best = null;
  for (const form of forms) {
    const ops = align(form.toLowerCase(), got);
    const errors = ops.filter((o) => o.op !== 'ok').length;
    if (!best || errors < best.errors) best = { form, ops, errors };
  }
  return { ok: !!got && best.errors === 0, empty: !got, form: best.form, input: got, ops: best.ops, errors: best.errors };
}

/** 読み上げる英語(~ や ( ) を除き、/ の別の書き方は最初の 1 つ) */
export function speakText(answer) {
  const first = String(answer || '').split('/')[0];
  return first.replace(/[~〜～…]/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}
