import { useCallback, useEffect, useRef, useState } from "react";

export interface Tick { y: number; label: string }

/** Oś czasu przy przewijaniu: cienki pasek z uchwytem, znacznikami miesięcy i dymkiem z datą widoczną podczas przewijania.
 *  Przeciągnięcie uchwytu (albo kliknięcie w pasek) skacze do dowolnego miejsca, np. do września dwa lata temu. */
export function Scrubber({ el, ticks, labelAt, deps }: { el: HTMLElement | null; ticks: Tick[]; labelAt: (scrollTop: number) => string; deps?: unknown }) {
  const rail = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0);
  const [label, setLabel] = useState("");
  const [awake, setAwake] = useState(false);
  const [drag, setDrag] = useState(false);
  const [railH, setRailH] = useState(0);
  const [scrollable, setScrollable] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const sync = useCallback((wake: boolean) => {
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollable(max > 40);
    setRatio(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
    setLabel(labelAt(el.scrollTop));
    if (wake) {
      setAwake(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAwake(false), 1100);
    }
  }, [el, labelAt]);

  useEffect(() => {
    if (!el) return;
    const on = () => sync(true);
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(() => { sync(false); setRailH(rail.current?.clientHeight ?? 0); });
    ro.observe(el);
    if (rail.current) ro.observe(rail.current);
    sync(false);
    return () => { el.removeEventListener("scroll", on); ro.disconnect(); window.clearTimeout(timer.current); };
  }, [el, sync]);

  useEffect(() => { sync(false); }, [deps, ticks, sync]);

  const seek = (clientY: number) => {
    if (!el || !rail.current) return;
    const r = rail.current.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    el.scrollTop = k * (el.scrollHeight - el.clientHeight);
  };

  if (!scrollable) return null;
  const max = el ? el.scrollHeight - el.clientHeight : 1;
  let lastY = -99;
  const shown = ticks.filter((t) => {
    const y = Math.min(1, t.y / Math.max(1, max)) * railH;
    if (y - lastY < 30) return false;
    lastY = y;
    return true;
  });

  return (
    <div
      ref={rail}
      className={"scrubber " + (awake || drag ? "awake " : "") + (drag ? "drag" : "")}
      role="scrollbar"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={(e) => { e.preventDefault(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* wskaźnik już nieaktywny */ } setDrag(true); seek(e.clientY); }}
      onPointerMove={(e) => { if (drag) seek(e.clientY); }}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
    >
      {shown.map((t, i) => (
        <span key={i} className="scrub-tick" style={{ top: `${Math.min(1, t.y / Math.max(1, max)) * 100}%` }}>{t.label}</span>
      ))}
      <span className="scrub-thumb" style={{ top: `${ratio * 100}%` }}>
        {(awake || drag) && label && <span className="scrub-bubble">{label}</span>}
      </span>
    </div>
  );
}
