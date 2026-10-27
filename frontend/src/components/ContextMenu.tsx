import { useEffect, useLayoutEffect, useRef } from "react";
import { Check, ClipboardPaste, Copy, EyeOff, Heart, ImagePlus, Info, MousePointerSquareDashed, Pencil, RotateCcw, Scissors, SlidersHorizontal } from "lucide-react";
import { tr } from "../i18n";
import { selCaps, useStore, type MenuItem } from "../store";
import type { ImageRecord } from "../types";

/** Własne menu kontekstowe (w aplikacji desktopowej zastępuje menu przeglądarki). */
export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const close = useStore((s) => s.closeMenu);
  const el = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menu || !el.current) return;
    const { offsetWidth: w, offsetHeight: h } = el.current;
    el.current.style.left = Math.max(6, Math.min(menu.x, window.innerWidth - w - 6)) + "px";
    el.current.style.top = Math.max(6, Math.min(menu.y, window.innerHeight - h - 6)) + "px";
    el.current.style.visibility = "visible";
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!el.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div ref={el} className="ctxmenu" role="menu" style={{ left: menu.x, top: menu.y, visibility: "hidden" }} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        "sep" in it ? <div key={i} className="ctx-sep" /> : (
          <button key={i} role="menuitem" className={"ctx-item " + (it.danger ? "danger" : "")} disabled={it.disabled}
            onClick={() => { close(); it.onClick(); }}>
            <span className="ctx-ico">{it.checked ? <Check size={14} /> : it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.hint && <small>{it.hint}</small>}
          </button>
        ))}
    </div>
  );
}

/** Otwiera menu pod kursorem (albo w podanym punkcie) i oznacza zdarzenie jako obsłużone. */
export function showMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[], at?: { x: number; y: number }) {
  e.preventDefault();
  (("nativeEvent" in e ? e.nativeEvent : e) as MouseEvent & { __ctx?: boolean }).__ctx = true;
  useStore.getState().openMenu(at?.x ?? e.clientX, at?.y ?? e.clientY, items);
}

// ------------------------------------------------------------------ gotowe zestawy pozycji

const copyText = async (text: string) => {
  try { await navigator.clipboard.writeText(text); useStore.getState().toast("success", tr("copied")); }
  catch { useStore.getState().toast("error", tr("menu.clipboardDenied")); }
};

/** Menu obrazu z historii / biblioteki / sceny. */
export function imageMenu(img: ImageRecord): MenuItem[] {
  const s = useStore.getState();
  const caps = selCaps(s);
  return [
    { label: tr("favorite"), icon: <Heart size={14} />, checked: img.favorite, onClick: () => void s.patchImage(img.id, { favorite: !img.favorite }) },
    { sep: true },
    { label: tr("edit"), icon: <Pencil size={14} />, disabled: !caps?.modes.includes("edit"), onClick: () => s.useAsSource(img) },
    { label: tr("details.addRef"), icon: <ImagePlus size={14} />, disabled: !((caps?.max_refs ?? 0) > 0), onClick: () => s.addAsRef(img) },
    { label: tr("details.useSettings"), icon: <SlidersHorizontal size={14} />, onClick: () => s.applyRequest(img.request) },
    { label: tr("details"), icon: <Info size={14} />, onClick: () => s.openDetails(img.id) },
    { sep: true },
    { label: tr("menu.copyPrompt"), icon: <Copy size={14} />, disabled: !img.prompt, onClick: () => void copyText(img.prompt) },
    { label: tr("menu.copySeed"), icon: <Copy size={14} />, onClick: () => void copyText(String(img.seed)) },
    { sep: true },
    { label: img.hidden ? tr("unhide") : tr("hide"), icon: <EyeOff size={14} />, onClick: () => void s.patchImage(img.id, { hidden: !img.hidden }) },
  ];
}

/** Standardowe menu pola tekstowego (wytnij / kopiuj / wklej / zaznacz wszystko). */
export function editMenu(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const has = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
  const ro = el.readOnly || el.disabled;
  return [
    { label: tr("menu.cut"), icon: <Scissors size={14} />, disabled: !has || ro, onClick: () => { el.focus(); document.execCommand("cut"); } },
    { label: tr("copy"), icon: <Copy size={14} />, disabled: !has, onClick: () => { el.focus(); document.execCommand("copy"); } },
    {
      label: tr("menu.paste"), icon: <ClipboardPaste size={14} />, disabled: ro,
      onClick: async () => {
        el.focus();
        try { document.execCommand("insertText", false, await navigator.clipboard.readText()); }
        catch { useStore.getState().toast("info", tr("menu.pasteHint")); }
      },
    },
    { sep: true },
    { label: tr("menu.selectAll"), icon: <MousePointerSquareDashed size={14} />, onClick: () => { el.focus(); el.select(); } },
    { label: tr("menu.undo"), icon: <RotateCcw size={14} />, disabled: ro, onClick: () => { el.focus(); document.execCommand("undo"); } },
  ];
}
