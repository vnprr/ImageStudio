import { useMemo, useRef } from "react";
import { Brush, EyeOff, Palette, Pencil, Plus, Trash2, X } from "lucide-react";
import { useT } from "../i18n";
import { hasDoodle, hasMask } from "../paint";
import { selCaps, useStore, type AttachRole, type Attachment, type MenuItem } from "../store";
import { showMenu } from "./ContextMenu";
import { Section } from "./ui";

const ROLE_ICON: Record<AttachRole, typeof Pencil> = { edit: Pencil, ref: Palette, off: EyeOff };

/** Obrazy wejściowe jak w czacie: lista pod promptem; każdy ma rolę (do edycji / inspiracja / nieaktywny) i może być malowany. */
export function AttachmentsSection() {
  const t = useT();
  const attachments = useStore((s) => s.attachments);
  const caps = useStore(selCaps);
  const mode = useStore((s) => s.form.mode);
  const dragging = useStore((s) => s.dragging);
  const hot = useStore((s) => s.hotZone) === "attach-side";
  const addFiles = useStore((s) => s.addFiles);
  const input = useRef<HTMLInputElement>(null);

  const active = useMemo(() => attachments.filter((a) => a.role !== "off").length, [attachments]);
  const refs = attachments.filter((a) => a.role === "ref").length;
  const maxRefs = caps?.max_refs ?? 0;

  return (
    <Section
      title={t("attach.title")}
      helpKey="attach"
      right={attachments.length > 0 ? <small className="muted">{t("attach.count", { a: active, n: attachments.length })}{maxRefs > 0 ? ` · ${t("attach.refs", { r: refs, m: maxRefs })}` : ""}</small> : undefined}
    >
      <div className={"dropzone attach " + (dragging ? "armed " : "") + (hot ? "hot" : "")} data-dropzone="attach" data-dropid="attach-side" data-drop-label={t("drop.attach")}>
        <div className="att-list">
          {attachments.map((a) => <Tile key={a.id} a={a} />)}
          <button className="att-add" title={t("attach.add")} aria-label={t("attach.add")} onClick={() => input.current?.click()}>
            <Plus size={20} />
            <small>{attachments.length ? "" : t("attach.addShort")}</small>
          </button>
        </div>
        {attachments.length === 0 && <p className="note small att-hint">{t("attach.hint")}</p>}
        {mode === "t2i" && active > 0 && <p className="note small att-hint warn-text">{t("attach.unused")}</p>}
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles([...e.target.files], "attach"); e.target.value = ""; }} />
      </div>
    </Section>
  );
}

function menuFor(a: Attachment, t: ReturnType<typeof useT>): MenuItem[] {
  const s = useStore.getState();
  const caps = selCaps(s);
  const role = (r: AttachRole, label: string, hint: string, icon: React.ReactNode, disabled = false): MenuItem =>
    ({ label, hint, icon, checked: a.role === r, disabled, onClick: () => s.setRole(a.id, r) });
  return [
    role("edit", t("attach.role.edit"), t("attach.role.editHint"), <Pencil size={14} />, !caps?.modes.includes("edit")),
    role("ref", t("attach.role.ref"), t("attach.role.refHint"), <Palette size={14} />, !((caps?.max_refs ?? 0) > 0)),
    role("off", t("attach.role.off"), t("attach.role.offHint"), <EyeOff size={14} />),
    { sep: true },
    { label: t("attach.paint"), icon: <Brush size={14} />, onClick: () => s.paintOpen(a.id) },
    { sep: true },
    { label: t("remove"), icon: <Trash2 size={14} />, danger: true, onClick: () => s.removeAttachment(a.id) },
  ];
}

function Tile({ a }: { a: Attachment }) {
  const t = useT();
  const remove = useStore((s) => s.removeAttachment);
  const paintOpen = useStore((s) => s.paintOpen);
  const painting = useStore((s) => s.paintId) === a.id;
  const Ico = ROLE_ICON[a.role];
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(e, menuFor(a, t), { x: r.left, y: r.bottom + 4 });
  };
  return (
    <div
      className={`att role-${a.role} ${painting ? "painting" : ""}`}
      title={`${t(`attach.role.${a.role}`)} — ${a.name}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onContextMenu={(e) => showMenu(e, menuFor(a, t))}
      onDoubleClick={() => paintOpen(a.id)}
      onKeyDown={(e) => { if (e.key === "Enter") paintOpen(a.id); }}
    >
      <img src={a.url} alt="" draggable={false} />
      <span className="att-role"><Ico size={11} /></span>
      {(hasMask(a.paint) || hasDoodle(a.paint)) && <span className="att-paint" title={t("attach.painted")}><Brush size={10} /></span>}
      <button className="att-x" aria-label={t("remove")} onClick={(e) => { e.stopPropagation(); remove(a.id); }}><X size={11} /></button>
      <button className="att-brush" aria-label={t("attach.paint")} title={t("attach.paint")} onClick={(e) => { e.stopPropagation(); paintOpen(a.id); }}><Brush size={12} /></button>
    </div>
  );
}
