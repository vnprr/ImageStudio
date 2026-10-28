import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Info, LayoutGrid, Menu, RefreshCw, Settings as Cog, Sparkles, X } from "lucide-react";
import { tr, useT } from "./i18n";
import { IS_WEB, getConn, isRemote, setConn } from "./connection";
import { isDesktop } from "./lib";
import { pendingJobs, useStore } from "./store";
import { Composer } from "./components/Composer";
import { Connect } from "./components/Connect";
import { ContextMenu, editMenu } from "./components/ContextMenu";
import { Details } from "./components/Details";
import { History } from "./components/History";
import { Library } from "./components/Library";
import { SaveMenu } from "./components/SaveMenu";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Stage } from "./components/Stage";
import { Logo, Spinner } from "./components/ui";

const isTyping = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable='true']");

function Offline() {
  const t = useT();
  const bootData = useStore((s) => s.bootData);
  const [busy, setBusy] = useState(false);
  const remote = isRemote();
  return (
    <div className="offline">
      <div className="offline-card">
        <Logo size={56} />
        <h1>{t("offline.title")}</h1>
        {remote ? (
          <>
            <p>{t("offline.remoteText")}</p>
            <p className="muted small trunc">{getConn()?.base}</p>
            <button className="btn ghost" onClick={() => { setConn(null); location.reload(); }}>{t("remote.client.disconnect")}</button>
          </>
        ) : (
          <>
            <p>{t("offline.text")}</p>
            <pre>{`run.bat\n\npython -m uvicorn backend.app:app --port 8765`}</pre>
          </>
        )}
        <p className="muted small">{t("offline.auto")}</p>
        <button className="btn amber" disabled={busy} onClick={async () => { setBusy(true); await bootData(); setBusy(false); }}>
          {busy ? <Spinner /> : <RefreshCw size={14} />} {t("retry")}
        </button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={"toast " + x.kind} role={x.kind === "error" ? "alert" : "status"}>
          {x.kind === "error" ? <AlertCircle size={16} /> : x.kind === "success" ? <CheckCircle2 size={16} /> : <Info size={16} />}
          <span>{x.text}</span>
          <button aria-label="close" onClick={() => dismiss(x.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const t = useT();
  const online = useStore((s) => s.online);
  const page = useStore((s) => s.page);
  const composerOpen = useStore((s) => s.composerOpen);
  const authRequired = useStore((s) => s.authRequired);
  const width = useStore((s) => s.ui.sidebarWidth);
  const setUi = useStore((s) => s.setUi);
  const setPage = useStore((s) => s.setPage);
  const selectedId = useStore((s) => s.selectedId);
  const cache = useStore((s) => s.cache);
  const jobs = useStore((s) => s.jobs);
  const [sideOpen, setSideOpen] = useState(false);
  const selected = selectedId ? cache[selectedId] ?? null : null;
  const pending = pendingJobs(jobs).length;

  useEffect(() => { useStore.getState().boot(); }, []);

  // na wąskich ekranach schowaj panel po wystartowaniu generowania
  const prevPending = useRef(0);
  useEffect(() => { if (pending > prevPending.current) setSideOpen(false); prevPending.current = pending; }, [pending]);

  // ---------------------------------------------------------------- skróty
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const typing = isTyping(e.target);
      const key = e.key.toLowerCase();
      const paintMode = s.page === "studio" && !!s.paintId;

      if (ctrl && e.key === "Enter") {
        e.preventDefault();
        if (s.composerOpen) useStore.setState({ composerOpen: false });
        if (s.page !== "studio") s.setPage("studio");
        void s.submit();
        return;
      }
      if (ctrl && key === "s") { e.preventDefault(); window.dispatchEvent(new Event("quicksave")); return; }
      if (ctrl && e.key === ",") { e.preventDefault(); s.setPage("settings"); return; }
      if (e.key === "Escape") {
        if (typing) { (e.target as HTMLElement).blur(); return; }
        if (paintMode) { s.paintOpen(null); return; }
        const running = Object.values(s.jobs).find((j) => j.status === "running") ?? Object.values(s.jobs).find((j) => j.status === "queued");
        if (running) { void s.cancelJob(running.id); return; }
        if (s.page === "details") s.setPage("library");
        else if (s.page !== "studio") s.setPage("studio");
        return;
      }
      if (typing) return;
      if (ctrl && key === "z" && paintMode) { e.preventDefault(); if (e.shiftKey) s.paintRedo(); else s.paintUndo(); return; }
      if (ctrl && key === "y" && paintMode) { e.preventDefault(); s.paintRedo(); return; }
      if (paintMode && e.key === "Enter") { e.preventDefault(); s.paintOpen(null); return; }
      if (ctrl || e.altKey) return;
      switch (e.key) {
        case "b": case "B": if (paintMode) s.setUi({ paintTool: "brush" }); break;
        case "e": case "E": if (paintMode) s.setUi({ paintTool: "eraser" }); break;
        case "m": case "M": if (paintMode) s.setUi({ paintLayer: "mask" }); break;
        case "d": case "D": if (paintMode) s.setUi({ paintLayer: "doodle" }); break;
        case "[": if (paintMode) s.setUi({ brush: Math.max(3, s.ui.brush - 5) }); break;
        case "]": if (paintMode) s.setUi({ brush: Math.min(160, s.ui.brush + 5) }); break;
        case "g": case "G": s.setPage(s.page === "library" ? "studio" : "library"); break;
        case "c": case "C": if (s.page === "studio") useStore.setState({ compare: !s.compare }); break;
        case "f": case "F": if (s.selectedId && (s.page === "studio" || s.page === "details")) { const im = s.cache[s.selectedId]; if (im) void s.patchImage(im.id, { favorite: !im.favorite }); } break;
        case "0": window.dispatchEvent(new CustomEvent("stage", { detail: "fit" })); break;
        case "+": case "=": window.dispatchEvent(new CustomEvent("stage", { detail: "in" })); break;
        case "-": window.dispatchEvent(new CustomEvent("stage", { detail: "out" })); break;
        case "/": e.preventDefault(); s.setPage("studio"); document.querySelector<HTMLTextAreaElement>(".sidebar textarea")?.focus(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------------------------------------------------------------- przeciąganie plików
  // Podświetlają się tylko strefy [data-dropzone] (dodaj do promptu / import do biblioteki), nie cała aplikacja.
  // Upuszczenie plików poza strefą nic nie robi, ale też nie pozwala przeglądarce otworzyć pliku zamiast aplikacji.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const zoneEl = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.<HTMLElement>("[data-dropzone]") ?? null;
    const zoneOf = (t: EventTarget | null) => zoneEl(t)?.dataset.dropzone ?? null;
    const hotOf = (t: EventTarget | null) => { const el = zoneEl(t); return el ? el.dataset.dropid ?? el.dataset.dropzone ?? null : null; };
    const reset = () => { depth = 0; useStore.setState({ dragging: false, hotZone: null }); };
    const enter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); depth++; useStore.setState({ dragging: true }); } };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = zoneOf(e.target) ? "copy" : "none";
      const hot = hotOf(e.target);
      if (useStore.getState().hotZone !== hot) useStore.setState({ hotZone: hot });
    };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) reset(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const zone = zoneOf(e.target);
      reset();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      const s = useStore.getState();
      if (zone === "attach" || zone === "library") void s.addFiles(files, zone);
      else s.toast("info", tr("drop.outside"));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  // ---------------------------------------------------------------- tryb desktop: bez menu przeglądarki i zoomu strony
  useEffect(() => {
    if (!isDesktop()) return;
    const ctx = (e: MouseEvent) => {
      if ((e as MouseEvent & { __ctx?: boolean }).__ctx) return;           // własne menu już obsłużyło to zdarzenie
      e.preventDefault();
      const st = useStore.getState();
      const field = (e.target as HTMLElement).closest?.<HTMLInputElement | HTMLTextAreaElement>("input,textarea");
      if (field && !["range", "checkbox", "radio", "button", "color", "file", "submit"].includes((field as HTMLInputElement).type)) st.openMenu(e.clientX, e.clientY, editMenu(field));
      else st.closeMenu();
    };
    const wheel = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault(); };   // Ctrl + kółko nie skaluje całej strony
    const keys = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && ["p", "u", "o", "f", "g"].includes(e.key.toLowerCase()) && !e.shiftKey) e.preventDefault(); };
    window.addEventListener("contextmenu", ctx);
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keys);
    return () => { window.removeEventListener("contextmenu", ctx); window.removeEventListener("wheel", wheel); window.removeEventListener("keydown", keys); };
  }, []);

  // ---------------------------------------------------------------- zmiana szerokości panelu
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = useStore.getState().ui.sidebarWidth;
    const move = (ev: PointerEvent) => setUi({ sidebarWidth: Math.max(290, Math.min(560, w0 + ev.clientX - x0)) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.classList.remove("resizing"); };
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [setUi]);

  if ((IS_WEB && !getConn()) || authRequired) return <><Connect /><Toasts /></>;
  if (online === null) return <div className="splash"><Spinner size={22} /></div>;
  if (online === false) return <><Offline /><Toasts /></>;

  const title = page === "studio" ? t("nav.workspace") : page === "library" ? t("nav.library") : page === "details" ? t("details.title") : t("settings.title");
  const crumb = page === "studio" ? "STUDIO" : page === "settings" ? "SETTINGS" : "LIBRARY";
  const navBtn = (p: "studio" | "library", label: string, Ico: typeof Sparkles) => (
    <button className={"nav " + ((page === p || (p === "library" && page === "details")) ? "active" : "")} title={label} aria-label={label} onClick={() => setPage(p)}>
      <Ico size={19} />
    </button>
  );

  return (
    <div className={"app " + (sideOpen ? "side-open" : "")} style={{ ["--sidebar-width" as string]: `${width}px` }}>
      <nav className="rail">
        <Logo />
        {navBtn("studio", t("nav.workspace"), Sparkles)}
        {navBtn("library", t("nav.library"), LayoutGrid)}
        <div className="rail-spacer" />
        {pending > 0 && page !== "studio" && <button className="nav pulse" title={t("gen.inQueue", { n: pending })} onClick={() => setPage("studio")}><Spinner size={16} /></button>}
        <button className={"nav " + (page === "settings" ? "active" : "")} title={`${t("settings.title")} (Ctrl+,)`} aria-label={t("settings.title")} onClick={() => setPage("settings")}><Cog size={19} /></button>
      </nav>

      {page === "studio" && <Sidebar onResizeStart={startResize} />}
      {page === "studio" && sideOpen && <div className="scrim" onClick={() => setSideOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <div className="top-left">
            {page === "studio" && <button className="btn icononly mobile-menu" aria-label={t("menu")} onClick={() => setSideOpen(!sideOpen)}><Menu size={16} /></button>}
            <div>
              <div className="crumb">IMAGE STUDIO / {crumb}</div>
              <h1>{title}</h1>
            </div>
          </div>
          <div className="top-actions">
            {(page === "studio" || page === "details") && <SaveMenu image={selected} />}
          </div>
        </header>
        {page === "studio" && <><Stage /><History /></>}
        {page === "library" && <Library />}
        {page === "details" && <Details />}
        {page === "settings" && <Settings />}
      </main>

      {composerOpen && <Composer />}
      <ContextMenu />
      <Toasts />
    </div>
  );
}
