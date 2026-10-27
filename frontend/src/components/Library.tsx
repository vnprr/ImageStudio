import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EyeOff, Heart, Image as ImageIcon, ImageOff, LayoutGrid, List, Plus, Search } from "lucide-react";
import { api } from "../api";
import { useT, getLang } from "../i18n";
import { clamp, fmtDate } from "../lib";
import { useStore } from "../store";
import type { ImageFilter, ImageRecord, ImageSort } from "../types";
import { imageMenu, showMenu } from "./ContextMenu";
import { Empty, Spinner } from "./ui";

const PAGE = 120;
const GAP = 16;
const LIST_GAP = 8;

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
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(900);
  const scroller = useRef<HTMLDivElement>(null);
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

  const inner = Math.max(200, width - 56);
  const canList = width >= 520;                                   // widok listy ma sens tylko przy dość szerokim oknie
  const view: "grid" | "list" = canList ? ui.galleryView : "grid";
  const thumbSize = view === "list" ? ui.listThumb : ui.galleryThumb;
  const setThumbSize = (v: number) => setUi(view === "list" ? { listThumb: v } : { galleryThumb: v });
  const listThumb = clamp(ui.listThumb, 40, 360);
  const gap = view === "list" ? LIST_GAP : GAP;
  const cols = view === "list" ? 1 : Math.max(1, Math.floor((inner + GAP) / (ui.galleryThumb + GAP)));
  const cardW = (inner - gap * (cols - 1)) / cols;
  const rowH = view === "list" ? listThumb + 14 : cardW * 1.25 + 50;
  const rows = Math.ceil((total ?? 0) / cols);

  const virt = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowH + gap,
    overscan: 3,
  });
  const vItems = virt.getVirtualItems();
  useEffect(() => { virt.measure(); }, [rowH, gap, virt]);

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
    for (const v of vItems) for (let c = 0; c < cols; c++) {
      const idx = v.index * cols + c;
      if (idx < total && !items.has(idx)) need.add(Math.floor(idx / PAGE));
    }
    need.forEach((p) => void fetchPage(p, gen.current));
  }, [vItems, items, cols, total, fetchPage]);

  const filterBtn = useMemo<[ImageFilter, string][]>(() => [["all", t("lib.all")], ["favorite", t("lib.favorites")], ["hidden", t("lib.hidden")]], [t]);
  const lang = getLang();

  const toggleFav = (it: ImageRecord, idx: number) =>
    void patchImage(it.id, { favorite: !it.favorite }).then(() => setItems((m) => new Map(m).set(idx, { ...it, favorite: !it.favorite })));

  const sizeMin = view === "list" ? 40 : 110;
  const sizeMax = view === "list" ? 360 : 420;

  return (
    <div className={"gallery-page dropzone " + (dragging ? "armed " : "") + (hot ? "hot" : "")} data-dropzone="library" data-drop-label={t("drop.library")}>
      <div className="gallery" ref={scroller}>
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
          <button className="btn blue" onClick={() => fileInput.current?.click()}><Plus size={14} /> {t("lib.import")}</button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files], "library"); e.target.value = ""; }} />
        </div>

        {error && <div className="error-inline" role="alert">{error} <button className="link" onClick={() => void fetchPage(0, gen.current)}>{t("retry")}</button></div>}

        {total === 0 ? (
          <Empty icon={<ImageOff size={30} />} title={query || filter !== "all" || modelId ? t("lib.noResults") : t("lib.empty")} hint={query || filter !== "all" ? undefined : t("lib.emptyHint")} />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: "relative", width: "100%" }}>
            {vItems.map((v) => (
              <div key={v.key} className="vrow" style={{ transform: `translateY(${v.start}px)`, height: rowH, gridTemplateColumns: `repeat(${cols}, ${cardW}px)`, gap }}>
                {Array.from({ length: cols }, (_, c) => {
                  const idx = v.index * cols + c;
                  if (total != null && idx >= total) return null;
                  const it = items.get(idx);
                  if (!it) return <div key={c} className={"gallery-card skeleton " + view}><div className="gallery-image" style={view === "list" ? { width: listThumb, height: listThumb } : undefined} /></div>;
                  const open = () => openDetails(it.id);
                  const common = { role: "button" as const, tabIndex: 0, onClick: open, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter") open(); }, onContextMenu: (e: React.MouseEvent) => showMenu(e, imageMenu(it)) };
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
                      <div className="gallery-meta">{it.width}×{it.height} · {fmtDate(it.created_at, lang)}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
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
