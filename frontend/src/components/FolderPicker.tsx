import { useEffect, useState } from "react";
import { ArrowUp, Check, Folder, X } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import type { FsListing } from "../types";
import { Spinner } from "./ui";

/** Wbudowana przeglądarka folderów serwera (przeglądarka nie zna ścieżek bezwzględnych). */
export function FolderPicker({ start, onPick, onClose }: { start?: string; onPick: (path: string) => void; onClose: () => void }) {
  const t = useT();
  const [path, setPath] = useState(start ?? "");
  const [listing, setListing] = useState<FsListing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.fsList(path).then((l) => { if (alive) { setListing(l); setErr(null); } }).catch((e: Error) => {
      if (alive) {
        setErr(e.message);
        // zła ścieżka startowa: wróć do korzenia
        if (path) setPath("");
      }
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [path]);

  return (
    <div className="folder-picker">
      <div className="fp-head">
        <input
          type="text" value={listing?.path ?? path} spellCheck={false}
          onChange={(e) => setListing(listing ? { ...listing, path: e.target.value } : null)}
          onKeyDown={(e) => { if (e.key === "Enter") setPath((e.target as HTMLInputElement).value); }}
          aria-label={t("folder.path")}
        />
        <button className="icon-btn" title={t("folder.up")} disabled={!listing || listing.parent == null} onClick={() => listing?.parent != null && setPath(listing.parent)}><ArrowUp size={14} /></button>
        <button className="btn teal small" disabled={!listing?.path} onClick={() => listing?.path && onPick(listing.path)}><Check size={14} /> {t("folder.choose")}</button>
        <button className="icon-btn" aria-label={t("close")} onClick={onClose}><X size={14} /></button>
      </div>
      <div className="fp-list">
        {loading && <div className="fp-row muted"><Spinner /> {t("loading")}</div>}
        {err && <div className="fp-row err">{err}</div>}
        {listing?.entries.filter((e) => e.is_dir).map((e) => (
          <button key={e.path} className="fp-row" onClick={() => setPath(e.path)}>
            <Folder size={14} /> {e.name}
          </button>
        ))}
        {listing && !loading && listing.entries.filter((e) => e.is_dir).length === 0 && <div className="fp-row muted">{t("folder.empty")}</div>}
      </div>
    </div>
  );
}
