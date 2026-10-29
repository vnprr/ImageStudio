import { useCallback, useEffect, useRef, useState } from "react";
import { Heart, Info, Maximize, Minus, Pencil, Plus, X, ImageOff, Upload, Columns2 } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import { fmtBytes, fmtSec } from "../lib";
import { activeJobOf, pendingJobs, selSource, useStore } from "../store";
import type { ImageRecord, Job } from "../types";
import { imageMenu, showMenu } from "./ContextMenu";
import { PaintBar, PaintCanvas } from "./PaintLayer";
import { Empty } from "./ui";

// ------------------------------------------------------------------ postęp

function ProgressOverlay({ job, queued, compact }: { job: Job; queued: number; compact?: boolean }) {
  const t = useT();
  const cancel = useStore((s) => s.cancelJob);
  const running = job.status === "running";
  const pct = Math.round((job.fraction || 0) * 100);
  return (
    <div className={"loading " + (compact ? "compact" : "")} role="status" aria-live="polite">
      <div className="symbol">✦</div>
      <strong>{running ? t(`stage.${job.stage}`) : t("gen.queued")}</strong>
      <span className="loading-msg">{job.message ?? ""}</span>
      <div className="loadingtrack"><div style={{ width: `${running ? Math.max(3, pct) : 0}%` }} /></div>
      <span className="loading-sub">
        {running && job.stage === "denoising" && job.total_steps > 0 && `${t("gen.step")} ${job.step}/${job.total_steps}`}
        {running && job.image_count > 1 && ` · ${t("gen.image")} ${Math.min(job.image_index + 1, job.image_count)}/${job.image_count}`}
        {running && ` · ${pct}%`}
        {!running && job.queue_position != null && `${t("gen.position")} ${job.queue_position}`}
        {queued > 1 && ` · ${t("gen.inQueue", { n: queued })}`}
      </span>
      <button className="btn danger" onClick={() => void cancel(job.id)}><X size={14} /> {t("cancel")} <kbd>Esc</kbd></button>
    </div>
  );
}

// ------------------------------------------------------------------ scena

