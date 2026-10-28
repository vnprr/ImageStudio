import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Download, FolderOpen, Plus, RefreshCw, Save, X } from "lucide-react";
import { api } from "../api";
import { LANGS, getLang, setLang, useT, type Lang } from "../i18n";
import { fmtBytes, fmtEta, joinPath } from "../lib";
import { isRemote } from "../connection";
import { useStore } from "../store";
import type { CatalogEntry, RepoInspect, SaveFormat, Settings as SettingsT } from "../types";
import { FolderPicker } from "./FolderPicker";
import { RemoteAccess } from "./RemoteAccess";
import { Help, Spinner } from "./ui";

// ------------------------------------------------------------------ lista ścieżek

function PathList({ title, values, onChange, hint }: { title: string; values: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const t = useT();
  const [val, setVal] = useState("");
  const [pick, setPick] = useState(false);
  const add = (p: string) => {
    const v = p.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setVal("");
    setPick(false);
  };
  return (
    <div className="pathlist">
      <div className="label">{title}</div>
      {hint && <p className="note small">{hint}</p>}
      {values.length === 0 && <div className="muted small">{t("settings.noFolders")}</div>}
      {values.map((p) => (
        <div key={p} className="path-row">
          <code>{p}</code>
          <button className="icon-btn" aria-label={t("remove")} onClick={() => onChange(values.filter((x) => x !== p))}><X size={13} /></button>
        </div>
      ))}
      <div className="with-btn">
        <input type="text" value={val} placeholder={t("settings.pathPlaceholder")} spellCheck={false} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add(val)} />
        <button className="icon-btn" title={t("folder.browse")} onClick={() => setPick(!pick)}><FolderOpen size={14} /></button>
        <button className="btn small" disabled={!val.trim()} onClick={() => add(val)}><Plus size={13} /> {t("add")}</button>
      </div>
      {pick && <FolderPicker start={val || values[values.length - 1]} onPick={add} onClose={() => setPick(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ instalacja modeli z HF

function Installer() {
  const t = useT();
  const downloads = useStore((s) => s.downloads);
  const toast = useStore((s) => s.toast);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [repo, setRepo] = useState("");
  const [insp, setInsp] = useState<{ repo: string; data?: RepoInspect; loading?: boolean; error?: string } | null>(null);
  const hasFresh = Object.values(downloads).some((d) => d.status === "done");

  useEffect(() => { api.catalog().then(setCatalog).catch(() => setCatalog([])); }, [hasFresh]);

  const inspect = async (r: string) => {
    const name = r.trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/+$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) { toast("error", t("install.badRepo")); return; }
    setInsp({ repo: name, loading: true });
    try { setInsp({ repo: name, data: await api.inspect(name) }); }
    catch (e) { setInsp({ repo: name, error: (e as Error).message }); }
  };

  const start = async () => {
    if (!insp?.data) return;
    try {
      await api.startDownload(insp.repo);
      setInsp(null);
      toast("info", t("install.started"));
    } catch (e) { toast("error", (e as Error).message); }
  };

  const list = Object.values(downloads).sort((a, b) => (a.status === "running" ? -1 : 0) - (b.status === "running" ? -1 : 0)).slice(0, 8);
  const d = insp?.data;

  return (
    <div className="card">
      <h3>{t("install.title")}</h3>
      <p className="note small">{t("install.hint")}</p>

      <div className="catalog">
        {catalog === null && <Spinner />}
        {catalog?.map((c) => (
          <div key={c.repo_id} className="cat-card">
            <div>
              <b>{c.name}</b>
              <p>{c.description}</p>
              <small>{c.repo_id}{c.size_bytes > 0 ? ` · ${fmtBytes(c.size_bytes)}` : ""} · {c.license ?? "?"}</small>
            </div>
            {c.installed
              ? <span className="tag warm"><Check size={12} /> {t("install.installed")}</span>
              : <button className="btn amber small" disabled={insp?.loading} onClick={() => void inspect(c.repo_id)}><Download size={13} /> {t("install.install")}</button>}
          </div>
        ))}
      </div>

      <div className="label spaced">{t("install.custom")}</div>
      <div className="with-btn">
        <input type="text" value={repo} placeholder="owner/model-name" spellCheck={false} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void inspect(repo)} />
        <button className="btn small" disabled={!repo.trim() || insp?.loading} onClick={() => void inspect(repo)}>{t("install.check")}</button>
      </div>

      {insp && (
        <div className="inspect">
          {insp.loading && <div><Spinner /> {t("loading")}</div>}
          {insp.error && <div className="warn"><AlertTriangle size={14} /> {insp.error}</div>}
          {d && (
            <>
              <div className="inspect-head"><b>{d.name}</b><button className="icon-btn" aria-label={t("close")} onClick={() => setInsp(null)}><X size={13} /></button></div>
              <div className="inspect-grid">
                <div><span>{t("install.size")}</span><strong>{fmtBytes(d.size_bytes)}</strong></div>
                <div><span>{t("install.free")}</span><strong className={d.enough_space ? "" : "bad"}>{fmtBytes(d.free_bytes)}</strong></div>
                <div><span>{t("install.license")}</span><strong>{d.license ?? t("install.noLicense")}</strong></div>
                <div><span>{t("install.files")}</span><strong>{d.files}</strong></div>
              </div>
              {!d.enough_space && <div className="warn"><AlertTriangle size={14} /> {t("install.noSpace")}</div>}
              {d.requires_token && <div className="warn"><AlertTriangle size={14} /> {t("install.needToken")}</div>}
              {!d.supported && <div className="warn"><AlertTriangle size={14} /> {d.note ?? t("install.unsupported")}</div>}
              {d.supported && d.note && <p className="note small">{d.note}</p>}
              <p className="note small">{t("install.licenseAck")}</p>
              <button className="btn amber" disabled={!d.enough_space} onClick={() => void start()}><Download size={14} /> {t("install.download")}</button>
            </>
          )}
        </div>
      )}

      {list.length > 0 && (
        <div className="downloads">
          <div className="label spaced">{t("install.downloads")}</div>
          {list.map((x) => {
            const pct = x.bytes_total > 0 ? (x.bytes_done / x.bytes_total) * 100 : 0;
            const live = x.status === "running" || x.status === "queued";
            return (
              <div key={x.id} className={"dl " + x.status}>
                <div className="dl-top">
                  <b>{x.repo_id}</b>
                  <span className={"tag " + (x.status === "done" ? "warm" : x.status === "error" ? "err" : "")}>{t(`dl.${x.status}`)}</span>
                  {live && <button className="icon-btn" aria-label={t("cancel")} onClick={() => void api.cancelDownload(x.id)}><X size={13} /></button>}
                </div>
                <div className="loadingtrack wide"><div style={{ width: `${x.status === "done" ? 100 : pct}%` }} /></div>
                <small>
                  {fmtBytes(x.bytes_done)} / {fmtBytes(x.bytes_total)}
                  {live && ` · ${fmtBytes(x.speed)}/s · ETA ${fmtEta(x.eta)}`}
                  {x.current_file && live ? ` · ${x.current_file}` : ""}
                </small>
                {x.error && <div className="warn small">{x.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ skróty

const SHORTCUTS: [string, string][] = [
  ["Ctrl + Enter", "sc.generate"], ["Esc", "sc.esc"], ["Ctrl + S", "sc.save"], ["G", "sc.library"], ["Ctrl + ,", "sc.settings"],
  ["B / E", "sc.brushEraser"], ["[ / ]", "sc.brushSize"], ["Ctrl + Z / Ctrl + Y", "sc.undoRedo"], ["Space + drag", "sc.pan"],
  ["+ / − / 0", "sc.zoom"], ["C", "sc.compare"], ["F", "sc.favorite"], ["/", "sc.focusPrompt"],
];

// ------------------------------------------------------------------ strona

export function Settings() {
  const t = useT();
  const stored = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const loras = useStore((s) => s.loras);
  const system = useStore((s) => s.system);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const save = useStore((s) => s.saveSettings);
  const rescan = useStore((s) => s.rescan);
  const loadModel = useStore((s) => s.loadModel);
  const unloadModel = useStore((s) => s.unloadModel);
  const [draft, setDraft] = useState<SettingsT | null>(stored);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [comfy, setComfy] = useState(false);
  const lang = getLang();
  const remote = isRemote();                 // klient zdalny: bez folderów, instalacji modeli i zmiany ustawień silnika

  useEffect(() => { if (stored) setDraft(stored); }, [stored]);
  const dirty = useMemo(() => !!draft && !!stored && JSON.stringify(draft) !== JSON.stringify(stored), [draft, stored]);

  const upd = (patch: Partial<SettingsT>) => draft && setDraft({ ...draft, ...patch });

  const addComfy = (root: string) => {
    if (!draft) return;
    const mdl = joinPath(root, "models");
    const mdirs = [joinPath(mdl, "diffusion_models"), joinPath(mdl, "checkpoints"), joinPath(mdl, "unet")];
    setDraft({
      ...draft,
      model_dirs: [...new Set([...draft.model_dirs, ...mdirs])],
      lora_dirs: [...new Set([...draft.lora_dirs, joinPath(mdl, "loras")])],
    });
    setComfy(false);
  };

  return (
    <div className="settings">
      <h2>{t("settings.title")}</h2>

      <div className="card">
        <h3>{t("settings.general")}</h3>
        <div className="pair">
          <div>
            <span className="label">{t("settings.language")}</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
          </div>
          <div>
            <span className="label">{t("settings.saveFormat")}</span>
            <select value={ui.saveFormat} onChange={(e) => setUi({ saveFormat: e.target.value as SaveFormat })}>
              <option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option>
            </select>
          </div>
        </div>
      </div>

      <RemoteAccess />

      {remote ? null : !draft ? (
        <div className="card"><Spinner /> {t("loading")}</div>
      ) : (
        <div className="card">
          <h3>{t("settings.folders")}</h3>
          <PathList title={t("settings.modelDirs")} values={draft.model_dirs} onChange={(v) => upd({ model_dirs: v })} hint={t("settings.modelDirsHint")} />
          <PathList title={t("settings.loraDirs")} values={draft.lora_dirs} onChange={(v) => upd({ lora_dirs: v })} />
          <div className="comfy-add">
            <button className="btn small" onClick={() => setComfy(!comfy)}><FolderOpen size={13} /> {t("settings.addComfy")}</button>
            {comfy && <FolderPicker start="" onPick={addComfy} onClose={() => setComfy(false)} />}
          </div>
          <div className="pathlist">
            <div className="label">{t("settings.libraryDir")}</div>
            <p className="note small">{t("settings.libraryHint")}</p>
            <div className="with-btn">
              <input type="text" value={draft.library_dir} spellCheck={false} onChange={(e) => upd({ library_dir: e.target.value })} />
            </div>
          </div>

          <h3 className="spaced">{t("settings.engine")}</h3>
          <div className="pair">
            <div>
              <span className="label">{t("p.precision.name")} <Help k="precision" /></span>
              <select value={draft.precision} onChange={(e) => upd({ precision: e.target.value as SettingsT["precision"] })}>
                <option value="auto">Auto</option><option value="bf16">bfloat16</option><option value="fp16">float16</option>
              </select>
            </div>
            <div>
              <span className="label">{t("p.offload.name")} <Help k="offload" /></span>
              <select value={draft.offload} onChange={(e) => upd({ offload: e.target.value as SettingsT["offload"] })}>
                <option value="auto">Auto</option><option value="gpu">{t("settings.offloadGpu")}</option><option value="model">{t("settings.offloadModel")}</option>
              </select>
            </div>
          </div>
          <div className="pair spaced">
            <div>
              <span className="label">{t("settings.defaultModel")}</span>
              <select value={draft.default_model_id ?? ""} onChange={(e) => upd({ default_model_id: e.target.value || null })}>
                <option value="">—</option>
                {models.filter((m) => m.status === "ready").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <span className="label">{t("settings.hfToken")}</span>
              <input type="password" autoComplete="off" value={draft.hf_token ?? ""} placeholder="hf_…" onChange={(e) => upd({ hf_token: e.target.value || null })} />
            </div>
          </div>
          <div className="pair spaced">
            <div>
              <span className="label">{t("settings.unloadMode")}</span>
              <select value={draft.unload_mode} onChange={(e) => upd({ unload_mode: e.target.value as SettingsT["unload_mode"] })}>
                <option value="manual">{t("settings.unloadManual")}</option>
                <option value="after_job">{t("settings.unloadAfterJob")}</option>
                <option value="idle">{t("settings.unloadIdle")}</option>
              </select>
            </div>
            {draft.unload_mode === "idle" && (
              <div>
                <span className="label">{t("settings.unloadMinutes")}</span>
                <input type="number" min={1} max={1440} value={draft.unload_idle_minutes}
                  onChange={(e) => upd({ unload_idle_minutes: Math.max(1, Math.min(1440, Number(e.target.value) || 1)) })} />
              </div>
            )}
          </div>
          <p className="note small">{t("settings.unloadHint")}</p>
          <label className="check"><input type="checkbox" checked={draft.embed_metadata_png} onChange={(e) => upd({ embed_metadata_png: e.target.checked })} /><span>{t("settings.embedMeta")}<small>{t("settings.embedMetaHint")}</small></span></label>

          <div className="row-gap save-row">
            <button className="btn amber" disabled={!dirty || saving} onClick={async () => { setSaving(true); await save(draft); setSaving(false); }}>
              {saving ? <Spinner /> : <Save size={14} />} {t("settings.saveScan")}
            </button>
            {dirty && <button className="btn ghost" onClick={() => stored && setDraft(stored)}>{t("settings.revert")}</button>}
            {dirty && <small className="muted">{t("settings.unsaved")}</small>}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>{t("settings.models")}</h3>
          {!remote && (
            <button className="btn small" disabled={scanning} onClick={async () => { setScanning(true); await rescan(); setScanning(false); }}>
              {scanning ? <Spinner /> : <RefreshCw size={13} />} {t("settings.rescan")}
            </button>
          )}
        </div>
        {models.length === 0 && <div className="muted">{t("model.none")}</div>}
        {models.map((m) => (
          <div key={m.id} className={"model-list-row " + m.status}>
            <div>
              <b>{m.name}</b>
              <small>{m.family} · {m.kind} · {fmtBytes(m.size_bytes)} {m.license ? `· ${m.license}` : ""}</small>
              {!remote && <small className="path">{m.path}</small>}
              {m.status !== "ready" && <small className="warn-text"><AlertTriangle size={12} /> {m.unsupported_reason}</small>}
            </div>
            {m.status === "ready" && (
              m.loaded
                ? <button className="btn small" onClick={() => void unloadModel()}>{t("model.unload")}</button>
                : <button className="btn small" disabled={m.loading} onClick={() => void loadModel(m.id)}>{m.loading ? <Spinner /> : null} {t("model.load")}</button>
            )}
          </div>
        ))}
        <div className="muted small spaced">LoRA: {loras.length} · {t("lora.compat", { n: loras.filter((l) => l.status === "ready").length })}</div>
      </div>

      {!remote && <Installer />}

      <div className="card">
        <h3>{t("settings.system")}</h3>
        {system ? (
          <div className="sys-grid">
            <div><span>GPU</span><strong>{system.gpu.name}{system.gpu.arch ? ` (${system.gpu.arch})` : ""}</strong></div>
            <div><span>{t("settings.backend")}</span><strong>{system.gpu.backend.toUpperCase()}{system.versions.hip ? ` · HIP ${system.versions.hip}` : ""}</strong></div>
            <div><span>VRAM</span><strong>{fmtBytes(system.gpu.vram_used)} / {fmtBytes(system.gpu.vram_total)}</strong></div>
            <div><span>RAM</span><strong>{fmtBytes(system.ram.used)} / {fmtBytes(system.ram.total)}</strong></div>
            <div><span>PyTorch</span><strong>{system.versions.torch}</strong></div>
            <div><span>Diffusers</span><strong>{system.versions.diffusers}</strong></div>
            <div><span>{t("settings.diskModels")}</span><strong>{fmtBytes(system.disk.models_free)}</strong></div>
            <div><span>{t("settings.diskLibrary")}</span><strong>{fmtBytes(system.disk.library_free)}</strong></div>
          </div>
        ) : <Spinner />}
      </div>

      <div className="card">
        <h3>{t("settings.shortcuts")}</h3>
        <div className="shortcuts">
          {SHORTCUTS.map(([k, d]) => <div key={k}><kbd>{k}</kbd><span>{t(d)}</span></div>)}
        </div>
      </div>
    </div>
  );
}
