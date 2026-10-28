import { useLayoutEffect, useRef } from "react";
import { Brush, Check, Eraser, FlipHorizontal2, Minus, Redo2, Trash2, Undo2, Wand2 } from "lucide-react";
import { useT } from "../i18n";
import { DOODLE_COLORS, LayerCanvas, bitmapSize, type Stroke } from "../paint";
import { selCaps, useStore, type Attachment } from "../store";

const minDist = 0.5;     // mniejsze od pół piksela bitmapy ruchy nie dodają punktów

/** Dwie warstwy płótna (bazgroły pod maską) + obsługa pędzla. Wstawiane do `.pic`, więc skaluje się razem z obrazem. */
export function PaintCanvas({ att, dim, fitW }: { att: Attachment; dim: { w: number; h: number }; fitW: number }) {
  const doc = att.paint;
  const brush = useStore((s) => s.ui.brush);
  const layer = useStore((s) => s.ui.paintLayer);
  const tool = useStore((s) => s.ui.paintTool);
  const color = useStore((s) => s.ui.doodleColor);
  const commit = useStore((s) => s.paintCommit);

  const maskEl = useRef<HTMLCanvasElement>(null);
  const doodleEl = useRef<HTMLCanvasElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const lc = useRef<{ mask: LayerCanvas; doodle: LayerCanvas } | null>(null);
  const cur = useRef<Stroke | null>(null);
  const last = useRef<Stroke | null>(null);
  const rendered = useRef(0);
  const size = bitmapSize(dim.w, dim.h);

  useLayoutEffect(() => {
    lc.current = { mask: new LayerCanvas(maskEl.current!, "mask"), doodle: new LayerCanvas(doodleEl.current!, "doodle") };
    return () => { lc.current = null; };
  }, []);

  // pełne przerysowanie tylko wtedy, gdy zmiana nie pochodzi z dopiero co narysowanego pociągnięcia (undo/redo/clear/invert/rozmiar)
  useLayoutEffect(() => {
    const l = lc.current;
    if (!l) return;
    const r1 = l.mask.resize(size.w, size.h);
    const r2 = l.doodle.resize(size.w, size.h);
    const resized = r1 || r2;
    const n = doc.strokes.length;
    if (!resized && n === rendered.current + 1 && doc.strokes[n - 1] === last.current) { rendered.current = n; return; }
    l.mask.redraw(doc.strokes, doc.inverted);
    l.doodle.redraw(doc.strokes, doc.inverted);
    rendered.current = n;
  }, [doc.strokes, doc.inverted, size.w, size.h]);

  const norm = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = surface.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const place = (e: { clientX: number; clientY: number }) => {
    const el = cursor.current, sf = surface.current;
    if (!el || !sf) return;
    const r = sf.getBoundingClientRect();
    const k = r.width / (sf.offsetWidth || 1);
    el.style.display = "block";
    el.style.left = (e.clientX - r.left) / k + "px";
    el.style.top = (e.clientY - r.top) / k + "px";
  };
  const draw = (s: Stroke) => { lc.current?.mask.extend(s, doc.inverted); lc.current?.doodle.extend(s, doc.inverted); };

  const spaceDown = () => document.body.dataset.space === "1";

  return (
    <>
      <canvas ref={doodleEl} className="paintlayer doodle" width={size.w} height={size.h} />
      <canvas ref={maskEl} className="paintlayer mask" width={size.w} height={size.h} />
      <div
        ref={surface}
        className="paintsurface"
        onPointerDown={(e) => {
          if (e.button !== 0 || e.shiftKey || spaceDown()) return;       // środkowy / spacja / shift: przesuwanie widoku
          e.preventDefault();
          e.stopPropagation();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* syntetyczne zdarzenie */ }
          const s: Stroke = { layer, tool, size: brush, points: [norm(e)], ...(layer === "doodle" && tool === "brush" ? { color } : {}) };
          cur.current = s;
          draw(s);
        }}
        onPointerMove={(e) => {
          place(e);
          const s = cur.current;
          if (!s) return;
          // wszystkie pośrednie zdarzenia z danego kadru: bez nich szybki ruch zamienia się w łamaną
          const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
          const list = evs.length ? evs : [e.nativeEvent];
          const pts = s.points;
          let added = false;
          for (const ev of list) {
            const p = norm(ev);
            const q = pts[pts.length - 1];
            if (Math.hypot((p[0] - q[0]) * size.w, (p[1] - q[1]) * size.h) < minDist) continue;
            pts.push(p);
            added = true;
          }
          if (added) draw(s);
        }}
        onPointerUp={(e) => {
          const s = cur.current;
          if (!s) return;
          cur.current = null;
          try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* ignoruj */ }
          lc.current?.mask.finish(s, doc.inverted);
          lc.current?.doodle.finish(s, doc.inverted);
          last.current = s;
          commit(att.id, s);
        }}
        onPointerCancel={() => { cur.current = null; lc.current?.mask.redraw(doc.strokes, doc.inverted); lc.current?.doodle.redraw(doc.strokes, doc.inverted); }}
        onPointerLeave={() => { if (cursor.current && !cur.current) cursor.current.style.display = "none"; }}
      />
      <div
        ref={cursor}
        className={`brush-cursor ${tool}`}
        style={{ width: (brush / 1000) * fitW, height: (brush / 1000) * fitW, ...(layer === "doodle" && tool === "brush" ? { background: color + "55" } : {}) }}
      />
    </>
  );
}

