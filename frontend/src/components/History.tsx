import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, ChevronUp, Heart, Maximize2, X } from "lucide-react";
import { api } from "../api";
import { getLang, useT } from "../i18n";
import { clamp, fmtDayHead, startImageDrag } from "../lib";
import { pendingJobs, useStore } from "../store";
import type { ImageRecord } from "../types";
import { imageMenu, showMenu } from "./ContextMenu";

export const HIST_MIN = 96;
export const HIST_MAX = 420;
const HEAD_H = 36;
const CHROME = HEAD_H + 34;               // nagłówek + pasek przewijania i odstępy
const PAGE = 60;

/** Dzień lokalny (RRRR-MM-DD) z czasu w milisekundach. */
const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Dolna historia: strumień wszystkich obrazów od najnowszych (doczytuje się przy przewijaniu), z datami. Wysokość zmienia się
 *  uchwytem na górnej krawędzi, tak jak szerokość panelu parametrów. */
export function History() {
  const t = useT();
  const selectedId = useStore((s) => s.selectedId);
  const closed = useStore((s) => s.ui.historyClosed);
  const height = useStore((s) => s.ui.historyH);
  const group = useStore((s) => s.ui.groupByDay);
  const setUi = useStore((s) => s.setUi);
  const select = useStore((s) => s.select);
  const putImage = useStore((s) => s.putImage);
  const setPage = useStore((s) => s.setPage);
  const version = useStore((s) => s.libraryVersion);
  const jobs = useStore((s) => s.jobs);
  const cancel = useStore((s) => s.cancelJob);
  const strip = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const [items, setItems] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [bubble, setBubble] = useState("");
  const [awake, setAwake] = useState(false);
  const wake = useRef<number | undefined>(undefined);
  const lang = getLang();
  const list = pendingJobs(jobs).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.created_at - b.created_at);
  const pending = list.length;
  const thumb = clamp(height - CHROME, 44, 320);

  // pierwsza strona i odświeżenie po zmianie biblioteki (nowy obraz, ulubione, ukrycie); doczytane dalsze strony zostają
  useEffect(() => {
    let live = true;
    const keep = Math.max(PAGE, items.length);
    api.images({ limit: Math.min(keep, 500), offset: 0, sort: "new", filter: "all" }).then((r) => {
      if (!live) return;
      r.items.forEach(putImage);
      setItems(r.items);
      setTotal(r.total);
    }).catch(() => {});
    return () => { live = false; };
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    if (loading.current || items.length >= total) return;
    loading.current = true;
    api.images({ limit: PAGE, offset: items.length, sort: "new", filter: "all" }).then((r) => {
      r.items.forEach(putImage);
      setItems((cur) => (cur.length === items.length ? [...cur, ...r.items] : cur));
      setTotal(r.total);
    }).catch(() => {}).finally(() => { loading.current = false; });
  }, [items.length, total, putImage]);

  // przewijanie: kółko = poziomo, Ctrl + kółko = wysokość paska; doczytywanie; dymek z datą pierwszego widocznego obrazu
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const cur = useStore.getState().ui.historyH;
        useStore.getState().setUi({ historyH: clamp(Math.round(cur * (e.deltaY < 0 ? 1.08 : 1 / 1.08)), HIST_MIN, HIST_MAX) });
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    const onScroll = (e?: Event) => {
      if (el.scrollWidth - el.scrollLeft - el.clientWidth < 700) more();
      const first = [...el.querySelectorAll<HTMLElement>("[data-ms]")].find((c) => c.offsetLeft + c.offsetWidth > el.scrollLeft + 4);
      if (first?.dataset.ms) {
        setBubble(fmtDayHead(dayKey(Number(first.dataset.ms)), lang, t("date.today"), t("date.yesterday")));
        if (e) {
          setAwake(true);
          window.clearTimeout(wake.current);
          wake.current = window.setTimeout(() => setAwake(false), 1000);
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => { el.removeEventListener("wheel", onWheel); el.removeEventListener("scroll", onScroll); };
  }, [closed, more, lang, t]);

  // uchwyt zmiany wysokości (górna krawędź paska)
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = useStore.getState().ui.historyH;
    const move = (ev: PointerEvent) => setUi({ historyH: clamp(h0 + (y0 - ev.clientY), HIST_MIN, HIST_MAX) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("resizing-y"); };
    document.body.classList.add("resizing-y");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  let prevDay = "";
  return (
    <div className={"history " + (closed ? "closed" : "")} style={{ ["--thumb" as string]: `${thumb}px`, ...(closed ? {} : { height, minHeight: height }) }}>
      {!closed && (
        <div className="history-resizer" role="separator" aria-orientation="horizontal" tabIndex={0} aria-label={t("history.resize")} onPointerDown={startResize}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            setUi({ historyH: clamp(height + (e.key === "ArrowUp" ? 16 : -16), HIST_MIN, HIST_MAX) });
          }}><span /></div>
      )}
      <div className="history-head">
        <button className="link-btn" onClick={() => setUi({ historyClosed: !closed })} aria-expanded={!closed}>
          {closed ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {t("history.title")} <span className="muted">· {total || items.length}</span>
        </button>
        {pending > 0 && <span className="queue-pill">{t("gen.inQueue", { n: pending })}</span>}
        <span className="history-tools">
          {!closed && (
            <button className={"btn small ghost " + (group ? "active" : "")} aria-pressed={group} title={t("gallery.group")} onClick={() => setUi({ groupByDay: !group })}><CalendarDays size={13} /></button>
          )}
          <button className="btn small ghost" title={t("gallery.openFull")} onClick={() => setPage("library")}><Maximize2 size={13} /> <span className="word">{t("gallery.openFull")}</span></button>
        </span>
      </div>
      {!closed && (
        <div className="history-wrap">
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
            {items.length === 0 && list.length === 0 && <div className="muted history-empty">{t("history.empty")}</div>}
            {items.map((r) => {
              const dk = dayKey(r.created_at);
              const head = group && dk !== prevDay;
              prevDay = dk;
              return (
                <div key={r.id} className="hitem" data-ms={r.created_at}>
                  {head && <span className="hday" title={dk}>{fmtDayHead(dk, lang, t("date.today"), t("date.yesterday")).replace(/^\p{L}+, /u, "")}</span>}
                  <button className={"thumbnail " + (selectedId === r.id ? "active" : "")} draggable onDragStart={(e) => startImageDrag(e, r.id)}
                    onClick={() => select(r.id)} onContextMenu={(e) => showMenu(e, imageMenu(r))}
                    title={`${r.prompt || "—"}\n${new Date(r.created_at).toLocaleString(lang)}`}>
                    <img src={api.thumbUrl(r.id)} alt="" loading="lazy" decoding="async" draggable={false} />
                    {r.favorite && <Heart size={11} className="fav-badge" fill="currentColor" />}
                  </button>
                </div>
              );
            })}
          </div>
          {awake && bubble && <span className="history-bubble">{bubble}</span>}
        </div>
      )}
    </div>
  );
}
