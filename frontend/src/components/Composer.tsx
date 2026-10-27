import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useT } from "../i18n";
import { uid } from "../lib";
import { useStore } from "../store";
import type { Pack, Snippet } from "../types";

const SNIP_CATS: [string, string][] = [
  ["camera", "#8ac1ff"], ["perspective", "#bba3fd"], ["lighting", "#f5c782"], ["location", "#82daca"], ["style", "#f4a4c6"],
  ["composition", "#99bfff"], ["character", "#ffac90"], ["mood", "#c3a5db"], ["animation", "#d7b1f7"], ["color", "#f5a2a2"], ["negative", "#a8b7c5"],
];
const PACK_CATS: [string, string][] = [
  ["character", "#b99df7"], ["photo", "#85bbff"], ["world", "#77d7c8"], ["dark", "#f0a3bc"], ["edit", "#ffac8f"], ["own", "#d4c9b5"],
];

type Editing =
  | { type: "packs"; id: string | null; name: string; cat: string; desc: string; extra: string; ids: string[] }
  | { type: "snips"; id: string | null; name: string; cat: string; text: string };

export function Composer() {
  const t = useT();
  const lib = useStore((s) => s.promptLib);
  const setLib = useStore((s) => s.setPromptLib);
  const prompt = useStore((s) => s.form.prompt);
  const applied = useStore((s) => s.ui.applied);
  const setForm = useStore((s) => s.setForm);
  const addFragments = useStore((s) => s.addFragments);
  const removeFragment = useStore((s) => s.removeFragment);
  const setUi = useStore((s) => s.setUi);
  const [tab, setTab] = useState<"packs" | "snips">("packs");
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const [edit, setEdit] = useState<Editing | null>(null);
  const [pickQ, setPickQ] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const close = () => useStore.setState({ composerOpen: false });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); if (edit) setEdit(null); else close(); } };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [edit]);

  const snippets = lib?.snippets ?? [];
  const packs = lib?.packs ?? [];
  const known = tab === "packs" ? PACK_CATS : SNIP_CATS;
  const catList = useMemo(() => {
    const items = tab === "packs" ? packs : snippets;
    const extra = [...new Set(items.map((x) => x.cat))].filter((c) => !known.some(([k]) => k === c)).map((c): [string, string] => [c, "#aaa"]);
    return [...known, ...extra];
  }, [tab, packs, snippets, known]);

  const label = (c: string) => {
    if (c === "all") return t("composer.all");
    const k = (tab === "packs" ? "pcat." : "cat.") + c;
    const v = t(k);
    return v === k ? c : v;
  };
  const count = (c: string) => {
    const items = tab === "packs" ? packs : snippets;
    return c === "all" ? items.length : items.filter((x) => x.cat === c).length;
  };

  const ql = q.trim().toLowerCase();
  const entries = useMemo(() => {
    if (tab === "packs") {
      return packs.filter((p) => (cat === "all" || p.cat === cat) && (!ql || (p.name + " " + p.desc + " " + p.ids.map((id) => snippets.find((s) => s.id === id)?.title ?? "").join(" ")).toLowerCase().includes(ql)));
    }
    return snippets.filter((s) => (cat === "all" || s.cat === cat) && (!ql || (s.title + " " + s.id + " " + s.text).toLowerCase().includes(ql)));
  }, [tab, packs, snippets, cat, ql]);

  const startNew = () => {
    setConfirmDel(false);
    setEdit(tab === "packs"
      ? { type: "packs", id: null, name: "", cat: "own", desc: "", extra: "", ids: [] }
      : { type: "snips", id: null, name: "", cat: cat !== "all" ? cat : "camera", text: "" });
  };

  const startEdit = (id: string) => {
    setConfirmDel(false);
    if (tab === "packs") {
      const p = packs.find((x) => x.id === id);
      if (p) setEdit({ type: "packs", id: p.id, name: p.name, cat: p.cat, desc: p.desc, extra: p.extra, ids: [...p.ids] });
    } else {
      const s = snippets.find((x) => x.id === id);
      if (s) setEdit({ type: "snips", id: s.id, name: s.title, cat: s.cat, text: s.text });
    }
  };

  /** Zestaw z aktualnie dodanych fragmentów + reszty tekstu z promptu. */
  const saveCurrentAsSet = () => {
    const ids = [...new Set(applied)].filter((id) => snippets.some((s) => s.id === id));
    let extra = prompt;
    for (const id of ids) {
      const piece = snippets.find((s) => s.id === id)?.text;
      if (piece) extra = extra.replace(piece, "");
    }
    extra = extra.replace(/^[\s,]+|[\s,]+$/g, "").replace(/(,\s*){2,}/g, ", ").trim();
    setTab("packs");
    setCat("all");
    setEdit({ type: "packs", id: null, name: "", cat: "own", desc: "", extra, ids });
  };

  const save = () => {
    if (!edit || !edit.name.trim()) return;
    if (edit.type === "packs") {
      if (!edit.ids.length && !edit.extra.trim()) return;
      const pack: Pack = { id: edit.id ?? "SET-U" + uid("").slice(1).toUpperCase(), cat: edit.cat, name: edit.name.trim(), desc: edit.desc.trim() || t("composer.ownSet"), extra: edit.extra, ids: edit.ids };
      setLib((d) => ({ ...d, packs: d.packs.some((p) => p.id === pack.id) ? d.packs.map((p) => (p.id === pack.id ? pack : p)) : [pack, ...d.packs] }));
      setTab("packs"); setOpen(pack.id);
    } else {
      if (!edit.text.trim()) return;
      const sn: Snippet = { id: edit.id ?? "USR-" + uid("").slice(1).toUpperCase(), cat: edit.cat, title: edit.name.trim(), text: edit.text.trim() };
      setLib((d) => ({ ...d, snippets: d.snippets.some((s) => s.id === sn.id) ? d.snippets.map((s) => (s.id === sn.id ? sn : s)) : [sn, ...d.snippets] }));
      setTab("snips"); setOpen(sn.id);
    }
    setCat("all"); setQ(""); setEdit(null);
  };

  const remove = () => {
    if (!edit?.id) return;
    const id = edit.id;
    if (edit.type === "packs") setLib((d) => ({ ...d, packs: d.packs.filter((p) => p.id !== id) }));
    else setLib((d) => ({ ...d, snippets: d.snippets.filter((s) => s.id !== id) }));
    setEdit(null); setConfirmDel(false);
  };

  const add = (id: string) => {
    if (tab === "packs") {
      const p = packs.find((x) => x.id === id);
      if (p) addFragments(p.ids, p.extra);
    } else addFragments([id]);
  };

  const pickList = snippets.filter((s) => !pickQ || (s.title + s.id + s.text).toLowerCase().includes(pickQ.toLowerCase()));

  return (
    <div className="composer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="composer" role="dialog" aria-modal="true" aria-label={t("composer.title")}>
        <div className="composer-head">
          <div>
            <div className="composer-kicker">✦ PROMPT WORKSPACE</div>
            <div className="composer-title">{t("composer.title")}</div>
          </div>
          <div className="composer-head-right">
            <span className="composer-autosave">● {t("composer.autosave")}</span>
            <button className="btn icononly" title={`${t("close")} (Esc)`} onClick={close}><X size={16} /></button>
          </div>
        </div>

        <div className="composer-main">
          <div className="composer-categories">
            <div className="composer-category-head">{t("composer.categories")}</div>
            {[["all", "#f2c37c"] as [string, string], ...catList].map(([c, color]) => (
              <button key={c} className={"composer-category " + (cat === c ? "active" : "")} onClick={() => { setCat(c); setEdit(null); }}>
                <span className="catdot" style={{ background: color }} />
                <span className="catname">{label(c)}</span>
                <span className="number">{count(c)}</span>
              </button>
            ))}
          </div>

          <div className="composer-listarea">
            <div className="composer-listtop">
              <div className="browser-tabs">
                <button className={tab === "packs" ? "active" : ""} onClick={() => { setTab("packs"); setCat("all"); setEdit(null); setOpen(""); }}>{t("composer.packs")} · {packs.length}</button>
                <button className={tab === "snips" ? "active" : ""} onClick={() => { setTab("snips"); setCat("all"); setEdit(null); setOpen(""); }}>{t("composer.snippets")} · {snippets.length}</button>
              </div>
              {!edit && (
                <div className="list-tools">
                  <div className="search-wrap">
                    <Search size={13} />
                    <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("composer.search")} aria-label={t("composer.search")} />
                  </div>
                  <button className="btn amber small" onClick={startNew}><Plus size={13} /> {t("composer.new")}</button>
                </div>
              )}
            </div>

            {edit ? (
              <div className="inline-editor">
                <h3>{edit.id ? t("composer.edit") : t("composer.new")} {edit.type === "packs" ? t("composer.set") : t("composer.fragment")}</h3>
                <label>{t("composer.name")}</label>
                <input type="text" value={edit.name} maxLength={85} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus />
                <label>{t("composer.category")}</label>
                <select value={edit.cat} onChange={(e) => setEdit({ ...edit, cat: e.target.value })}>
                  {(edit.type === "packs" ? PACK_CATS : SNIP_CATS).map(([c]) => <option key={c} value={c}>{t((edit.type === "packs" ? "pcat." : "cat.") + c)}</option>)}
                </select>
                {edit.type === "packs" ? (
                  <>
                    <label>{t("composer.desc")}</label>
                    <textarea className="short" value={edit.desc} onChange={(e) => setEdit({ ...edit, desc: e.target.value })} />
                    <label>{t("composer.extra")}</label>
                    <textarea className="short" value={edit.extra} onChange={(e) => setEdit({ ...edit, extra: e.target.value })} />
                    <label>{t("composer.pick", { n: edit.ids.length })}</label>
                    <input type="search" value={pickQ} onChange={(e) => setPickQ(e.target.value)} placeholder={t("composer.search")} />
                    <div className="pick-items">
                      {pickList.map((s) => (
                        <label key={s.id} className="pick-item">
                          <input type="checkbox" checked={edit.ids.includes(s.id)} onChange={(e) => setEdit({ ...edit, ids: e.target.checked ? [...edit.ids, s.id] : edit.ids.filter((x) => x !== s.id) })} />
                          <span>{s.title}</span><small>{s.id}</small>
                        </label>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <label>{t("composer.text")}</label>
                    <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} style={{ minHeight: 180 }} />
                  </>
                )}
                <div className="edit-actions">
                  <button className="btn amber" onClick={save}><Check size={14} /> {t("save")}</button>
                  <button className="btn" onClick={() => setEdit(null)}>{t("cancel")}</button>
                  {edit.id && (confirmDel
                    ? <button className="btn danger solid" onClick={remove}><Trash2 size={14} /> {t("confirm.delete")}</button>
                    : <button className="btn danger" onClick={() => setConfirmDel(true)}><Trash2 size={14} /> {t("delete")}</button>)}
                </div>
              </div>
            ) : (
              <div className="composer-results">
                {!lib && <div className="muted pad">{t("loading")}</div>}
                {lib && entries.length === 0 && <div className="muted pad">{t("composer.noResults")}</div>}
                {tab === "packs"
                  ? (entries as Pack[]).map((p) => (
                      <div key={p.id} className={"entry " + (open === p.id ? "active" : "")}>
                        <div className="entry-top">
                          <div className="entry-detail-trigger" onClick={() => setOpen(open === p.id ? "" : p.id)}>
                            <div className="entry-id">{p.id} · {t("composer.nFragments", { n: p.ids.length })}</div>
                            <div className="entry-name">{p.name}</div>
                            <div className="entry-description">{p.desc}</div>
                          </div>
                          <div className="entry-btns">
                            <button className="sqbtn" title={t("composer.edit")} onClick={() => startEdit(p.id)}><Pencil size={13} /></button>
                            <button className="sqbtn add" title={t("composer.add")} onClick={() => add(p.id)}><Plus size={15} /></button>
                          </div>
                        </div>
                        {open === p.id && (
                          <div className="entry-expanded">
                            <div className="entry-tags">{p.ids.map((id) => { const s = snippets.find((x) => x.id === id); return s ? <span key={id}>{s.title}</span> : null; })}</div>
                            {p.extra && <div className="entry-extra">{p.extra}</div>}
                            <div className="entry-insert"><button className="btn amber small" onClick={() => add(p.id)}><Plus size={13} /> {t("composer.addSet")}</button></div>
                          </div>
                        )}
                      </div>
                    ))
                  : (entries as Snippet[]).map((s) => (
                      <div key={s.id} className={"entry " + (open === s.id ? "active" : "")}>
                        <div className="entry-top">
                          <div className="entry-detail-trigger" onClick={() => setOpen(open === s.id ? "" : s.id)}>
                            <div className="entry-id">{s.id}{applied.includes(s.id) ? ` · ✓ ${t("composer.inPrompt")}` : ""}</div>
                            <div className="entry-name">{s.title}</div>
                            <div className="entry-description">{s.text}</div>
                          </div>
                          <div className="entry-btns">
                            <button className="sqbtn" title={t("composer.edit")} onClick={() => startEdit(s.id)}><Pencil size={13} /></button>
                            <button className="sqbtn add" title={t("composer.add")} onClick={() => add(s.id)}><Plus size={15} /></button>
                          </div>
                        </div>
                        {open === s.id && <div className="entry-expanded">{s.text}<div className="entry-insert"><button className="btn amber small" onClick={() => add(s.id)}><Plus size={13} /> {t("composer.addFragment")}</button></div></div>}
                      </div>
                    ))}
              </div>
            )}
          </div>

          <div className="composer-editor">
            <div className="editor-top">
              <h3>{t("prompt.title")}</h3>
              <p>{t("composer.editorHint")}</p>
            </div>
            <div className="editor-body">
              <textarea className="composer-prompt" value={prompt} onChange={(e) => setForm({ prompt: e.target.value }, true)} placeholder={t("prompt.placeholder")} aria-label={t("prompt.title")} />
              <div className="applied-head">{t("composer.applied")} · {[...new Set(applied)].length}</div>
              <div className="applied">
                {applied.length === 0 && <span className="muted">{t("composer.appliedEmpty")}</span>}
                {[...new Set(applied)].map((id) => {
                  const s = snippets.find((x) => x.id === id);
                  return s ? <span key={id} className="applied-chip">{s.title}<button title={t("remove")} onClick={() => removeFragment(id)}><X size={11} /></button></span> : null;
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="composer-bottom">
          <span className="meta">{t("prompt.count", { n: prompt.length })}</span>
          <div className="buttons">
            <button className="btn" disabled={!prompt.trim()} onClick={() => { setForm({ prompt: "" }, true); setUi({ applied: [] }); }}>{t("composer.clear")}</button>
            <button className="btn" disabled={!prompt.trim() && !applied.length} onClick={saveCurrentAsSet}>{t("composer.saveSet")}</button>
            <button className="btn amber" onClick={close}><Check size={14} /> {t("composer.done")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
