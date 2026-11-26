// 写真の上で、読み取りたい表を四角で囲む(漢字書き取りドリルの marker.js の、表を囲む機能)。
// - Apple Pencil を検出したら、Pencil でなぞり、指はスクロールに使う
// - Pencil がないときは「なぞる / 動かす」を切り替える
// - 座標は元の画像(回転後)のピクセルで持つ

// Apple Pencil を使ったか(使ったら、指はスクロールに使う)
export const input = { penSeen: false };

const MAX_SIDE = 3200; // 元の画像を保持するときの長辺(iPad の canvas のメモリ制限に余裕を持たせる)
export const BRUSH = { thin: 14, medium: 26, thick: 40 }; // 線の太さ(画面上の px)
const COLOR = 'rgba(150, 90, 220, 0.42)';

/** 画像を、長辺 MAX_SIDE 以下・指定の回転(90° 単位)で canvas に描く */
export function toSourceCanvas(img, quarterTurns = 0) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const q = ((quarterTurns % 4) + 4) % 4;
  const c = document.createElement('canvas');
  c.width = q % 2 ? h : w;
  c.height = q % 2 ? w : h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2);
  g.rotate((q * Math.PI) / 2);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

export class Marker {
  /**
   * @param {HTMLCanvasElement} canvas 表示用
   * @param {{onChange?: () => void}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onChange = opts.onChange || (() => {});
    this.img = null;
    this.src = null;
    this.turns = 0;
    this.zoom = 1;
    this.brush = 'medium';
    this.mode = 'draw'; // 'draw' | 'move'(Pencil がないときだけ使う)
    this.tool = 'box'; // 'box'(表を四角で囲む)| 'trace'(1 問ずつなぞる)
    this.box = null; // 囲んだ範囲 { x, y, w, h }(元画像の px)
    this.marks = []; // { points: [[x, y], ...], width }(元画像の px)
    this.current = null;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    globalThis.addEventListener('pointerup', (e) => this.up(e));
    this.updateTouchAction();
  }

  setImage(img) {
    this.img = img;
    this.turns = 0;
    this.zoom = 1;
    this.marks = [];
    this.box = null;
    this.src = toSourceCanvas(img, 0);
    this.layout();
    this.onChange();
  }

  rotate() {
    if (!this.img) return;
    this.turns = (this.turns + 1) % 4;
    this.src = toSourceCanvas(this.img, this.turns);
    this.marks = []; // 向きが変わるので、なぞった跡・囲んだ範囲は消す
    this.box = null;
    this.layout();
    this.onChange();
  }

  setZoom(z) {
    this.zoom = Math.max(1, Math.min(4, z));
    this.layout();
  }

  setTool(tool) {
    this.tool = tool;
    this.redraw();
    this.onChange();
  }

  setMode(mode) {
    this.mode = mode;
    this.updateTouchAction();
  }

  updateTouchAction() {
    // Pencil を使っているときは、指でスクロールできるようにする
    const fingerScrolls = input.penSeen || this.mode === 'move';
    this.canvas.style.touchAction = fingerScrolls ? 'pan-x pan-y pinch-zoom' : 'none';
  }

  /** 表示の大きさ(画面上の px)と、元画像の px への倍率 */
  layout() {
    if (!this.src) return;
    const box = this.canvas.parentElement;
    const avail = Math.max(200, (box && box.clientWidth) || 800);
    const cssW = Math.round(avail * this.zoom);
    const cssH = Math.round((cssW * this.src.height) / this.src.width);
    const dpr = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    // 大きくしすぎると iPad の canvas の上限を超えるので、描画の解像度は抑える
    const maxPx = 4096;
    const k = Math.min(dpr, maxPx / cssW, maxPx / cssH);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * k);
    this.canvas.height = Math.round(cssH * k);
    this.cssW = cssW;
    this.scale = this.src.width / cssW; // 画面 px → 元画像 px
    this.redraw();
  }

  toSource(e) {
    const r = this.rect || this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * this.scale, (e.clientY - r.top) * this.scale];
  }

  down(e) {
    if (!this.src) return;
    if (e.pointerType === 'pen' && !input.penSeen) {
      input.penSeen = true;
      this.updateTouchAction();
    }
    if (e.pointerType === 'touch' && (input.penSeen || this.mode === 'move')) return; // 指はスクロール
    if (e.pointerType === 'mouse' && (e.button !== 0 || this.mode === 'move')) return;
    if (this.current) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* window の pointerup で終える */
    }
    this.rect = this.canvas.getBoundingClientRect();
    const p = this.toSource(e);
    this.current =
      this.tool === 'box'
        ? { id: e.pointerId, box: true, start: p, end: p }
        : { id: e.pointerId, points: [p], width: BRUSH[this.brush] * this.scale };
    this.redraw();
  }

  move(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    e.preventDefault();
    let events = null;
    try {
      events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    } catch {
      events = null;
    }
    if (!events || !events.length) events = [e];
    if (this.current.box) this.current.end = this.toSource(events[events.length - 1]);
    else for (const ev of events) this.current.points.push(this.toSource(ev));
    this.redraw();
  }

  up(e) {
    if (!this.current || e.pointerId !== this.current.id) return;
    const m = this.current;
    this.current = null;
    this.rect = null;
    if (m.box) {
      const b = normBox(m.start, m.end, this.src);
      if (b.w > 20 * this.scale && b.h > 20 * this.scale) this.box = b; // 小さすぎる四角(タップ)は無視
    } else {
      this.marks.push({ points: m.points, width: m.width });
    }
    this.redraw();
    this.onChange();
  }

  undo() {
    if (this.tool === 'box') this.box = null;
    else this.marks.pop();
    this.redraw();
    this.onChange();
  }

  clear() {
    this.marks = [];
    this.box = null;
    this.redraw();
    this.onChange();
  }

  redraw() {
    if (!this.src) return;
    const g = this.canvas.getContext('2d');
    const k = this.canvas.width / this.src.width;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.src, 0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    // 囲んだ範囲(表)
    const box = this.current && this.current.box ? normBox(this.current.start, this.current.end, this.src) : this.tool === 'box' ? this.box : null;
    if (box) {
      g.fillStyle = 'rgba(150, 90, 220, 0.12)';
      g.fillRect(box.x, box.y, box.w, box.h);
      g.strokeStyle = '#5b2bb5';
      g.lineWidth = 3 * this.scale;
      g.setLineDash([10 * this.scale, 6 * this.scale]);
      g.strokeRect(box.x, box.y, box.w, box.h);
      g.setLineDash([]);
    }
    if (this.tool === 'box') return;
    const all = this.current && !this.current.box ? [...this.marks, this.current] : this.marks;
    all.forEach((m, i) => {
      g.strokeStyle = COLOR;
      g.lineWidth = m.width;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(m.points[0][0], m.points[0][1]);
      for (const p of m.points.slice(1)) g.lineTo(p[0], p[1]);
      if (m.points.length === 1) g.lineTo(m.points[0][0] + 0.1, m.points[0][1]);
      g.stroke();
      if (m === this.current) return;
      // 問題の番号
      const r = Math.max(12 * this.scale, m.width * 0.45);
      const [x, y] = m.points[0];
      g.fillStyle = '#5b2bb5';
      g.beginPath();
      g.arc(x, y - r * 1.2, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y - r * 1.2 + 1);
    });
  }
}

/** 2 点から、画像の中に収まる四角を作る */
function normBox(a, b, src) {
  const x0 = Math.max(0, Math.min(a[0], b[0])), y0 = Math.max(0, Math.min(a[1], b[1]));
  const x1 = Math.min(src.width, Math.max(a[0], b[0])), y1 = Math.min(src.height, Math.max(a[1], b[1]));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

