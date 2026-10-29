import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CalendarDays, EyeOff, Heart, Image as ImageIcon, ImageOff, LayoutGrid, List, Plus, Search } from "lucide-react";
import { api } from "../api";
import { useT, getLang } from "../i18n";
import { clamp, fmtDate, fmtDayHead, fmtMonth, startImageDrag } from "../lib";
import { useStore } from "../store";
import type { ImageFilter, ImageRecord, ImageSort } from "../types";
import { imageMenu, showMenu } from "./ContextMenu";
import { Scrubber, type Tick } from "./Scrubber";
import { Empty, Spinner } from "./ui";

const PAGE = 120;
const GAP = 16;
const LIST_GAP = 8;
const HEAD_H = 40;

interface Row { kind: "head" | "items"; day: string; count: number; start: number; n: number }

/** Wirtualizowana siatka: renderowane są tylko widoczne wiersze, dane doładowywane stronami. */
export function Library() {
  const t = useT();
  const models = useStore((s) => s.models);
  const version = useStore((s) => s.libraryVersion);
  const openDetails = useStore((s) => s.openDetails);
  const putImage = useStore((s) => s.putImage);
  const patchImage = useStore((s) => s.patchImage);
  const addFiles = useStore((s) => s.addFiles);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const dragging = useStore((s) => s.dragging);
  const hot = useStore((s) => s.hotZone) === "library";

  const [query, setQuery] = useState("");
  const [dq, setDq] = useState("");
  const [filter, setFilter] = useState<ImageFilter>("all");
  const [sort, setSort] = useState<ImageSort>("new");
  const [modelId, setModelId] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [items, setItems] = useState<Map<number, ImageRecord>>(new Map());
  const [days, setDays] = useState<{ day: string; count: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(900);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScroller = useCallback((el: HTMLDivElement | null) => { scroller.current = el; setScrollEl(el); }, []);
  const inflight = useRef<Set<number>>(new Set());
  const gen = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { const id = window.setTimeout(() => setDq(query), 220); return () => window.clearTimeout(id); }, [query]);

  const fetchPage = useCallback(async (page: number, generation: number) => {
    if (inflight.current.has(page)) return;
    inflight.current.add(page);
    try {
      const r = await api.images({ query: dq, filter, sort, model_id: modelId || undefined, limit: PAGE, offset: page * PAGE });
      if (generation !== gen.current) return;
      r.items.forEach(putImage);
      setTotal(r.total);
      setError(null);
      setItems((prev) => {
        const m = new Map(prev);
        r.items.forEach((it, i) => m.set(page * PAGE + i, it));
        return m;
      });
    } catch (e) {
      if (generation === gen.current) setError((e as Error).message);
    } finally {
      inflight.current.delete(page);
    }
  }, [dq, filter, sort, modelId, putImage]);

  // zmiana zapytania: pełny reset (z powrotem na górę)
  useEffect(() => {
    gen.current++;
    inflight.current.clear();
    setItems(new Map());
    setTotal(null);
    scroller.current?.scrollTo({ top: 0 });
    void fetchPage(0, gen.current);
  }, [fetchPage]);

  // liczba obrazów w dniach (nagłówki i oś czasu); odświeżana razem z listą
  useEffect(() => {
    let live = true;
    api.libraryDays({ query: dq, filter, sort, model_id: modelId || undefined }).then((d) => { if (live) setDays(d); }).catch(() => { if (live) setDays([]); });
    return () => { live = false; };
  }, [dq, filter, sort, modelId, version]);

  // zmiana zawartości (nowy obraz, ulubione, ukrycie): odśwież widoczne strony bez skakania scrolla
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) { firstVersion.current = false; return; }
    gen.current++;
    inflight.current.clear();
    setItems(new Map());
    void fetchPage(0, gen.current);
  }, [version, fetchPage]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const inner = Math.max(200, width - (width <= 820 ? 28 : 56));
  const narrow = width < 520;
  const canList = width >= 520;                                   // widok listy ma sens tylko przy dość szerokim oknie
  const view: "grid" | "list" = canList ? ui.galleryView : "grid";
  const thumbSize = view === "list" ? ui.listThumb : ui.galleryThumb;
  const setThumbSize = (v: number) => setUi(view === "list" ? { listThumb: v } : { galleryThumb: v });
  const listThumb = clamp(ui.listThumb, 40, 360);
  const gap = view === "list" ? LIST_GAP : GAP;
  const eff = narrow ? Math.min(ui.galleryThumb, Math.floor((inner - GAP) / 2)) : ui.galleryThumb;   // na telefonie zawsze co najmniej 2 kolumny
  const cols = view === "list" ? 1 : Math.max(1, Math.floor((inner + GAP) / (eff + GAP)));
  const cardW = (inner - gap * (cols - 1)) / cols;
  const itemH = view === "list" ? listThumb + 14 : cardW * 1.25 + 50;
  const grouped = ui.groupByDay && !!days && days.length > 0;

  // układ wierszy: opcjonalne nagłówki dni + wiersze obrazów; indeks pierwszego obrazu każdego dnia daje oś czasu
  const layout = useMemo(() => {
    const rows: Row[] = [];
    const dayStart: number[] = [];
    let acc = 0;
    if (!days || total == null) return { rows, dayStart, sizes: [] as number[], offsets: [] as number[], height: 0 };
    if (grouped) {
      for (const d of days) {
        dayStart.push(acc);
        rows.push({ kind: "head", day: d.day, count: d.count, start: acc, n: 0 });
        for (let k = 0; k < d.count; k += cols) rows.push({ kind: "items", day: d.day, count: d.count, start: acc + k, n: Math.min(cols, d.count - k) });
        acc += d.count;
      }
    } else {
      for (const d of days) { dayStart.push(acc); acc += d.count; }
      for (let k = 0; k < total; k += cols) rows.push({ kind: "items", day: "", count: 0, start: k, n: Math.min(cols, total - k) });
    }
    const sizes = rows.map((r) => (r.kind === "head" ? HEAD_H : itemH) + gap);
    const offsets: number[] = [];
    let y = 0;
    for (const sz of sizes) { offsets.push(y); y += sz; }
    return { rows, dayStart, sizes, offsets, height: y };
  }, [days, total, grouped, cols, itemH, gap]);

  const virt = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => layout.sizes[i] ?? itemH + gap,
    overscan: 4,
  });
  const vItems = virt.getVirtualItems();
  useEffect(() => { virt.measure(); }, [layout, virt]);

  // Ctrl + kółko zmienia rozmiar kafelków (bez tego Edge powiększałby całą stronę)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const st = useStore.getState();
      const list = st.ui.galleryView === "list" && el.clientWidth >= 520;
      const cur = list ? st.ui.listThumb : st.ui.galleryThumb;
      const next = clamp(Math.round(cur * (e.deltaY < 0 ? 1.08 : 1 / 1.08)), list ? 40 : 110, list ? 360 : 420);
      st.setUi(list ? { listThumb: next } : { galleryThumb: next });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // doładuj brakujące strony widocznych wierszy
  useEffect(() => {
    if (total == null) return;
    const need = new Set<number>();
    for (const v of vItems) {
      const r = layout.rows[v.index];
      if (!r || r.kind === "head") continue;
      for (let c = 0; c < r.n; c++) { const idx = r.start + c; if (idx < total && !items.has(idx)) need.add(Math.floor(idx / PAGE)); }
    }
    need.forEach((p) => void fetchPage(p, gen.current));
  }, [vItems, items, layout, total, fetchPage]);

  // etykiety osi czasu: dzień widocznego miejsca i znaczniki miesięcy
  const lang = getLang();
  const dayOfIndex = useCallback((idx: number) => {
    const ds = layout.dayStart;
    let lo = 0, hi = ds.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ds[mid] <= idx) lo = mid; else hi = mid - 1; }
    return days?.[lo]?.day ?? "";
  }, [layout.dayStart, days]);
  const labelAt = useCallback((top: number) => {
    let lo = 0, hi = layout.offsets.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (layout.offsets[mid] <= top + 8) lo = mid; else hi = mid - 1; }
    const r = layout.rows[lo];
    return r ? fmtDayHead(dayOfIndex(r.start), lang, t("date.today"), t("date.yesterday")) : "";
  }, [layout, dayOfIndex, lang, t]);
  const ticks = useMemo<Tick[]>(() => {
    if (!days) return [];
    const out: Tick[] = [];
    let prev = "";
    days.forEach((d, i) => {
      const m = d.day.slice(0, 7);
      if (m === prev) return;
      prev = m;
      const rowIdx = layout.rows.findIndex((r) => r.start === layout.dayStart[i]);
      out.push({ y: layout.offsets[Math.max(0, rowIdx)] ?? 0, label: fmtMonth(d.day, lang) });
    });
    return out;
  }, [days, layout, lang]);

  const filterBtn = useMemo<[ImageFilter, string][]>(() => [["all", t("lib.all")], ["favorite", t("lib.favorites")], ["hidden", t("lib.hidden")]], [t]);

  const toggleFav = (it: ImageRecord, idx: number) =>
    void patchImage(it.id, { favorite: !it.favorite }).then(() => setItems((m) => new Map(m).set(idx, { ...it, favorite: !it.favorite })));

  const sizeMin = view === "list" ? 40 : 110;
  const sizeMax = view === "list" ? 360 : 420;

  return (
    <div className={"gallery-page dropzone " + (dragging ? "armed " : "") + (hot ? "hot" : "")} data-dropzone="library" data-drop-label={t("drop.library")}>
      <div className="gallery-head">
        <div className="gallery-title">
          <h2>{t("lib.title")}</h2>
          <p>{total == null ? <Spinner /> : t("lib.count", { n: total })}</p>
        </div>
        <div className="gallery-controls">
          <div className="search-wrap">
            <Search size={14} />
            <input type="search" value={query} placeholder={t("lib.search")} onChange={(e) => setQuery(e.target.value)} aria-label={t("lib.search")} />
          </div>
          <div className="seg">
            {filterBtn.map(([k, label]) => <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{label}</button>)}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as ImageSort)} aria-label={t("lib.sort")}>
            <option value="new">{t("lib.newest")}</option>
            <option value="old">{t("lib.oldest")}</option>
          </select>
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} aria-label={t("lib.model")}>
            <option value="">{t("lib.allModels")}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button className="btn blue" onClick={() => fileInput.current?.click()}><Plus size={14} /> <span className="word">{t("lib.import")}</span></button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files], "library"); e.target.value = ""; }} />
        </div>

      </div>

      <div className="gallery-body">
      <div className="gallery" ref={setScroller}>
        {error && <div className="error-inline" role="alert">{error} <button className="link" onClick={() => void fetchPage(0, gen.current)}>{t("retry")}</button></div>}

        {total === 0 ? (
          <Empty icon={<ImageOff size={30} />} title={query || filter !== "all" || modelId ? t("lib.noResults") : t("lib.empty")} hint={query || filter !== "all" ? undefined : t("lib.emptyHint")} />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative", width: "100%" }}>
            {vItems.map((v) => {
              const r = layout.rows[v.index];
              if (!r) return null;
              if (r.kind === "head") {
                return (
                  <div key={v.key} className="vrow day-head" style={{ transform: `translateY(${v.start}px)`, height: HEAD_H }}>
                    <b>{fmtDayHead(r.day, lang, t("date.today"), t("date.yesterday"))}</b>
                    <span>{r.count}</span>
                  </div>
                );
              }
              return (
                <div key={v.key} className="vrow" style={{ transform: `translateY(${v.start}px)`, height: itemH, gridTemplateColumns: `repeat(${cols}, ${cardW}px)`, gap }}>
                  {Array.from({ length: r.n }, (_, c) => {
                    const idx = r.start + c;
                    if (total != null && idx >= total) return null;
                    const it = items.get(idx);
                    if (!it) return <div key={c} className={"gallery-card skeleton " + view}><div className="gallery-image" style={view === "list" ? { width: listThumb, height: listThumb } : undefined} /></div>;
                    const open = () => openDetails(it.id);
                    const common = {
                      role: "button" as const, tabIndex: 0, onClick: open, draggable: true,
                      onDragStart: (e: React.DragEvent) => startImageDrag(e, it.id),
                      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") open(); },
                      onContextMenu: (e: React.MouseEvent) => showMenu(e, imageMenu(it)),
                    };
                    const fav = (
                      <button className={"favorite " + (it.favorite ? "on" : "")} title={t("favorite")} aria-pressed={it.favorite} onClick={(e) => { e.stopPropagation(); toggleFav(it, idx); }}>
                        <Heart size={14} fill={it.favorite ? "currentColor" : "none"} />
                      </button>
                    );
                    if (view === "list") {
                      return (
                        <div key={it.id} className="gallery-card list" {...common}>
                          <div className={"gallery-image " + (it.hidden ? "hidden" : "")} style={{ width: listThumb, height: listThumb }}>
                            <img src={api.thumbUrl(it.id)} alt="" loading="lazy" decoding="async" draggable={false} />
                            {it.hidden && <span className="hidden-badge"><EyeOff size={12} /></span>}
                          </div>
                          <div className="list-body">
                            <div className="list-prompt" title={it.prompt}>{it.prompt || "—"}</div>
                            <div className="list-meta">
                              <span>{it.model_name}</span>
                              <span>{it.width}×{it.height}</span>
                              <span>seed {it.seed}</span>
                              <span>{it.steps} {t("gallery.steps")}</span>
                              {it.loras.length > 0 && <span>LoRA ×{it.loras.length}</span>}
                              <span>{fmtDate(it.created_at, lang, true)}</span>
                            </div>
                          </div>
                          {fav}
                        </div>
                      );
                    }
                    return (
                      <div key={it.id} className="gallery-card" {...common}>
                        <div className={"gallery-image " + (it.hidden ? "hidden" : "")}>
                          <img src={api.thumbUrl(it.id)} alt={it.prompt} loading="lazy" decoding="async" draggable={false} />
                          {fav}
                          {it.hidden && <span className="hidden-badge"><EyeOff size={12} /></span>}
                        </div>
                        <div className="gallery-name" title={it.prompt}>{it.prompt || "—"}</div>
                        <div className="gallery-meta">{it.width}×{it.height} · {grouped ? new Date(it.created_at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }) : fmtDate(it.created_at, lang, true)}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Scrubber el={scrollEl} ticks={ticks} labelAt={labelAt} deps={layout.height} />
      </div>

      <div className="gallery-foot">
        <span className="muted foot-count">{total == null ? "" : t("lib.count", { n: total })}</span>
        <span className="foot-right">
          {canList && (
            <span className="seg tiny" role="group" aria-label={t("gallery.view")}>
              <button className={view === "grid" ? "active" : ""} onClick={() => setUi({ galleryView: "grid" })} title={t("gallery.grid")}><LayoutGrid size={13} /> <span className="word">{t("gallery.grid")}</span></button>
              <button className={view === "list" ? "active" : ""} onClick={() => setUi({ galleryView: "list" })} title={t("gallery.list")}><List size={13} /> <span className="word">{t("gallery.list")}</span></button>
            </span>
          )}
          <button className={"btn small " + (ui.groupByDay ? "active" : "")} aria-pressed={ui.groupByDay} title={t("gallery.group")} onClick={() => setUi({ groupByDay: !ui.groupByDay })}><CalendarDays size={14} /> <span className="word">{t("gallery.group")}</span></button>
          <label className="size-slider" title={`${t("gallery.size")} (Ctrl + ${t("gallery.wheel")})`}>
            <ImageIcon size={11} />
            <input type="range" min={sizeMin} max={sizeMax} value={clamp(thumbSize, sizeMin, sizeMax)}
              style={{ "--p": `${((clamp(thumbSize, sizeMin, sizeMax) - sizeMin) / (sizeMax - sizeMin)) * 100}%` } as React.CSSProperties}
              onChange={(e) => setThumbSize(Number(e.target.value))} aria-label={t("gallery.size")} />
            <ImageIcon size={17} />
          </label>
        </span>
      </div>
    </div>
  );
}
