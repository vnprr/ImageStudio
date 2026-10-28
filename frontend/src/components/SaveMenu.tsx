import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download, FolderOpen } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import { extFor, fileSafe, mimeFor } from "../lib";
import { isRemote } from "../connection";
import { useStore } from "../store";
import type { ImageRecord, SaveFormat } from "../types";
import { FolderPicker } from "./FolderPicker";
import { Spinner } from "./ui";

type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }>;
};

/** Zapis przez natywne okno przeglądarki; bez File System Access zwykłe pobranie. */
export async function saveToBrowser(img: ImageRecord, fmt: SaveFormat, quality: number, meta: boolean): Promise<boolean> {
  const name = `${fileSafe(img.prompt, 40)}-${img.seed}.${extFor(fmt)}`;
  const url = api.downloadUrl(img.id, fmt, quality, meta);
  const w = window as PickerWindow;
  let handle: Awaited<ReturnType<NonNullable<PickerWindow["showSaveFilePicker"]>>> | null = null;
  if (w.showSaveFilePicker) {
    try {
      handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: fmt.toUpperCase(), accept: { [mimeFor(fmt)]: ["." + extFor(fmt)] } }] });
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({ detail: res.statusText }))).detail);
  const blob = await res.blob();
  if (handle) {
    const wr = await handle.createWritable();
    await wr.write(blob);
    await wr.close();
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  return true;
}

export function SaveMenu({ image }: { image: ImageRecord | null }) {
  const t = useT();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const toast = useStore((s) => s.toast);
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [dest, setDest] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  // zapamiętany folder docelowy w obrębie sesji
  useEffect(() => { if (!dest && settings?.library_dir) setDest(localStorage.getItem("is.exportDir") ?? settings.library_dir); }, [settings, dest]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); e.stopPropagation(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc, true); };
  }, [open]);

  useEffect(() => {
    const h = () => { if (image) void quick(); };
    window.addEventListener("quicksave", h);
    return () => window.removeEventListener("quicksave", h);
  });

  const quick = async () => {
    if (!image || busy) return;
    setBusy(true);
    try {
      if (await saveToBrowser(image, ui.saveFormat, ui.saveQuality, ui.saveMeta)) toast("success", t("save.done"));
    } catch (e) { toast("error", t("err.save", { m: (e as Error).message })); }
    setBusy(false);
  };

  const toFolder = async () => {
    if (!image || !dest) return;
    setBusy(true);
    try {
      const r = await api.exportImage(image.id, { format: ui.saveFormat, quality: ui.saveQuality, dest_dir: dest, metadata: ui.saveMeta });
      localStorage.setItem("is.exportDir", dest);
      toast("success", t("save.savedTo", { p: r.path }));
      setOpen(false);
    } catch (e) { toast("error", t("err.save", { m: (e as Error).message })); }
    setBusy(false);
  };

  const fmts: SaveFormat[] = ["png", "jpeg", "webp"];
  return (
    <div className="savemenu" ref={wrap}>
      <div className="split">
        <button className="btn blue" disabled={!image || busy} onClick={() => void quick()} title={`${t("save")} (Ctrl+S)`}>
          {busy ? <Spinner /> : <Download size={15} />} <span className="word">{t("save")}</span> <small className="fmt">{ui.saveFormat.toUpperCase()}</small>
        </button>
        <button className="btn blue chev" disabled={!image} aria-label={t("save.as")} aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown size={14} /></button>
      </div>
      {open && image && (
        <div className="popover" role="dialog" aria-label={t("save.as")}>
          <div className="pop-title">{t("save.as")}</div>
          <div className="seg">
            {fmts.map((f) => <button key={f} className={ui.saveFormat === f ? "active" : ""} onClick={() => setUi({ saveFormat: f })}>{f.toUpperCase()}</button>)}
          </div>
          {ui.saveFormat !== "png" && (
            <div className="range-field">
              <div className="range-top"><span className="label">{t("save.quality")}</span><output>{ui.saveQuality}</output></div>
              <input type="range" min={50} max={100} value={ui.saveQuality} onChange={(e) => setUi({ saveQuality: Number(e.target.value) })} />
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={ui.saveMeta} onChange={(e) => setUi({ saveMeta: e.target.checked })} />
            <span>{t("save.meta")}<small>{ui.saveFormat === "png" ? t("save.metaPng") : t("save.metaOther")}</small></span>
          </label>
          <button className="btn amber wide" disabled={busy} onClick={() => { void quick(); setOpen(false); }}><Download size={14} /> {t("save.browser")}</button>
          {!isRemote() && (
            <>
              <div className="pop-sep" />
              <div className="label">{t("save.toFolder")}</div>
              <div className="with-btn">
                <input type="text" value={dest} spellCheck={false} onChange={(e) => setDest(e.target.value)} aria-label={t("save.toFolder")} />
                <button className="icon-btn" title={t("folder.browse")} onClick={() => setPicking(!picking)}><FolderOpen size={14} /></button>
              </div>
              {picking && <FolderPicker start={dest} onPick={(p) => { setDest(p); setPicking(false); }} onClose={() => setPicking(false)} />}
              <button className="btn wide" disabled={busy || !dest} onClick={() => void toFolder()}><FolderOpen size={14} /> {t("save.toFolderBtn")}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
