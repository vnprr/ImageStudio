import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Heart, Image as ImageIcon, Maximize2, X } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import { clamp } from "../lib";
import { pendingJobs, useStore } from "../store";
import { imageMenu, showMenu } from "./ContextMenu";

export const THUMB_MIN = 44;
export const THUMB_MAX = 200;

/** Dolny pasek: ostatnie generacje + bieżące zadanie. Suwak ustala rozmiar miniatur, a tym samym wysokość paska. */
export function History() {
  const t = useT();
  const recent = useStore((s) => s.recent);
  const selectedId = useStore((s) => s.selectedId);
  const closed = useStore((s) => s.ui.historyClosed);
  const thumb = useStore((s) => s.ui.historyThumb);
  const setUi = useStore((s) => s.setUi);
  const select = useStore((s) => s.select);
  const setPage = useStore((s) => s.setPage);
  const jobs = useStore((s) => s.jobs);
  const cancel = useStore((s) => s.cancelJob);
  const strip = useRef<HTMLDivElement>(null);
  const list = pendingJobs(jobs).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.created_at - b.created_at);
  const pending = list.length;

  // kółko myszy przewija pasek w poziomie, Ctrl + kółko zmienia rozmiar miniatur
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const cur = useStore.getState().ui.historyThumb;
        useStore.getState().setUi({ historyThumb: clamp(Math.round(cur * (e.deltaY < 0 ? 1.08 : 1 / 1.08)), THUMB_MIN, THUMB_MAX) });
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [closed]);

  return (
    <div className={"history " + (closed ? "closed" : "")} style={{ ["--thumb" as string]: `${thumb}px` }}>
      <div className="history-head">
        <button className="link-btn" onClick={() => setUi({ historyClosed: !closed })} aria-expanded={!closed}>
          {closed ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t("history.title")} <span className="muted">· {recent.length}</span>
        </button>
        {pending > 0 && <span className="queue-pill">{t("gen.inQueue", { n: pending })}</span>}
        <span className="history-tools">
          {!closed && (
            <label className="size-slider" title={`${t("gallery.size")} (Ctrl + ${t("gallery.wheel")})`}>
              <ImageIcon size={11} />
              <input type="range" min={THUMB_MIN} max={THUMB_MAX} value={thumb} style={{ "--p": `${((thumb - THUMB_MIN) / (THUMB_MAX - THUMB_MIN)) * 100}%` } as React.CSSProperties}
                onChange={(e) => setUi({ historyThumb: Number(e.target.value) })} aria-label={t("gallery.size")} />
              <ImageIcon size={16} />
            </label>
          )}
          <button className="btn small ghost" title={t("gallery.openFull")} onClick={() => setPage("library")}><Maximize2 size={13} /> <span className="word">{t("gallery.openFull")}</span></button>
        </span>
      </div>
      {!closed && (
        <div className="history-strip" ref={strip}>
          {list.map((j, i) => (
            <div key={j.id} className={"thumbnail running " + (j.status === "queued" ? "queued" : "")} title={`${j.request.prompt.slice(0, 80)} — ${j.status === "running" ? t(`stage.${j.stage}`) : t("gen.queued")}`}>
              {j.status === "running" ? (
                <div className="ring" style={{ ["--p" as string]: `${Math.round(j.fraction * 100)}%`, ["--ring" as string]: `${Math.min(48, Math.round(thumb * 0.7))}px` }}>
                  <span>{Math.round(j.fraction * 100)}%</span>
                </div>
              ) : (
                <span className="qn">#{i + 1}</span>
              )}
              <button className="thumb-x" aria-label={t("cancel")} title={t("cancel")} onClick={() => void cancel(j.id)}><X size={11} /></button>
            </div>
          ))}
          {recent.length === 0 && list.length === 0 && <div className="muted history-empty">{t("history.empty")}</div>}
          {recent.map((r) => (
            <button key={r.id} className={"thumbnail " + (selectedId === r.id ? "active" : "")} onClick={() => select(r.id)} onContextMenu={(e) => showMenu(e, imageMenu(r))} title={r.prompt}>
              <img src={api.thumbUrl(r.id)} alt="" loading="lazy" decoding="async" draggable={false} />
              {r.favorite && <Heart size={11} className="fav-badge" fill="currentColor" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