/** Pływający pasek narzędzi (nakładka nad sceną, nie przesuwa obrazu); „—" zwija go do małego znacznika. */
export function PaintBar({ att }: { att: Attachment }) {
  const t = useT();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const s = useStore.getState;
  const doc = att.paint;
  const mask = ui.paintLayer === "mask";
  const colorInput = useRef<HTMLInputElement>(null);
  const noInpaint = !useStore(selCaps)?.modes.includes("inpaint");

  if (ui.paintBarMin) {
    return (
      <div className="paintbar mini">
        <button className="btn small" onClick={() => setUi({ paintBarMin: false })}><Brush size={14} /> {t("paint.title")}</button>
        <button className="btn small teal" onClick={() => s().paintOpen(null)}><Check size={14} /> {t("paint.done")}</button>
      </div>
    );
  }
  return (
    <div className="paintbar" role="toolbar" aria-label={t("paint.title")}>
      <div className="pb-row">
        <span className="seg tiny">
          <button className={mask ? "active" : ""} onClick={() => setUi({ paintLayer: "mask" })} title={`${t("paint.mask")} (M)`}><Wand2 size={12} /> {t("paint.mask")}</button>
          <button className={!mask ? "active" : ""} onClick={() => setUi({ paintLayer: "doodle" })} title={`${t("paint.doodle")} (D)`}><Brush size={12} /> {t("paint.doodle")}</button>
        </span>
        <span className="sep" />
        <button className={"btn small " + (ui.paintTool === "brush" ? "active" : "")} title={`${t("mask.brush")} (B)`} onClick={() => setUi({ paintTool: "brush" })}><Brush size={14} /></button>
        <button className={"btn small " + (ui.paintTool === "eraser" ? "active" : "")} title={`${t("mask.eraser")} (E)`} onClick={() => setUi({ paintTool: "eraser" })}><Eraser size={14} /></button>
        <input type="range" min={3} max={160} value={ui.brush} style={{ "--p": `${((ui.brush - 3) / 157) * 100}%` } as React.CSSProperties}
          onChange={(e) => setUi({ brush: Number(e.target.value) })} aria-label={t("mask.size")} title={`${t("mask.size")} ([ ])`} />
        <output>{ui.brush}</output>
        {!mask && (
          <>
            <span className="sep" />
            <span className="swatches">
              {DOODLE_COLORS.map((c) => (
                <button key={c} className={"swatch " + (ui.doodleColor === c ? "on" : "")} style={{ background: c }} aria-label={c} onClick={() => setUi({ doodleColor: c, paintTool: "brush" })} />
              ))}
              <button className="swatch custom" title={t("paint.color")} onClick={() => colorInput.current?.click()} style={{ background: DOODLE_COLORS.includes(ui.doodleColor) ? undefined : ui.doodleColor }} />
              <input ref={colorInput} type="color" value={ui.doodleColor} hidden onChange={(e) => setUi({ doodleColor: e.target.value, paintTool: "brush" })} />
            </span>
          </>
        )}
        {mask && (
          <>
            <span className="sep" />
            <button className={"btn small " + (doc.inverted ? "active" : "")} title={t("mask.invert")} onClick={() => s().paintInvert()}><FlipHorizontal2 size={14} /> <span className="word">{t("mask.invert")}</span></button>
          </>
        )}
        <span className="sep" />
        <button className="btn small" title={`${t("mask.undo")} (Ctrl+Z)`} disabled={!doc.strokes.length} onClick={() => s().paintUndo()}><Undo2 size={14} /></button>
        <button className="btn small" title={`${t("mask.redo")} (Ctrl+Y)`} disabled={!doc.redo.length} onClick={() => s().paintRedo()}><Redo2 size={14} /></button>
        <button className="btn small danger" title={mask ? t("paint.clearMask") : t("paint.clearDoodle")}
          disabled={!doc.strokes.some((x) => x.layer === ui.paintLayer) && !(mask && doc.inverted)} onClick={() => s().paintClear(ui.paintLayer)}><Trash2 size={14} /></button>
        <span className="sep" />
        <button className="btn small teal" onClick={() => s().paintOpen(null)} title="Enter"><Check size={14} /> {t("paint.done")}</button>
        <button className="btn small ghost" title={t("paint.minimize")} aria-label={t("paint.minimize")} onClick={() => setUi({ paintBarMin: true })}><Minus size={14} /></button>
      </div>
      <div className="pb-hint">
        {mask ? (noInpaint ? t("paint.noInpaint") : att.role === "edit" ? t("paint.maskHint") : t("paint.maskNotEdit")) : t("paint.doodleHint")}
      </div>
    </div>
  );
}