export function Stage() {
  const t = useT();
  const mode = useStore((s) => s.form.mode);
  const source = useStore(selSource);
  const paintAtt = useStore((s) => (s.paintId ? s.attachments.find((a) => a.id === s.paintId) ?? null : null));
  const selectedId = useStore((s) => s.selectedId);
  const cache = useStore((s) => s.cache);
  const compare = useStore((s) => s.compare);
  const jobs = useStore((s) => s.jobs);
  const online = useStore((s) => s.online);
  const formW = useStore((s) => s.form.width);
  const formH = useStore((s) => s.form.height);
  const dragging = useStore((s) => s.dragging);
  const hot = useStore((s) => s.hotZone) === "attach-stage";
  const selected: ImageRecord | null = selectedId ? cache[selectedId] ?? null : null;
  const active = activeJobOf(jobs);
  const queued = pendingJobs(jobs).length;

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  // adres obrazu, który już się wczytał; do tego czasu w ramce jest puste „płótno" w proporcjach nowego obrazu (bez deformacji starego)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [cmpAt, setCmpAt] = useState(50);
  const [dismissedErr, setDismissedErr] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const vp = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const painting = !!paintAtt;
  // Co pokazujemy: obraz otwarty do malowania, wynik (zaznaczony obraz) albo samo źródło, gdy nie ma jeszcze wyniku.
  const showSource = painting || (!selected && !!source && (mode === "edit" || mode === "inpaint"));
  const shown = painting ? paintAtt : source;
  const imgUrl = showSource ? shown?.url ?? null : (selected ? api.stageUrl(selected.id) : null);
  const known = showSource ? (shown?.width && shown?.height ? { w: shown.width, h: shown.height } : null) : selected ? { w: selected.width, h: selected.height } : null;
  const dim = known ?? nat ?? { w: formW, h: formH };
  const aspect = dim.w / dim.h;

  useEffect(() => { setNat(null); }, [imgUrl]);

  // przed/po
  const beforeId = selected?.sources.find((x) => x.role === "source")?.image_id ?? null;
  const beforeUrl = !showSource && selected ? (beforeId ? api.imageUrl(beforeId) : source && selected.mode !== "t2i" ? source.url : null) : null;
  const canCompare = !!beforeUrl && !painting;
  const comparing = compare && canCompare;

  // rozmiar widoku
  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const pad = 28;
  const fitW = Math.max(40, Math.min(box.w - pad * 2, (box.h - pad * 2) * aspect));
  const fitH = fitW / aspect;
  const actual = known ?? nat;
  const pct = actual ? Math.round(((fitW * zoom) / actual.w) * 100) : Math.round(zoom * 100);

  const fit = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { fit(); }, [imgUrl, fit]);

  const zoomBy = useCallback((f: number, cx = 0, cy = 0) => {
    setZoom((z) => {
      const nz = Math.min(24, Math.max(0.2, z * f));
      const k = nz / z;
      setPan((p) => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
      return nz;
    });
  }, []);

  useEffect(() => {
    const el = vp.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // skróty sceny przez zdarzenia z App
  useEffect(() => {
    const h = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "fit") fit();
      if (a === "in") zoomBy(1.25);
      if (a === "out") zoomBy(1 / 1.25);
    };
    window.addEventListener("stage", h);
    return () => window.removeEventListener("stage", h);
  }, [fit, zoomBy]);

  // spacja = tymczasowe przesuwanie w trybie malowania
  useEffect(() => {
    const dn = (e: KeyboardEvent) => { if (e.code === "Space" && !(e.target as HTMLElement).matches("input,textarea,select")) { document.body.dataset.space = "1"; if (painting) e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") delete document.body.dataset.space; };
    window.addEventListener("keydown", dn);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", dn); window.removeEventListener("keyup", up); };
  }, [painting]);

  const onDown = (e: React.PointerEvent) => {
    if (comparing && e.button === 0 && !(document.body.dataset.space === "1")) return;
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  };
  const onUp = () => { drag.current = null; setPanning(false); };

  const lastErr = Object.values(jobs).filter((j) => j.status === "error").sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0];
  const showErr = lastErr && lastErr.id !== dismissedErr && !active;
  const name = !showSource && selected ? selected.prompt : shown?.name ?? "";

  return (
    <div className={"stage dropzone " + (dragging ? "armed " : "") + (hot ? "hot" : "")} data-dropzone="attach" data-dropid="attach-stage" data-drop-label={t("drop.attach")}>
      <div className="stageinfo">
        <span className="stage-title">
          {showSource ? <span className="imagelabel src">{painting ? t("paint.title") : t("stage.source")}</span> : selected && <span className="imagelabel">{selected.model_name}</span>}
          <span className="trunc" title={name}>{name}</span>
        </span>
        <span className="zoombar">
          <button className="icon-btn" title={`${t("zoom.out")} (-)`} onClick={() => zoomBy(1 / 1.25)}><Minus size={14} /></button>
          <button className="zoom-pct" title={t("zoom.actual")} onClick={() => actual && setZoom(actual.w / fitW)}>{pct}%</button>
          <button className="icon-btn" title={`${t("zoom.in")} (+)`} onClick={() => zoomBy(1.25)}><Plus size={14} /></button>
          <button className="icon-btn" title={`${t("zoom.fit")} (0)`} onClick={fit}><Maximize size={14} /></button>
        </span>
      </div>

      <div
        ref={vp}
        className={"viewport " + (panning ? "grabbing " : "") + (painting ? "painting" : "")}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => { if (!painting) fit(); }}
        onContextMenu={(e) => { if (!painting && selected && !showSource) showMenu(e, imageMenu(selected)); }}
      >
        {imgUrl ? (
          <div className={"pic " + (loadedUrl === imgUrl ? "" : "loading")} style={{ width: fitW, height: fitH, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <img
              key={imgUrl}
              ref={(el) => { if (el && el.complete && el.naturalWidth && loadedUrl !== imgUrl) setLoadedUrl(imgUrl); }}
              src={imgUrl}
              alt={name}
              draggable={false}
              className={loadedUrl === imgUrl ? "ready" : ""}
              onLoad={(e) => { setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); setLoadedUrl(imgUrl); }}
              onError={() => setLoadedUrl(imgUrl)}
            />
            {comparing && beforeUrl && (
              <>
                <img src={beforeUrl} alt="" draggable={false} className="before" style={{ clipPath: `inset(0 ${100 - cmpAt}% 0 0)` }} />
                <div className="cutline" style={{ left: `${cmpAt}%` }} />
                <span className="cmp-label l">{t("compare.before")}</span>
                <span className="cmp-label r">{t("compare.after")}</span>
                <input className="compare-range" type="range" min={0} max={100} step={0.1} value={cmpAt} onChange={(e) => setCmpAt(Number(e.target.value))} aria-label={t("compare")} />
              </>
            )}
            {painting && paintAtt && <PaintCanvas key={paintAtt.id} att={paintAtt} dim={dim} fitW={fitW} />}
          </div>
        ) : (
          <div className="stage-empty">
            {(mode === "edit" || mode === "inpaint") && !source ? (
              <Empty icon={<Upload size={30} />} title={t("stage.dropSource")} hint={t("stage.dropSourceHint")} />
            ) : (
              <Empty icon={<ImageOff size={30} />} title={online ? t("stage.empty") : t("offline.title")} hint={t("stage.emptyHint")} />
            )}
          </div>
        )}
        {active && <ProgressOverlay job={active} queued={queued} compact={painting} />}
        {showErr && (
          <div className="error-panel" role="alert">
            <div>
              <b>{t("err.job")}</b>
              <p>{lastErr.error}</p>
            </div>
            <button className="icon-btn" aria-label={t("close")} onClick={() => setDismissedErr(lastErr.id)}><X size={14} /></button>
          </div>
        )}
      </div>

      {painting && paintAtt && <PaintBar att={paintAtt} />}
      <StageFoot selected={showSource ? null : selected} canCompare={canCompare} />
    </div>
  );
}

// ------------------------------------------------------------------ stopka z wydajnością i akcjami

function StageFoot({ selected, canCompare }: { selected: ImageRecord | null; canCompare: boolean }) {
  const t = useT();
  const compare = useStore((s) => s.compare);
  const patch = useStore((s) => s.patchImage);
  const useAsSource = useStore((s) => s.useAsSource);
  const openDetails = useStore((s) => s.openDetails);
  const tm = selected?.timings;
  return (
    <div className="stagefoot">
      <div className="perf-chips">
        {selected && (
          <>
            <span>{selected.width}×{selected.height}</span>
            <span>seed {selected.seed}</span>
            {tm ? (
              <>
                <span className={"tag " + (tm.cold ? "cold" : "warm")}>{tm.cold ? t("perf.cold") : t("perf.warm")}</span>
                <span title={t("perf.total")}><b>{fmtSec(tm.total)}</b></span>
                {tm.load > 0 && <span>{t("perf.load")} {fmtSec(tm.load)}</span>}
                <span>{t("perf.encode")} {fmtSec(tm.encode)}</span>
                <span>{t("perf.denoise")} {fmtSec(tm.denoise)}</span>
                <span>VAE {fmtSec(tm.vae)}</span>
                <span>VRAM ↑ {fmtBytes(tm.peak_vram)}</span>
              </>
            ) : selected.gen_seconds != null ? <span><b>{fmtSec(selected.gen_seconds)}</b></span> : null}
          </>
        )}
      </div>
      {selected && (
        <div className="foot-actions">
          <button className={"btn small " + (compare ? "active" : "")} disabled={!canCompare} title={canCompare ? `${t("compare")} (C)` : t("compare.none")} onClick={() => useStore.setState({ compare: !compare })}>
            <Columns2 size={14} /> <span className="word">{t("compare")}</span>
          </button>
          <button className={"btn small " + (selected.favorite ? "fav" : "")} title={`${t("favorite")} (F)`} onClick={() => void patch(selected.id, { favorite: !selected.favorite })}>
            <Heart size={14} fill={selected.favorite ? "currentColor" : "none"} />
          </button>
          <button className="btn small" onClick={() => useAsSource(selected)}><Pencil size={14} /> <span className="word">{t("edit")}</span></button>
          <button className="btn small" onClick={() => openDetails(selected.id)}><Info size={14} /> <span className="word">{t("details")}</span></button>
        </div>
      )}
    </div>
  );
}
