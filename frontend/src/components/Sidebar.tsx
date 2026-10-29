import { useEffect, useMemo, useState } from "react";
import { Dices, Shuffle, Image as ImageIcon, Layers, Check, Pencil, Plus, RefreshCw, RotateCcw, Sparkles, Trash2, X, ArrowLeftRight, Paintbrush, Power } from "lucide-react";
import { useT } from "../i18n";
import { activeJobOf, pendingJobs, selCaps, selModel, useStore } from "../store";
import { detectRatio, dimsFor, fmtBytes, isPortrait, MODES, ratioText, ratiosFor } from "../lib";
import type { Mode } from "../types";
import { AttachmentsSection } from "./Attachments";
import { Collapse, Help, Label, Range, Section, Spinner, Switch } from "./ui";

const MODE_ICON: Record<Mode, typeof Sparkles> = { t2i: Sparkles, edit: ImageIcon, multi: Layers, inpaint: Paintbrush };

// ------------------------------------------------------------------ Model

function ModelSection() {
  const t = useT();
  const models = useStore((s) => s.models);
  const model = useStore(selModel);
  const system = useStore((s) => s.system);
  const modelId = useStore((s) => s.form.modelId);
  const selectModel = useStore((s) => s.selectModel);
  const loadModel = useStore((s) => s.loadModel);
  const unloadModel = useStore((s) => s.unloadModel);
  const setPage = useStore((s) => s.setPage);
  const caps = model?.capabilities;
  const unsupported = models.filter((m) => m.status !== "ready");
  const ready = models.filter((m) => m.status === "ready");
  const vram = system?.gpu;

  return (
    <Section title={t("model.title")} helpKey="model">
      {models.length === 0 ? (
        <div className="note">
          {t("model.none")}{" "}
          <button className="link" onClick={() => setPage("settings")}>{t("model.install")}</button>
        </div>
      ) : (
        <div className="model-pick">
          <select value={modelId ?? ""} onChange={(e) => selectModel(e.target.value)} aria-label={t("model.title")}>
            {!ready.length && <option value="">—</option>}
            {ready.map((m) => (
              <option key={m.id} value={m.id}>{m.loaded ? "● " : ""}{m.name}</option>
            ))}
          </select>
          {model && (model.loaded ? (
            <button className="btn model-btn unload" onClick={() => void unloadModel()} title={t("model.unloadHint")}>
              <Power size={14} /> {t("model.unload")}
            </button>
          ) : (
            <button className="btn model-btn load" disabled={model.loading} onClick={() => void loadModel(model.id)} title={t("model.loadHint")}>
              {model.loading ? <Spinner /> : <Power size={14} />} {model.loading ? t("model.loadingShort") : t("model.load")}
            </button>
          ))}
        </div>
      )}

      {model && (
        <>
          <div className="statusline">
            <span>
              <i className={"dot " + (model.loading ? "busy" : model.loaded ? "on" : "")} />
              <b className={"loadpill " + (model.loading ? "busy" : model.loaded ? "on" : "")}>
                {model.loading ? t("model.loading") : model.loaded ? t("model.loaded") : t("model.notLoaded")}
              </b>
            </span>
            {vram?.available && (
              <span title={t("model.vramHint")}>
                VRAM {(vram.vram_used / 2 ** 30).toFixed(1)} / {(vram.vram_total / 2 ** 30).toFixed(0)} GB
              </span>
            )}
          </div>
          {vram?.available && (
            <div className="meter" aria-hidden>
              <div style={{ width: `${Math.min(100, (vram.vram_used / vram.vram_total) * 100)}%` }} />
            </div>
          )}
          <div className="capabilities">
            {caps?.modes.map((m) => <span key={m} className="cap">{t(`cap.${m}`)}</span>)}
            {caps?.lora && <span className="cap">LoRA</span>}
            <span className="cap dim">{fmtBytes(model.size_bytes)}</span>
          </div>
          {model.notes && <p className="note small">{model.notes}</p>}
        </>
      )}

      {unsupported.length > 0 && (
        <details className="unsupported">
          <summary>{t("model.unsupportedList", { n: unsupported.length })}</summary>
          {unsupported.map((m) => (
            <div key={m.id} className="unsup-item">
              <b>{m.name}</b>
              <span>{m.unsupported_reason ?? t("model.unsupported")}</span>
            </div>
          ))}
        </details>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Tryb

function ModeSection() {
  const t = useT();
  const caps = useStore(selCaps);
  const mode = useStore((s) => s.form.mode);
  const setMode = useStore((s) => s.setMode);
  return (
    <Section title={t("mode.title")} helpKey="mode">
      <div className="modes">
        {MODES.map((m) => {
          const Ico = MODE_ICON[m];
          const ok = !!caps?.modes.includes(m);
          return (
            <button
              key={m}
              className={"mode " + (mode === m ? "active" : "")}
              disabled={!ok}
              title={ok ? t(`mode.${m}.hint`) : t("mode.unavailable")}
              onClick={() => setMode(m)}
            >
              <Ico size={15} /> {t(`mode.${m}`)}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ Prompt

function PromptSection() {
  const t = useT();
  const prompt = useStore((s) => s.form.prompt);
  const setForm = useStore((s) => s.setForm);
  return (
    <Section
      title={t("prompt.title")}
      helpKey="prompt"
      right={
        <button className="open-composer" onClick={() => useStore.setState({ composerOpen: true })}>
          <Sparkles size={13} /> {t("composer.open")}
        </button>
      }
    >
      <textarea
        value={prompt}
        placeholder={t("prompt.placeholder")}
        onChange={(e) => setForm({ prompt: e.target.value }, true)}
        aria-label={t("prompt.title")}
      />
      <div className="prompt-count">{t("prompt.count", { n: prompt.length })}</div>
    </Section>
  );
}

// ------------------------------------------------------------------ Presety

function PresetsSection() {
  const t = useT();
  const presets = useStore((s) => s.presets);
  const modelId = useStore((s) => s.form.modelId);
  const active = useStore((s) => s.ui.activePreset);
  const applyPreset = useStore((s) => s.applyPreset);
  const savePreset = useStore((s) => s.savePreset);
  const updatePreset = useStore((s) => s.updatePreset);
  const removePreset = useStore((s) => s.removePreset);
  const currentValues = useStore((s) => s.currentPresetValues);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const act = presets.find((p) => p.id === active);
  const visible = presets.filter((p) => !p.model_id || p.model_id === modelId);

  const commit = async () => {
    const n = name.trim();
    if (!n) return;
    if (renaming && act) await updatePreset({ ...act, name: n });
    else await savePreset(n);
    setAdding(false); setRenaming(false); setName("");
  };

  return (
    <Section title={t("presets.title")} helpKey="presets">
      <div className="presets">
        {visible.map((p) => (
          <button key={p.id} className={"chip " + (active === p.id ? "active" : "") + (p.builtin ? "" : " custom")} onClick={() => applyPreset(p)}>
            {p.name}
          </button>
        ))}
        <button className="chip add" title={t("presets.save")} onClick={() => { setAdding(!adding); setRenaming(false); setName(""); }}>
          <Plus size={13} />
        </button>
      </div>
      {(adding || renaming) && (
        <div className="inline-form">
          <input
            autoFocus type="text" value={name} maxLength={40}
            placeholder={t("presets.name")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") { setAdding(false); setRenaming(false); } }}
          />
          <button className="btn teal icon" title={t("save")} onClick={() => void commit()}><Check size={14} /></button>
        </div>
      )}
      {act && !act.builtin && !adding && !renaming && (
        <div className="row-gap preset-tools">
          <button className="btn small ghost" onClick={() => { setRenaming(true); setName(act.name); }}><Pencil size={12} /> {t("presets.rename")}</button>
          <button className="btn small ghost" onClick={() => void updatePreset({ ...act, values: currentValues() })}><RefreshCw size={12} /> {t("presets.update")}</button>
          {confirmDel ? (
            <button className="btn small danger" onClick={() => { void removePreset(act.id); setConfirmDel(false); }}>{t("confirm.delete")}</button>
          ) : (
            <button className="btn small ghost danger" onClick={() => { setConfirmDel(true); window.setTimeout(() => setConfirmDel(false), 3500); }}><Trash2 size={12} /></button>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Parametry (podstawowe + przełącznik zaawansowanych)

const flipRatio = (r: string) => r.split(":").reverse().join(":");

/** Przycisk proporcji: prostokąt przyjmuje bieżące proporcje (3:2, 4:5, 1:1 …) i płynnie zmienia kształt po kliknięciu,
 *  a mała strzałka ↺ obraca się o ćwierć obrotu. Kolejne kliknięcia: poziomo → 1:1 → pionowo → 1:1 → poziomo. */
function OrientButton({ w, h, turns, title, onClick }: { w: number; h: number; turns: number; title: string; onClick: () => void }) {
  const t = useT();
  const k = w / h;
  const S = 14;
  const rw = k >= 1 ? S : S * k;
  const rh = k >= 1 ? S / k : S;
  return (
    <button className="orient" title={title} aria-label={t("ratio.change")} onClick={onClick}>
      <span className="orient-ico">
        <svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">
          <rect className="orient-rect" style={{ x: 12 - rw / 2, y: 12 - rh / 2, width: rw, height: rh }} rx="2.4" />
        </svg>
        <RotateCcw size={10} className="orient-arrow" style={{ transform: `rotate(${-90 * turns}deg)` }} />
      </span>
    </button>
  );
}

function ParamsSection() {
  const t = useT();
  const caps = useStore(selCaps);
  const form = useStore((s) => s.form);
  const advanced = useStore((s) => s.ui.advancedOpen);
  const setUi = useStore((s) => s.setUi);
  const setForm = useStore((s) => s.setForm);
  const baseRatio = useStore((s) => s.ui.baseRatio);
  const prevOrient = useStore((s) => s.ui.prevOrient);
  const [turns, setTurns] = useState(0);
  const ratio0 = detectRatio(form.width, form.height);
  const portrait0 = isPortrait(form.width, form.height);
  // zapamiętujemy ostatnią niekwadratową proporcję (postać pozioma), do której wraca przycisk po przejściu przez 1:1
  useEffect(() => {
    if (ratio0 === "custom" || ratio0 === "1:1") return;
    const base = portrait0 ? flipRatio(ratio0) : ratio0;
    if (base !== useStore.getState().ui.baseRatio) setUi({ baseRatio: base });
  }, [ratio0, portrait0, setUi]);
  if (!caps) return null;
  const m = caps.resolution.multiple;
  const square = form.width === form.height;
  const portrait = isPortrait(form.width, form.height);
  const ratio = detectRatio(form.width, form.height);
  const long = Math.max(form.width, form.height);
  const presets = caps.resolution.presets;
  const setDims = (r: string, res: number) => setForm(dimsFor(r, res, m));
  const swap = () => setForm({ width: form.height, height: form.width });
  // następny krok: poziomo → 1:1 → pionowo → 1:1 → poziomo; niestandardowe wymiary po prostu się odwracają
  let nextRatio: string | null = null;
  if (ratio === "custom" && !square) nextRatio = null;
  else if (square) nextRatio = prevOrient === "landscape" ? flipRatio(baseRatio) : baseRatio;
  else nextRatio = "1:1";
  const cycle = () => {
    setTurns((n) => n + 1);
    if (nextRatio == null) return swap();
    if (!square) setUi({ prevOrient: portrait ? "portrait" : "landscape" });
    setDims(nextRatio, long);
  };
  const orientTitle = nextRatio == null ? t("params.orient.toPortrait") : `${t("ratio.change")}: ${nextRatio}`;
  const dim = (key: "width" | "height", v: number) => setForm({ [key]: Math.min(caps.resolution.max, Math.max(caps.resolution.min, Math.round(v / m) * m)) });
  const showDenoise = caps.denoise && caps.denoise.modes.includes(form.mode);

  return (
    <Section title={t("params.title")}>
      {!advanced ? (
        <div className="pair">
          <div>
            <Label k="ratio" def="1:1" />
            <div className="with-btn">
              <select value={ratio} onChange={(e) => e.target.value !== "custom" && setDims(e.target.value, long)}>
                {ratiosFor(portrait).map((r) => <option key={r} value={r}>{r}</option>)}
                {ratio === "custom" && <option value="custom">{form.width}×{form.height}</option>}
              </select>
              <OrientButton w={form.width} h={form.height} turns={turns} title={orientTitle} onClick={cycle} />
            </div>
          </div>
          <div>
            <Label k="resolution" def={`${caps.resolution.default} px`} />
            <select value={long} onChange={(e) => setDims(ratio === "custom" ? `${form.width}:${form.height}` : ratio, Number(e.target.value))}>
              {!presets.includes(long) && <option value={long}>{long} px</option>}
              {presets.map((r) => <option key={r} value={r}>{r} px</option>)}
            </select>
          </div>
        </div>
      ) : (
        <div>
          <Label k="size" text={`${t("adv.width")} × ${t("adv.height")} (px)`} />
          <div className="dims-inputs">
            <input type="number" step={m} min={caps.resolution.min} max={caps.resolution.max} value={form.width} aria-label={t("adv.width")} onChange={(e) => dim("width", Number(e.target.value))} />
            <button className="icon-btn" title={t("params.swapWH")} aria-label={t("params.swapWH")} onClick={swap}><ArrowLeftRight size={14} /></button>
            <input type="number" step={m} min={caps.resolution.min} max={caps.resolution.max} value={form.height} aria-label={t("adv.height")} onChange={(e) => dim("height", Number(e.target.value))} />
          </div>
        </div>
      )}
      <div className="dims-hint">{ratioText(form.width, form.height)} · {form.width} × {form.height} px · {((form.width * form.height) / 1e6).toFixed(2)} MP</div>
      <Range k="steps" value={form.steps} min={caps.steps.min} max={caps.steps.max} step={1} onChange={(v) => setForm({ steps: v })} def={String(caps.steps.default)} />

      <Switch checked={advanced} onChange={(v) => setUi({ advancedOpen: v })} label={t("advanced.title")} hint={t("advanced.hint")} />

      {advanced && (
        <div className="adv-body">
          {caps.cfg && (
            <Range k="cfg" value={form.cfg} min={caps.cfg.min} max={caps.cfg.max} step={caps.cfg.step} onChange={(v) => setForm({ cfg: v })} def={String(caps.cfg.default)} format={(v) => v.toFixed(1)} />
          )}
          {showDenoise && caps.denoise && (
            <Range k="denoise" value={form.denoise} min={caps.denoise.min} max={caps.denoise.max} step={caps.denoise.step} onChange={(v) => setForm({ denoise: v })} def={String(caps.denoise.default)} format={(v) => v.toFixed(2)} />
          )}
          <div className="pair spaced">
            <div>
              <Label k="seed" def={t("seed.random")} />
              <div className="with-btn">
                <input type="number" value={form.seed} onChange={(e) => setForm({ seed: Math.trunc(Number(e.target.value)) }, true)} aria-label="seed" />
                <button className="icon-btn" title={t("seed.dice")} aria-label={t("seed.dice")} onClick={() => setForm({ seed: Math.floor(Math.random() * 4294967295) }, true)}><Dices size={14} /></button>
                {form.seed !== -1 && <button className="icon-btn" title={t("seed.auto")} aria-label={t("seed.auto")} onClick={() => setForm({ seed: -1 }, true)}><Shuffle size={14} /></button>}
              </div>
            </div>
            <div>
              <Label k="batch" def="1" />
              <select value={form.batch} onChange={(e) => setForm({ batch: Number(e.target.value) })}>
                {Array.from({ length: caps.max_batch }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>
          {(caps.sampler || caps.scheduler) && (
            <div className="pair spaced">
              {caps.sampler && (
                <div>
                  <Label k="sampler" />
                  <select value={form.sampler} onChange={(e) => setForm({ sampler: e.target.value })}>{caps.sampler.map((x) => <option key={x}>{x}</option>)}</select>
                </div>
              )}
              {caps.scheduler && (
                <div>
                  <Label k="scheduler" />
                  <select value={form.scheduler} onChange={(e) => setForm({ scheduler: e.target.value })}>{caps.scheduler.map((x) => <option key={x}>{x}</option>)}</select>
                </div>
              )}
            </div>
          )}
          {caps.negative_prompt && (
            <div className="spaced">
              <Label k="negative" />
              <textarea className="short" value={form.negative} onChange={(e) => setForm({ negative: e.target.value }, true)} placeholder={t("negative.placeholder")} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ LoRA

function LoraSection() {
  const t = useT();
  const caps = useStore(selCaps);
  const loras = useStore((s) => s.loras);
  const modelId = useStore((s) => s.form.modelId);
  const enabled = useStore((s) => s.form.loras);
  const open = useStore((s) => s.ui.loraOpen);
  const setUi = useStore((s) => s.setUi);
  const setLora = useStore((s) => s.setLora);
  const setPage = useStore((s) => s.setPage);
  const [q, setQ] = useState("");

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return loras
      .filter((l) => !ql || l.name.toLowerCase().includes(ql))
      .map((l) => ({ l, ok: !!modelId && l.compatible_model_ids.includes(modelId) && l.status !== "incompatible" }))
      .sort((a, b) => Number(b.ok) - Number(a.ok) || a.l.name.localeCompare(b.l.name));
  }, [loras, q, modelId]);

  if (!caps?.lora) return null;
  const count = Object.keys(enabled).length;
  return (
    <Collapse
      title={t("lora.title")}
      open={open}
      onToggle={() => setUi({ loraOpen: !open })}
      badge={count > 0 ? <span className="badge">{count}</span> : null}
    >
      <div className="with-btn">
        <input type="search" value={q} placeholder={t("lora.search")} onChange={(e) => setQ(e.target.value)} aria-label={t("lora.search")} />
        <Help k="lora" />
      </div>
      <div className="lora-list">
        {list.length === 0 && (
          <div className="note small">
            {loras.length === 0 ? t("lora.none") : t("lora.noMatch")}{" "}
            {loras.length === 0 && <button className="link" onClick={() => setPage("settings")}>{t("lora.addFolder")}</button>}
          </div>
        )}
        {list.map(({ l, ok }) => {
          const on = enabled[l.id] !== undefined;
          return (
            <div key={l.id} className={"lora-row " + (ok ? "" : "disabled")} title={ok ? l.path : l.reason ?? t("lora.incompatible")}>
              <input type="checkbox" checked={on} disabled={!ok} onChange={(e) => setLora(l.id, e.target.checked ? l.default_strength || 1 : null)} aria-label={l.name} />
              <div className="name">
                {l.name}
                <small>{ok ? `${fmtBytes(l.size_bytes)}` : l.reason ?? t("lora.incompatible")}</small>
              </div>
              {on && (
                <>
                  <input type="range" min={0} max={2} step={0.05} value={enabled[l.id]} onChange={(e) => setLora(l.id, Number(e.target.value))} aria-label={t("p.loraStrength.name")} />
                  <span className="num">{enabled[l.id].toFixed(2)}</span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {count > 0 && <div className="row-gap"><Help k="loraStrength" /><small className="muted">{t("lora.hint")}</small></div>}
    </Collapse>
  );
}

// ------------------------------------------------------------------ Dolny pasek: Generuj

function GenerateBar() {
  const t = useT();
  const jobs = useStore((s) => s.jobs);
  const model = useStore(selModel);
  const online = useStore((s) => s.online);
  const submit = useStore((s) => s.submit);
  const cancel = useStore((s) => s.cancelJob);
  const pending = pendingJobs(jobs);
  const active = activeJobOf(jobs);
  const ready = !!model && model.status === "ready" && online;
  const msg = !online ? t("offline.short") : !model ? t("err.noModel") : active ? (active.status === "queued" ? t("gen.queued") : t(`stage.${active.stage}`)) : model.loaded ? t("gen.ready") : t("gen.willLoad");

  return (
    <div className="bottom-controls">
      <div className="ready">
        <span className={"dot " + (active ? "busy" : ready ? "on" : "")} />
        <span>{msg}{pending.length > 1 ? ` · ${t("gen.inQueue", { n: pending.length })}` : ""}</span>
        <kbd>Ctrl ↵</kbd>
      </div>
      <div className="gen-row">
        <button className="generate" disabled={!ready} onClick={() => void submit()}>
          <Sparkles size={16} /> <b>{pending.length ? t("gen.addQueue") : t("generate")}</b>
        </button>
        {active && (
          <button className="btn cancel" title={`${t("cancel")} (Esc)`} onClick={() => void cancel(active.id)}><X size={15} /></button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ całość

export function Sidebar({ onResizeStart, onClose }: { onResizeStart: (e: React.PointerEvent) => void; onClose?: () => void }) {
  const t = useT();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="eyebrow">{t("brand.eyebrow")}</div>
        <div className="brandline"><b>Image Studio</b></div>
        {onClose && <button className="icon-btn drawer-close" aria-label={t("close")} title={t("close")} onClick={onClose}><X size={16} /></button>}
      </div>
      <div className="scroll">
        <ModelSection />
        <ModeSection />
        <PromptSection />
        <AttachmentsSection />
        <PresetsSection />
        <ParamsSection />
        <LoraSection />
      </div>
      <GenerateBar />
      <div className="resizer" role="separator" aria-orientation="vertical" tabIndex={0} aria-label={t("sidebar.resize")} onPointerDown={onResizeStart}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const w = useStore.getState().ui.sidebarWidth + (e.key === "ArrowRight" ? 16 : -16);
          useStore.getState().setUi({ sidebarWidth: Math.max(290, Math.min(560, w)) });
        }}
      >
        <span />
      </div>
    </aside>
  );
}
