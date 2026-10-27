// Malowanie na obrazach wejściowych: maska inpaintingu (fioletowa nakładka) i bazgroły (kolorowe pociągnięcia na obrazie).
//
// Pociągnięcia są zapisane znormalizowane (0..1), a grubość pędzla jako promil szerokości obrazu (size/1000), więc
// niczego nie wiążą z rozdzielczością podglądu ani poziomem powiększenia. Bitmapa płótna ma stały rozmiar zależny od
// obrazu (nie od zoomu), a nowe odcinki dorysowują się przyrostowo: koszt ruchu myszy nie rośnie z liczbą pociągnięć.

export type Layer = "mask" | "doodle";

export interface Stroke {
  layer: Layer;
  tool: "brush" | "eraser";
  size: number;
  color?: string;
  points: [number, number][];
}

export interface PaintDoc {
  strokes: Stroke[];
  redo: Stroke[];
  inverted: boolean;
}

export const emptyPaint = (): PaintDoc => ({ strokes: [], redo: [], inverted: false });

export const MASK_TINT = "rgb(190,130,250)";
export const DOODLE_COLORS = ["#ff3d81", "#ff8a3d", "#ffd23d", "#2ee6a6", "#38d6ff", "#8b5cf6", "#ffffff", "#000000"];

/** Bitmapa płótna: dłuższy bok jak w obrazie, ale w granicach 1024..2048 px (ostre krawędzie przy zoomie). */
export function bitmapSize(natW: number, natH: number): { w: number; h: number } {
  const long = Math.min(2048, Math.max(1024, Math.max(natW, natH)));
  const k = long / Math.max(natW, natH);
  return { w: Math.max(1, Math.round(natW * k)), h: Math.max(1, Math.round(natH * k)) };
}

