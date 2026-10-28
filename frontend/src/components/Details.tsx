import { isRemote } from "../connection";
import { useEffect, useState } from "react";
import { ArrowLeft, Copy, EyeOff, Eye, Heart, History, ImagePlus, Pencil, Shuffle, Trash2 } from "lucide-react";
import { api } from "../api";
import { getLang, useT } from "../i18n";
import { fmtBytes, fmtDate, fmtSec } from "../lib";
import { selCaps, useStore } from "../store";
import type { ImageRecord, Timings } from "../types";
import { Empty, Spinner } from "./ui";

function Perf({ tm }: { tm: Timings }) {
  const t = useT();
  const parts: [string, number][] = [
    [t("perf.load"), tm.load], [t("perf.encode"), tm.encode], [t("perf.denoise"), tm.denoise], ["VAE", tm.vae], [t("perf.save"), tm.save],
  ];
  const sum = parts.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div className="perf">
      <div className="perf-head">
        <span className={"tag " + (tm.cold ? "cold" : "warm")}>{tm.cold ? t("perf.cold") : t("perf.warm")}</span>
        <b>{fmtSec(tm.total)}</b>
      </div>
      <div className="perf-bar">
        {parts.map(([k, v], i) => v > 0 && <span key={k} className={"seg" + i} style={{ width: `${(v / sum) * 100}%` }} title={`${k}: ${fmtSec(v)}`} />)}
      </div>
      <div className="perf-grid">
        {parts.map(([k, v], i) => (
          <div key={k}><span><i className={"sw seg" + i} />{k}</span><strong>{fmtSec(v)}</strong></div>
        ))}
        <div><span>{t("perf.peakVram")}</span><strong>{fmtBytes(tm.peak_vram)}</strong></div>
        <div><span>{t("perf.peakRam")}</span><strong>{fmtBytes(tm.peak_ram)}</strong></div>
      </div>
    </div>
  );
}

export function Details() {
  const t = useT();
  const id = useStore((s) => s.selectedId);
  const cache = useStore((s) => s.cache);
  const getImage = useStore((s) => s.getImage);
  const patch = useStore((s) => s.patchImage);
  const del = useStore((s) => s.deleteImage);
  const apply = useStore((s) => s.applyRequest);
  const useAsSource = useStore((s) => s.useAsSource);
  const addAsRef = useStore((s) => s.addAsRef);
  const submit = useStore((s) => s.submit);
  const setPage = useStore((s) => s.setPage);
  const caps = useStore(selCaps);
  const toast = useStore((s) => s.toast);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const img: ImageRecord | null = id ? cache[id] ?? null : null;

  useEffect(() => {
    setConfirm(false);
    if (id && !cache[id]) { setLoading(true); void getImage(id).finally(() => setLoading(false)); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!img) {
    return (
      <div className="details">
        <button className="btn" onClick={() => setPage("library")}><ArrowLeft size={14} /> {t("lib.title")}</button>
        {loading ? <div className="center-pad"><Spinner size={22} /></div> : <Empty title={t("details.notFound")} />}
      </div>
    );
  }

  const lang = getLang();
  const stat = (k: string, v: string | number | null | undefined) => (
    <div><span>{k}</span><strong>{v === null || v === undefined || v === "" ? "—" : String(v)}</strong></div>
  );

  const variant = async () => {
    apply(img.request, { newSeed: true });
    await submit({ variant: true });
    setPage("studio");
  };

  return (
    <div className="details">
      <div className="details-nav">
        <button className="btn" onClick={() => setPage("library")}><ArrowLeft size={14} /> {t("lib.title")}</button>
      </div>
      <div className="detailcols">
        <div className="detail-img">
          <img src={api.stageUrl(img.id)} alt={img.prompt} width={img.width} height={img.height} />
        </div>
        <div className="detail-info">
          <div className="date">
            {img.imported ? t("details.imported") : img.mode === "t2i" ? t("mode.t2i") : t(`mode.${img.mode}`)} · {fmtDate(img.created_at, lang, true)}
          </div>
          <div className="detailactions">
            <button className="btn amber" onClick={() => apply(img.request)} title={t("details.useSettingsHint")}><History size={14} /> {t("details.useSettings")}</button>
            <button className="btn" onClick={() => useAsSource(img)}><Pencil size={14} /> {t("edit")}</button>
            <button className="btn" onClick={() => void variant()}><Shuffle size={14} /> {t("details.variant")}</button>
            {caps && caps.max_refs > 0 && <button className="btn" onClick={() => addAsRef(img)}><ImagePlus size={14} /> {t("details.addRef")}</button>}
          </div>

          <div className="detailsection">
            PROMPT
            <button className="icon-btn" title={t("copy")} onClick={() => { void navigator.clipboard?.writeText(img.prompt); toast("info", t("copied")); }}><Copy size={13} /></button>
          </div>
          <div className="detailprompt">{img.prompt || "—"}</div>
          {img.negative_prompt && (<><div className="detailsection">{t("p.negative.name").toUpperCase()}</div><div className="detailprompt">{img.negative_prompt}</div></>)}

          <div className="detailsection">{t("details.params")}</div>
          <div className="detailgrid">
            {stat("Model", img.model_name)}
            {stat(t("p.resolution.name"), `${img.width} × ${img.height}`)}
            {stat("Steps", img.steps)}
            {img.cfg != null && stat("CFG", img.cfg)}
            {stat("Seed", img.seed)}
            {img.sampler && stat("Sampler", img.sampler)}
            {img.scheduler && stat("Scheduler", img.scheduler)}
            {img.denoise != null && stat("Denoise", img.denoise)}
            {stat(t("details.time"), img.gen_seconds != null ? fmtSec(img.gen_seconds) : null)}
          </div>
          {img.loras.length > 0 && (
            <>
              <div className="detailsection">LoRA</div>
              <div className="lora-tags">{img.loras.map((l) => <span key={l.id} className="cap">{l.name ?? l.id} · {l.strength.toFixed(2)}</span>)}</div>
            </>
          )}
          {img.sources.length > 0 && (
            <>
              <div className="detailsection">{t("details.inputs")}</div>
              <div className="references">
                {img.sources.map((s, i) => (
                  <div key={i} className="ref-item big" title={`${s.role}${s.name ? ": " + s.name : ""}`}>
                    {s.image_id ? <img src={api.thumbUrl(s.image_id)} alt={s.role} /> : <div className="ph">{s.role}</div>}
                    <small>{s.role}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {img.timings && (<><div className="detailsection">{t("perf.title")}</div><Perf tm={img.timings} /></>)}

          <div className="detailactions end">
            <button className={"btn " + (img.favorite ? "fav" : "")} onClick={() => void patch(img.id, { favorite: !img.favorite })}>
              <Heart size={14} fill={img.favorite ? "currentColor" : "none"} /> {t("favorite")}
            </button>
            <button className="btn" onClick={() => void patch(img.id, { hidden: !img.hidden })} title={t("hide.hint")}>
              {img.hidden ? <Eye size={14} /> : <EyeOff size={14} />} {img.hidden ? t("unhide") : t("hide")}
            </button>
            {isRemote() ? null : confirm ? (
              <>
                <button className="btn danger solid" onClick={() => { void del(img.id).then(() => setPage("library")); }}><Trash2 size={14} /> {t("confirm.deleteFile")}</button>
                <button className="btn ghost" onClick={() => setConfirm(false)}>{t("cancel")}</button>
              </>
            ) : (
              <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 size={14} /> {t("delete")}</button>
            )}
          </div>
          {confirm && !isRemote() && <p className="note small">{t("delete.warn")}</p>}
        </div>
      </div>
    </div>
  );
}