function setup(ctx: CanvasRenderingContext2D, s: Stroke, inverted: boolean, w: number) {
  // W odwróconej masce nakładka pokazuje obszar, który zostanie zmieniony, więc pędzel „odsłania" tło, a gumka je zakrywa.
  const erase = (s.tool === "eraser") !== (s.layer === "mask" && inverted);
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  const color = s.layer === "mask" ? MASK_TINT : s.color ?? "#ff3d81";
  ctx.strokeStyle = erase ? "#000" : color;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = Math.max(1, (s.size / 1000) * w);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Dorysowuje punkty od indeksu `from` (krzywe kwadratowe przez punkty środkowe: gładka linia bez załamań). */
function drawFrom(ctx: CanvasRenderingContext2D, s: Stroke, from: number, w: number, h: number, final: boolean) {
  const p = s.points;
  if (!p.length) return;
  if (p.length === 1) {
    if (final || from === 0) { ctx.beginPath(); ctx.arc(p[0][0] * w, p[0][1] * h, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  ctx.beginPath();
  const start = from <= 1 ? p[0] : mid(p[from - 1], p[from]);
  ctx.moveTo(start[0] * w, start[1] * h);
  for (let i = Math.max(1, from); i < p.length - 1; i++) {
    const m = mid(p[i], p[i + 1]);
    ctx.quadraticCurveTo(p[i][0] * w, p[i][1] * h, m[0] * w, m[1] * h);
  }
  if (final) ctx.lineTo(p[p.length - 1][0] * w, p[p.length - 1][1] * h);
  ctx.stroke();
}

/** Płótno jednej warstwy z przyrostowym rysowaniem. */
export class LayerCanvas {
  private cur: { s: Stroke; drawn: number } | null = null;
  constructor(readonly canvas: HTMLCanvasElement, readonly layer: Layer) {}

  get ctx() { return this.canvas.getContext("2d")!; }

  resize(w: number, h: number): boolean {
    if (this.canvas.width === w && this.canvas.height === h) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  /** Pełne przerysowanie (undo/redo/odwrócenie/zmiana rozmiaru). */
  redraw(strokes: Stroke[], inverted: boolean) {
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    if (this.layer === "mask" && inverted) { ctx.fillStyle = MASK_TINT; ctx.fillRect(0, 0, w, h); }
    for (const s of strokes) {
      if (s.layer !== this.layer) continue;
      setup(ctx, s, inverted, w);
      drawFrom(ctx, s, 0, w, h, true);
    }
    ctx.globalCompositeOperation = "source-over";
    this.cur = null;
  }

  /** Dorysuj nowe punkty bieżącego pociągnięcia (dla innej warstwy nic nie robi). */
  extend(s: Stroke, inverted: boolean) {
    if (s.layer !== this.layer) return;
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    if (!this.cur || this.cur.s !== s) this.cur = { s, drawn: 0 };
    setup(ctx, s, inverted, w);
    const n = s.points.length;
    if (n === 1) drawFrom(ctx, s, 0, w, h, true);
    else if (n > this.cur.drawn) drawFrom(ctx, s, Math.max(1, this.cur.drawn), w, h, false);
    this.cur.drawn = Math.max(this.cur.drawn, n - 1);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Domknij pociągnięcie (ostatni odcinek do ostatniego punktu). */
  finish(s: Stroke, inverted: boolean) {
    if (s.layer !== this.layer) return;
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    setup(ctx, s, inverted, w);
    const p = s.points;
    if (p.length > 1) {
      const a = p.length === 2 ? p[0] : mid(p[p.length - 2], p[p.length - 1]);
      ctx.beginPath();
      ctx.moveTo(a[0] * w, a[1] * h);
      ctx.lineTo(p[p.length - 1][0] * w, p[p.length - 1][1] * h);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    this.cur = null;
  }
}

export const hasMask = (d: PaintDoc): boolean => d.inverted || d.strokes.some((s) => s.layer === "mask" && s.tool === "brush");
export const hasDoodle = (d: PaintDoc): boolean => d.strokes.some((s) => s.layer === "doodle" && s.tool === "brush");

/** PNG maski: biały = zmieniaj, czarny = zachowaj. Dłuższy bok ograniczony do maxSide. */
export async function renderMaskPng(d: PaintDoc, aspect: number, maxSide = 1024): Promise<Blob> {
  const w = aspect >= 1 ? maxSide : Math.round(maxSide * aspect);
  const h = aspect >= 1 ? Math.round(maxSide / aspect) : maxSide;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lc = layer.getContext("2d")!;
  for (const s of d.strokes) {
    if (s.layer !== "mask") continue;
    const erase = s.tool === "eraser";
    lc.globalCompositeOperation = erase ? "destination-out" : "source-over";
    lc.strokeStyle = lc.fillStyle = "#fff";
    lc.lineWidth = Math.max(1, (s.size / 1000) * w);
    lc.lineCap = lc.lineJoin = "round";
    drawFrom(lc, s, 0, w, h, true);
  }
  lc.globalCompositeOperation = "source-over";

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  if (!d.inverted) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(layer, 0, 0);
  } else {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    const black = document.createElement("canvas");
    black.width = w;
    black.height = h;
    const bc = black.getContext("2d")!;
    bc.drawImage(layer, 0, 0);
    bc.globalCompositeOperation = "source-in";
    bc.fillStyle = "#000";
    bc.fillRect(0, 0, w, h);
    ctx.drawImage(black, 0, 0);
  }
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("mask"))), "image/png"));
}

/** Obraz z naniesionymi bazgrołami w pełnej (ograniczonej do 2048 px) rozdzielczości: to idzie do modelu zamiast oryginału. */
export async function renderDoodled(url: string, d: PaintDoc): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("image"));
    im.src = url;
  });
  const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  // bazgroły na osobnej warstwie, żeby gumka nie wycinała oryginału
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lc = new LayerCanvas(layer, "doodle");
  lc.redraw(d.strokes, false);
  ctx.drawImage(layer, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("doodle"))), "image/png"));
}
