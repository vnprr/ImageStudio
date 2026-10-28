import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ApiError, api, connectEvents, type EventType } from "./api";
import { tr } from "./i18n";
import { IS_WEB, getConn, isRemote } from "./connection";
import { clamp, debounce, dimsFor, uid } from "./lib";
import { emptyPaint, hasDoodle, hasMask, renderDoodled, renderMaskPng, type Layer, type PaintDoc, type Stroke } from "./paint";
import type {
  Capabilities, DownloadState, GenerationRequest, ImageRecord, InputRef, Job, LoraInfo, Mode,
  ModelInfo, Preset, PromptLibrary, SaveFormat, Settings, SystemStats,
} from "./types";

export type Page = "studio" | "library" | "details" | "settings";

export interface Form {
  modelId: string | null;
  mode: Mode;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  denoise: number;
  sampler: string;
  scheduler: string;
  seed: number;
  batch: number;
  loras: Record<string, number>;
}

type ModelParams = Pick<Form, "steps" | "cfg" | "denoise" | "sampler" | "scheduler" | "width" | "height" | "mode">;

export interface UiPrefs {
  sidebarWidth: number;
  historyClosed: boolean;
  advancedOpen: boolean;
  loraOpen: boolean;
  saveFormat: SaveFormat;
  saveQuality: number;
  saveMeta: boolean;
  activePreset: string;
  applied: string[];
  brush: number;
  paintLayer: Layer;
  paintTool: "brush" | "eraser";
  doodleColor: string;
  /** rozmiar miniatur dolnej galerii (px) */
  historyThumb: number;
  /** rozmiar kafelków w pełnej galerii (px) i jej układ */
  galleryThumb: number;
  /** rozmiar miniatury w widoku listy */
  listThumb: number;
  galleryView: "grid" | "list";
  /** pasek narzędzi malowania zwinięty do paska „—" */
  paintBarMin: boolean;
}

export interface InputImage {
  ref: InputRef;
  url: string;
  name: string;
  width?: number;
  height?: number;
}

/** Rola załącznika: obraz do edycji (źródło), inspiracja (referencja) albo nieaktywny (leży na liście, program go pomija). */
export type AttachRole = "edit" | "ref" | "off";

export interface Attachment extends InputImage {
  id: string;
  role: AttachRole;
  paint: PaintDoc;
}

export type MenuItem =
  | { sep: true }
  | { label: string; icon?: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; hint?: string };

export interface CtxMenu { x: number; y: number; items: MenuItem[] }

export interface Toast { id: string; kind: "info" | "success" | "error"; text: string }

const defaultForm: Form = {
  modelId: null, mode: "t2i",
  prompt: "",
  negative: "", width: 1024, height: 1024, steps: 4, cfg: 1, denoise: 0.65, sampler: "", scheduler: "",
  seed: -1, batch: 1, loras: {},
};

const defaultUi: UiPrefs = {
  sidebarWidth: 340, historyClosed: false, advancedOpen: false, loraOpen: true,
  saveFormat: "png", saveQuality: 92, saveMeta: true, activePreset: "", applied: [], brush: 40,
  paintLayer: "mask", paintTool: "brush", doodleColor: "#ff3d81", historyThumb: 72, galleryThumb: 190, listThumb: 96, galleryView: "grid", paintBarMin: false,
};

interface State {
  // trwałe
  form: Form;
  perModel: Record<string, ModelParams>;
  ui: UiPrefs;
  // dane z backendu
  online: boolean | null;
  /** silnik odpowiedział 401: token zły albo zmieniony (pokazujemy ekran łączenia) */
  authRequired: boolean;
  models: ModelInfo[];
  loras: LoraInfo[];
  system: SystemStats | null;
  settings: Settings | null;
  presets: Preset[];
  promptLib: PromptLibrary | null;
  jobs: Record<string, Job>;
  downloads: Record<string, DownloadState>;
  recent: ImageRecord[];
  cache: Record<string, ImageRecord>;
  libraryVersion: number;
  // widok
  page: Page;
  selectedId: string | null;
  attachments: Attachment[];
  /** id załącznika otwartego w edytorze malowania (nakładka na scenie) */
  paintId: string | null;
  composerOpen: boolean;
  compare: boolean;
  toasts: Toast[];
  dragging: boolean;
  /** strefa upuszczania pod kursorem podczas przeciągania plików */
  hotZone: string | null;
  menu: CtxMenu | null;
}

interface Actions {
  boot: () => void;
  bootData: () => Promise<void>;
  setPage: (p: Page) => void;
  setForm: (patch: Partial<Form>, keepPreset?: boolean) => void;
  setUi: (patch: Partial<UiPrefs>) => void;
  selectModel: (id: string) => void;
  setMode: (m: Mode) => void;
  setLora: (id: string, strength: number | null) => void;
  applyPreset: (p: Preset) => void;
  currentPresetValues: () => Preset["values"];
  savePreset: (name: string) => Promise<void>;
  updatePreset: (p: Preset) => Promise<void>;
  removePreset: (id: string) => Promise<void>;
  setPromptLib: (fn: (d: PromptLibrary) => PromptLibrary) => void;
  addFragments: (ids: string[], extra?: string) => void;
  removeFragment: (id: string) => void;
  submit: (opts?: { variant?: boolean }) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  applyRequest: (r: GenerationRequest, o?: { newSeed?: boolean }) => void;
  select: (id: string | null) => void;
  openDetails: (id: string) => void;
  putImage: (r: ImageRecord) => void;
  getImage: (id: string) => Promise<ImageRecord | null>;
  patchImage: (id: string, p: { favorite?: boolean; hidden?: boolean }) => Promise<void>;
  deleteImage: (id: string) => Promise<void>;
  addFiles: (files: File[], target: "attach" | "library") => Promise<void>;
  useAsSource: (r: ImageRecord) => void;
  addAsRef: (r: ImageRecord) => void;
  setRole: (id: string, role: AttachRole) => void;
  removeAttachment: (id: string) => void;
  paintOpen: (id: string | null) => void;
  paintCommit: (id: string, s: Stroke) => void;
  paintUndo: () => void;
  paintRedo: () => void;
  paintClear: (layer: Layer) => void;
  paintInvert: () => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  loadModel: (id: string) => Promise<void>;
  unloadModel: () => Promise<void>;
  rescan: () => Promise<void>;
  saveSettings: (s: Settings) => Promise<void>;
  toast: (kind: Toast["kind"], text: string) => void;
  dismissToast: (id: string) => void;
  refreshRecent: () => Promise<void>;
}

export type Store = State & Actions;

// ------------------------------------------------------------------ pomocnicze

export const selSource = (s: State): Attachment | null => s.attachments.find((a) => a.role === "edit") ?? null;
export const selModel = (s: State): ModelInfo | null => s.models.find((m) => m.id === s.form.modelId) ?? null;
export const selCaps = (s: State): Capabilities | null => selModel(s)?.capabilities ?? null;

export function activeJobOf(jobs: Record<string, Job>): Job | null {
  const list = Object.values(jobs);
  return list.find((j) => j.status === "running") ?? list.filter((j) => j.status === "queued").sort((a, b) => a.created_at - b.created_at)[0] ?? null;
}
export const pendingJobs = (jobs: Record<string, Job>) => Object.values(jobs).filter((j) => j.status === "queued" || j.status === "running");

function defaultsFor(caps: Capabilities): Omit<ModelParams, "mode"> {
  const d = dimsFor("1:1", caps.resolution.default, caps.resolution.multiple);
  return {
    steps: caps.steps.default,
    cfg: caps.cfg?.default ?? 0,
    denoise: caps.denoise?.default ?? 0.65,
    sampler: caps.sampler?.[0] ?? "",
    scheduler: caps.scheduler?.[0] ?? "",
    width: d.width,
    height: d.height,
  };
}

function fitToCaps(f: Form, caps: Capabilities): Form {
  const m = caps.resolution.multiple;
  const snap = (v: number) => clamp(Math.round(v / m) * m, caps.resolution.min, caps.resolution.max);
  return {
    ...f,
    steps: clamp(f.steps, caps.steps.min, caps.steps.max),
    cfg: caps.cfg ? clamp(f.cfg, caps.cfg.min, caps.cfg.max) : f.cfg,
    denoise: caps.denoise ? clamp(f.denoise, caps.denoise.min, caps.denoise.max) : f.denoise,
    sampler: caps.sampler ? (caps.sampler.includes(f.sampler) ? f.sampler : caps.sampler[0]) : "",
    scheduler: caps.scheduler ? (caps.scheduler.includes(f.scheduler) ? f.scheduler : caps.scheduler[0]) : "",
    batch: clamp(f.batch, 1, caps.max_batch),
    width: snap(f.width),
    height: snap(f.height),
    mode: caps.modes.includes(f.mode) ? f.mode : caps.modes[0] ?? "t2i",
  };
}

const paramsOf = (f: Form): ModelParams => ({
  steps: f.steps, cfg: f.cfg, denoise: f.denoise, sampler: f.sampler, scheduler: f.scheduler,
  width: f.width, height: f.height, mode: f.mode,
});

const inputFromRef = (ref: InputRef, name: string): InputImage => ({
  ref, name, url: "image_id" in ref ? api.imageUrl(ref.image_id) : api.uploadUrl(ref.upload_id),
});

const attach = (img: InputImage, role: AttachRole): Attachment => ({ ...img, id: uid("att"), role, paint: emptyPaint() });

const savePromptLib = debounce((d: PromptLibrary) => {
  api.putPromptLibrary(d).catch((e) => useStore.getState().toast("error", tr("err.save", { m: String(e.message) })));
}, 700);

// ------------------------------------------------------------------ store

let booted = false;

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      form: defaultForm,
      perModel: {},
      ui: defaultUi,
      online: null,
      authRequired: false,
      models: [],
      loras: [],
      system: null,
      settings: null,
      presets: [],
      promptLib: null,
      jobs: {},
      downloads: {},
      recent: [],
      cache: {},
      libraryVersion: 0,
      page: "studio",
      selectedId: null,
      attachments: [],
      paintId: null,
      composerOpen: false,
      compare: false,
      toasts: [],
      dragging: false,
      hotZone: null,
      menu: null,

      // ------------------------------------------------------------ start
      boot: () => {
        if (booted) return;
        if (IS_WEB && !getConn()) return;          // wersja web bez połączenia: najpierw ekran łączenia
        booted = true;
        window.addEventListener("is:unauthorized", () => set({ authRequired: true }));
        void get().bootData();
        connectEvents(
          (type: EventType, data: unknown) => {
            const st = get();
            switch (type) {
              case "system": set({ system: data as SystemStats }); break;
              case "job": onJob(data as Job); break;
              case "download": {
                const d = data as DownloadState;
                set({ downloads: { ...st.downloads, [d.id]: d } });
                break;
              }
              case "models":
                void Promise.all([api.models(), api.loras()]).then(([models, loras]) => { set({ models, loras }); ensureModel(); }).catch(() => {});
                break;
              case "library":
                set({ libraryVersion: st.libraryVersion + 1 });
                void get().refreshRecent();
                break;
            }
          },
          (online) => {
            const was = get().online;
            set({ online });
            if (online && was === false) void get().bootData();
          },
        );
      },

      bootData: async () => {
        try {
          const system = await api.system();
          set({ system, online: true });
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) set({ authRequired: true, online: true });
          else set({ online: false });
          return;
        }
        const safe = <T,>(p: Promise<T>, fb: T) => p.catch(() => fb);
        const [settings, models, loras, presets, promptLib, jobs, downloads] = await Promise.all([
          safe(api.settings(), null), safe(api.models(), [] as ModelInfo[]), safe(api.loras(), [] as LoraInfo[]),
          safe(api.presets(), [] as Preset[]), safe(api.promptLibrary(), null), safe(api.jobs(), [] as Job[]),
          safe(isRemote() ? Promise.resolve([] as DownloadState[]) : api.downloads(), [] as DownloadState[]),
        ]);
        set({
          settings, models, loras, presets, promptLib,
          jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
          downloads: Object.fromEntries(downloads.map((d) => [d.id, d])),
        });
        ensureModel();
        await get().refreshRecent();
        syncInputsToMode();
      },

      refreshRecent: async () => {
        try {
          const r = await api.images({ limit: 30, sort: "new", filter: "all" });
          const cache = { ...get().cache };
          r.items.forEach((i) => { cache[i.id] = i; });
          set({ recent: r.items, cache });
          if (!get().selectedId && r.items[0]) set({ selectedId: r.items[0].id });
        } catch { /* backend chwilowo niedostępny */ }
      },

      setPage: (page) => set({ page, composerOpen: false, paintId: null, menu: null }),

      setForm: (patch, keepPreset) => {
        const s = get();
        const form = { ...s.form, ...patch };
        const perModel = form.modelId ? { ...s.perModel, [form.modelId]: paramsOf(form) } : s.perModel;
        set({ form, perModel, ui: keepPreset ? s.ui : { ...s.ui, activePreset: "" } });
      },

      setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),

      selectModel: (id) => {
        const s = get();
        const m = s.models.find((x) => x.id === id);
        if (!m || m.status !== "ready" || !m.capabilities) return;
        const caps = m.capabilities;
        const prev = s.perModel[id];
        const base: Form = { ...s.form, modelId: id, ...defaultsFor(caps), ...(prev ?? {}) };
        const form = fitToCaps(base, caps);
        // zostaw tylko LoRA zgodne z nowym modelem
        const loras: Record<string, number> = {};
        for (const [lid, v] of Object.entries(s.form.loras)) {
          const l = s.loras.find((x) => x.id === lid);
          if (l && caps.lora && l.compatible_model_ids.includes(id)) loras[lid] = v;
        }
        form.loras = loras;
        set({ form, perModel: { ...s.perModel, [id]: paramsOf(form) }, ui: { ...s.ui, activePreset: "" } });
        if (!caps.modes.includes(form.mode)) get().setMode(caps.modes[0]);
        syncInputsToMode();
      },

      setMode: (mode) => {
        const caps = selCaps(get());
        if (caps && !caps.modes.includes(mode)) return;
        get().setForm({ mode }, true);
        syncInputsToMode();
      },

      setLora: (id, strength) => {
        const loras = { ...get().form.loras };
        if (strength === null) delete loras[id];
        else loras[id] = strength;
        get().setForm({ loras }, true);
      },

      // ------------------------------------------------------------ presety
      currentPresetValues: () => {
        const { form } = get();
        const caps = selCaps(get());
        const v: Preset["values"] = { steps: form.steps, batch: form.batch, mode: form.mode, resolution: Math.max(form.width, form.height) };
        v.ratio = `${form.width}:${form.height}`;
        if (caps?.cfg) v.cfg = form.cfg;
        if (caps?.sampler) v.sampler = form.sampler;
        if (caps?.scheduler) v.scheduler = form.scheduler;
        if (caps?.denoise) v.denoise = form.denoise;
        v.loras = Object.entries(form.loras).map(([id, strength]) => ({ id, strength }));
        return v;
      },

      applyPreset: (p) => {
        const s = get();
        const caps = selCaps(s);
        if (!caps) return;
        const v = p.values;
        let form: Form = { ...s.form };
        if (v.steps != null) form.steps = v.steps;
        if (v.cfg != null) form.cfg = v.cfg;
        if (v.denoise != null) form.denoise = v.denoise;
        if (v.sampler) form.sampler = v.sampler;
        if (v.scheduler) form.scheduler = v.scheduler;
        if (v.batch != null) form.batch = v.batch;
        if (v.mode && caps.modes.includes(v.mode)) form.mode = v.mode;
        if (v.ratio && v.resolution) {
          // proporcja: klasyczna (4:5) albo wymiary w pikselach (1024:1280) - obie działają jako stosunek
          if (/^\d+:\d+$/.test(v.ratio)) {
            const d = dimsFor(v.ratio, v.resolution, caps.resolution.multiple);
            form.width = d.width;
            form.height = d.height;
          }
        } else if (v.resolution) {
          const d = dimsFor(`${form.width}:${form.height}`, v.resolution, caps.resolution.multiple);
          form.width = d.width;
          form.height = d.height;
        }
        if (v.loras) {
          const loras: Record<string, number> = {};
          for (const l of v.loras) {
            const info = s.loras.find((x) => x.id === l.id);
            if (info && s.form.modelId && info.compatible_model_ids.includes(s.form.modelId)) loras[l.id] = l.strength;
          }
          form.loras = loras;
        }
        form = fitToCaps(form, caps);
        const perModel = form.modelId ? { ...s.perModel, [form.modelId]: paramsOf(form) } : s.perModel;
        set({ form, perModel, ui: { ...s.ui, activePreset: p.id } });
        syncInputsToMode();
        get().toast("info", tr("toast.preset", { n: p.name }));
      },

      savePreset: async (name) => {
        const p: Preset = { id: uid("user"), name, builtin: false, model_id: get().form.modelId, values: get().currentPresetValues() };
        try {
          await api.putPreset(p);
          set({ presets: await api.presets(), ui: { ...get().ui, activePreset: p.id } });
          get().toast("success", tr("toast.presetSaved"));
        } catch (e) { get().toast("error", tr("err.save", { m: (e as Error).message })); }
      },

      updatePreset: async (p) => {
        try {
          await api.putPreset(p);
          set({ presets: await api.presets() });
        } catch (e) { get().toast("error", tr("err.save", { m: (e as Error).message })); }
      },

      removePreset: async (id) => {
        try {
          await api.deletePreset(id);
          set({ presets: await api.presets(), ui: { ...get().ui, activePreset: get().ui.activePreset === id ? "" : get().ui.activePreset } });
        } catch (e) { get().toast("error", (e as Error).message); }
      },

      // ------------------------------------------------------------ biblioteka promptów
      setPromptLib: (fn) => {
        const cur = get().promptLib ?? { snippets: [], packs: [] };
        const next = fn(cur);
        set({ promptLib: next });
        savePromptLib(next);
      },

      addFragments: (ids, extra = "") => {
        const s = get();
        const lib = s.promptLib;
        if (!lib) return;
        const unique = [...new Set(ids)].filter((id) => lib.snippets.some((x) => x.id === id) && !s.ui.applied.includes(id));
        const pieces = unique.map((id) => lib.snippets.find((x) => x.id === id)!.text);
        if (extra.trim() && !s.form.prompt.includes(extra.trim())) pieces.push(extra.trim());
        if (!pieces.length) { get().toast("info", tr("composer.already")); return; }
        const prompt = (s.form.prompt.trim() ? s.form.prompt.trimEnd() + ",\n" : "") + pieces.join(",\n");
        get().setForm({ prompt }, true);
        set({ ui: { ...get().ui, applied: [...s.ui.applied, ...unique] } });
        get().toast("success", tr("composer.added", { n: pieces.length }));
      },

      removeFragment: (id) => {
        const s = get();
        const sn = s.promptLib?.snippets.find((x) => x.id === id);
        let prompt = s.form.prompt;
        if (sn) {
          const idx = prompt.indexOf(sn.text);
          if (idx >= 0) {
            const head = prompt.slice(0, idx).replace(/,\s*$/, "");
            const tail = prompt.slice(idx + sn.text.length).replace(/^,?\s*/, "");
            prompt = [head, tail].filter(Boolean).join(",\n");
          }
        }
        get().setForm({ prompt }, true);
        set({ ui: { ...get().ui, applied: s.ui.applied.filter((x) => x !== id) } });
      },

      // ------------------------------------------------------------ generowanie
      submit: async (opts) => {
        const s = get();
        const model = selModel(s);
        const caps = model?.capabilities;
        const f = s.form;
        const err = (k: string) => get().toast("error", tr(k));
        if (!model || !caps || model.status !== "ready") return err("err.noModel");
        if (!f.prompt.trim()) return err("err.noPrompt");
        if (!s.online) return err("offline.title");
        const mode = f.mode;
        const src = selSource(s);
        const refs = s.attachments.filter((a) => a.role === "ref");
        if ((mode === "edit" || mode === "inpaint") && !src) return err("err.noSource");
        if (mode === "multi" && !src && !refs.length) return err("err.noRefs");
        if (mode === "inpaint" && src && !hasMask(src.paint)) return err("err.noMask");

        try {
          // Obraz z bazgrołami idzie do modelu w wersji z naniesionymi pociągnięciami (jako nowy upload).
          const refOf = async (a: Attachment): Promise<InputRef> => {
            if (!hasDoodle(a.paint)) return a.ref;
            const blob = await renderDoodled(a.url, a.paint);
            return { upload_id: (await api.upload(blob, "doodle.png")).upload_id };
          };
          let maskId: string | null = null;
          if (mode === "inpaint" && src) {
            const aspect = src.width && src.height ? src.width / src.height : f.width / f.height;
            const blob = await renderMaskPng(src.paint, aspect);
            maskId = (await api.upload(blob, "mask.png")).upload_id;
          }
          const req: GenerationRequest = {
            model_id: model.id,
            mode,
            prompt: f.prompt.trim(),
            width: f.width,
            height: f.height,
            steps: f.steps,
            seed: opts?.variant ? -1 : f.seed,
            batch: f.batch,
            loras: caps.lora
              ? Object.entries(f.loras).map(([id, strength]) => ({ id, name: s.loras.find((l) => l.id === id)?.name, strength }))
              : [],
            tag: opts?.variant ? "variant" : null,
          };
          if (caps.negative_prompt && f.negative.trim()) req.negative_prompt = f.negative.trim();
          if (caps.cfg) req.cfg = f.cfg;
          if (caps.sampler) req.sampler = f.sampler;
          if (caps.scheduler) req.scheduler = f.scheduler;
          if (caps.denoise && caps.denoise.modes.includes(mode)) req.denoise = f.denoise;
          if (mode !== "t2i" && src) req.source = await refOf(src);
          if (mode !== "t2i" && caps.max_refs > 0 && refs.length) req.references = await Promise.all(refs.slice(0, caps.max_refs).map(refOf));
          if (maskId) req.mask = maskId;
          const job = await api.createJob(req);
          set({ jobs: { ...get().jobs, [job.id]: job } });
        } catch (e) {
          get().toast("error", (e as Error).message);
        }
      },

      cancelJob: async (id) => {
        try { await api.cancelJob(id); } catch (e) { get().toast("error", (e as Error).message); }
      },

      applyRequest: (r, o) => {
        const s = get();
        const model = s.models.find((m) => m.id === r.model_id);
        if (!model || model.status !== "ready" || !model.capabilities) {
          get().toast("error", tr("err.modelMissing", { m: r.model_id }));
        } else if (s.form.modelId !== r.model_id) {
          get().selectModel(r.model_id);
        }
        const caps = (s.models.find((m) => m.id === r.model_id) ?? selModel(s))?.capabilities ?? null;
        const loras: Record<string, number> = {};
        const missing: string[] = [];
        for (const l of r.loras ?? []) {
          if (s.loras.some((x) => x.id === l.id)) loras[l.id] = l.strength;
          else missing.push(l.name ?? l.id);
        }
        if (missing.length) get().toast("info", tr("toast.loraMissing", { n: missing.join(", ") }));
        let form: Form = {
          ...get().form,
          mode: r.mode,
          prompt: r.prompt,
          negative: r.negative_prompt ?? "",
          width: r.width,
          height: r.height,
          steps: r.steps,
          cfg: r.cfg ?? get().form.cfg,
          denoise: r.denoise ?? get().form.denoise,
          sampler: r.sampler ?? get().form.sampler,
          scheduler: r.scheduler ?? get().form.scheduler,
          seed: o?.newSeed ? -1 : r.seed,
          batch: r.batch ?? 1,
          loras,
        };
        if (caps) form = fitToCaps({ ...form, mode: r.mode }, caps);
        set({
          form, page: "studio", compare: false,
          perModel: form.modelId ? { ...get().perModel, [form.modelId]: paramsOf(form) } : get().perModel,
          ui: { ...get().ui, activePreset: "" },
          attachments: [
            ...(r.source ? [attach(inputFromRef(r.source, "source"), "edit")] : []),
            ...(r.references ?? []).map((x, i) => attach(inputFromRef(x, `ref ${i + 1}`), "ref" as AttachRole)),
          ],
          paintId: null,
        });
      },

      // ------------------------------------------------------------ obrazy
      select: (id) => set({ selectedId: id }),
      openDetails: (id) => set({ selectedId: id, page: "details", paintId: null }),
      putImage: (r) => set({ cache: { ...get().cache, [r.id]: r } }),

      getImage: async (id) => {
        const c = get().cache[id];
        if (c) return c;
        try {
          const r = await api.image(id);
          get().putImage(r);
          return r;
        } catch { return null; }
      },

      patchImage: async (id, p) => {
        const old = get().cache[id];
        if (old) get().putImage({ ...old, ...p });
        set({ recent: get().recent.map((r) => (r.id === id ? { ...r, ...p } : r)) });
        try {
          const r = await api.patchImage(id, p);
          get().putImage(r);
          set({ libraryVersion: get().libraryVersion + 1 });
          void get().refreshRecent();
        } catch (e) {
          if (old) get().putImage(old);
          get().toast("error", (e as Error).message);
        }
      },

      deleteImage: async (id) => {
        try {
          await api.deleteImage(id);
          const cache = { ...get().cache };
          delete cache[id];
          const recent = get().recent.filter((r) => r.id !== id);
          set({ cache, recent, selectedId: get().selectedId === id ? recent[0]?.id ?? null : get().selectedId, libraryVersion: get().libraryVersion + 1 });
          get().toast("success", tr("toast.deleted"));
        } catch (e) { get().toast("error", (e as Error).message); }
      },

      addFiles: async (files, target) => {
        const imgs = files.filter((f) => f.type.startsWith("image/"));
        if (!imgs.length) return get().toast("error", tr("err.notImage"));
        try {
          if (target === "library") {
            const r = await api.importImages(imgs);
            r.forEach((x) => get().putImage(x));
            set({ libraryVersion: get().libraryVersion + 1 });
            void get().refreshRecent();
            get().toast("success", tr("toast.imported", { n: r.length }));
            return;
          }
          for (const f of imgs.slice(0, 12)) {
            const u = await api.upload(f, f.name);
            addAttachment({ ref: { upload_id: u.upload_id }, url: api.uploadUrl(u.upload_id), name: f.name, width: u.width, height: u.height });
          }
        } catch (e) { get().toast("error", (e as Error).message); }
      },

      useAsSource: (r) => {
        const caps = selCaps(get());
        const img: InputImage = { ref: { image_id: r.id }, url: api.imageUrl(r.id), name: r.prompt.slice(0, 40), width: r.width, height: r.height };
        // poprzedni obraz do edycji zostaje na liście jako nieaktywny
        const rest = get().attachments.map((a) => (a.role === "edit" ? { ...a, role: "off" as AttachRole } : a));
        set({ attachments: [attach(img, "edit"), ...rest], page: "studio", selectedId: r.id });
        syncMode();
        // proporcje wynikowe jak w źródle
        if (caps) {
          const long = Math.max(get().form.width, get().form.height);
          const d = dimsFor(`${r.width}:${r.height}`, long, caps.resolution.multiple);
          get().setForm({ width: d.width, height: d.height }, true);
        }
      },

      addAsRef: (r) => {
        const caps = selCaps(get());
        const max = caps?.max_refs ?? 0;
        if (get().attachments.filter((a) => a.role === "ref").length >= max) return get().toast("error", tr("err.maxRefs", { n: max }));
        set({ attachments: [...get().attachments, attach({ ref: { image_id: r.id }, url: api.imageUrl(r.id), name: r.prompt.slice(0, 40), width: r.width, height: r.height }, "ref")] });
        syncMode();
        get().toast("success", tr("toast.refAdded"));
      },

      setRole: (id, role) => {
        const s = get();
        const caps = selCaps(s);
        const target = s.attachments.find((a) => a.id === id);
        if (!target || target.role === role) return;
        if (role === "edit" && !caps?.modes.includes("edit")) return get().toast("error", tr("mode.unavailable"));
        if (role === "ref") {
          const max = caps?.max_refs ?? 0;
          if (max === 0) return get().toast("error", tr("attach.noRefs"));
          if (s.attachments.filter((a) => a.role === "ref").length >= max) return get().toast("error", tr("err.maxRefs", { n: max }));
        }
        set({
          attachments: s.attachments.map((a) =>
            a.id === id ? { ...a, role } : role === "edit" && a.role === "edit" ? { ...a, role: "off" as AttachRole } : a),
        });
        syncMode();
      },

      removeAttachment: (id) => {
        set({ attachments: get().attachments.filter((a) => a.id !== id), paintId: get().paintId === id ? null : get().paintId });
        syncMode();
      },

      // ------------------------------------------------------------ malowanie (maska i bazgroły)
      paintOpen: (id) => set({ paintId: id, compare: false }),
      paintCommit: (id, st) => {
        set({ attachments: get().attachments.map((a) => (a.id === id ? { ...a, paint: { ...a.paint, strokes: [...a.paint.strokes, st], redo: [] } } : a)) });
        if (st.layer === "mask") syncMode();
      },
      paintUndo: () => {
        const id = get().paintId;
        set({ attachments: get().attachments.map((a) => {
          if (a.id !== id || !a.paint.strokes.length) return a;
          const p = a.paint;
          return { ...a, paint: { ...p, strokes: p.strokes.slice(0, -1), redo: [...p.redo, p.strokes[p.strokes.length - 1]] } };
        }) });
        syncMode();
      },
      paintRedo: () => {
        const id = get().paintId;
        set({ attachments: get().attachments.map((a) => {
          if (a.id !== id || !a.paint.redo.length) return a;
          const p = a.paint;
          return { ...a, paint: { ...p, redo: p.redo.slice(0, -1), strokes: [...p.strokes, p.redo[p.redo.length - 1]] } };
        }) });
        syncMode();
      },
      paintClear: (layer) => {
        const id = get().paintId;
        set({ attachments: get().attachments.map((a) => (a.id === id
          ? { ...a, paint: { strokes: a.paint.strokes.filter((x) => x.layer !== layer), redo: [], inverted: layer === "mask" ? false : a.paint.inverted } }
          : a)) });
        syncMode();
      },
      paintInvert: () => {
        const id = get().paintId;
        set({ attachments: get().attachments.map((a) => (a.id === id ? { ...a, paint: { ...a.paint, inverted: !a.paint.inverted } } : a)) });
        syncMode();
      },

      openMenu: (x, y, items) => set({ menu: { x, y, items } }),
      closeMenu: () => { if (get().menu) set({ menu: null }); },

      // ------------------------------------------------------------ modele / ustawienia
      loadModel: async (id) => {
        set({ models: get().models.map((m) => (m.id === id ? { ...m, loading: true } : m)) });
        try {
          await api.loadModel(id);
        } catch (e) { get().toast("error", (e as Error).message); }
        try { set({ models: await api.models() }); } catch { /* ignoruj */ }
      },

      unloadModel: async () => {
        try { await api.unloadModel(); } catch (e) { get().toast("error", (e as Error).message); }
        try { set({ models: await api.models() }); } catch { /* ignoruj */ }
      },

      rescan: async () => {
        try {
          const r = await api.rescan();
          const [models, loras] = await Promise.all([api.models(), api.loras()]);
          set({ models, loras });
          ensureModel();
          get().toast("success", tr("toast.rescan", { m: r.models, l: r.loras }));
        } catch (e) { get().toast("error", (e as Error).message); }
      },

      saveSettings: async (s) => {
        try {
          const saved = await api.putSettings(s);
          set({ settings: saved });
          await get().rescan();
          void get().refreshRecent();
          set({ libraryVersion: get().libraryVersion + 1 });
        } catch (e) { get().toast("error", tr("err.save", { m: (e as Error).message })); }
      },

      toast: (kind, text) => {
        const id = uid("t");
        set({ toasts: [...get().toasts.slice(-3), { id, kind, text }] });
        window.setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 3600);
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
    }),
    {
      name: "is.prefs.v2",
      version: 1,
      partialize: (s) => ({ form: s.form, perModel: s.perModel, ui: s.ui }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<State, "form" | "perModel" | "ui">>;
        return { ...current, form: { ...defaultForm, ...p.form }, perModel: p.perModel ?? {}, ui: { ...defaultUi, ...p.ui } };
      },
    },
  ),
);

// ------------------------------------------------------------------ logika poza akcjami

/** Wybór modelu po załadowaniu listy: zapamiętany → domyślny z ustawień → załadowany → pierwszy gotowy. */
function ensureModel() {
  const s = useStore.getState();
  const ready = s.models.filter((m) => m.status === "ready" && m.capabilities);
  if (!ready.length) return;
  const cur = ready.find((m) => m.id === s.form.modelId);
  if (cur) {
    // odśwież ograniczenia (np. po zmianie wersji backendu)
    const form = fitToCaps(s.form, cur.capabilities!);
    if (JSON.stringify(form) !== JSON.stringify(s.form)) useStore.setState({ form });
    return;
  }
  const pick =
    ready.find((m) => m.id === s.settings?.default_model_id) ??
    ready.find((m) => m.loaded) ??
    ready.find((m) => m.family === "flux2-klein") ??
    ready[0];
  s.selectModel(pick.id);
}

/** Dodaje załącznik z automatyczną rolą i dopasowuje tryb (jak dodanie obrazu w czacie: od razu wiadomo, co z nim będzie). */
function addAttachment(img: InputImage) {
  const s = useStore.getState();
  const caps = selCaps(s);
  const hasEdit = s.attachments.some((a) => a.role === "edit");
  const refCount = s.attachments.filter((a) => a.role === "ref").length;
  const canEdit = !!caps?.modes.includes("edit");
  const canRef = (caps?.max_refs ?? 0) > refCount;
  // w trybie „Referencje" pierwszy obraz jest inspiracją, w pozostałych - obrazem do edycji
  const preferRef = s.form.mode === "multi";
  let role: AttachRole = "off";
  if (preferRef && canRef) role = "ref";
  else if (!hasEdit && canEdit) role = "edit";
  else if (canRef) role = "ref";
  useStore.setState({ attachments: [...s.attachments, attach(img, role)] });
  if (role === "off") s.toast("info", tr("attach.noRoom"));
  syncMode();
}

/** Tryb wynika z tego, co jest na liście: bez aktywnych obrazów - generowanie z tekstu, obraz + maska - inpainting itd. */
export function syncMode() {
  const s = useStore.getState();
  const caps = selCaps(s);
  if (!caps) return;
  const src = selSource(s);
  const refs = s.attachments.filter((a) => a.role === "ref").length;
  const can = (m: Mode) => caps.modes.includes(m);
  let want: Mode | null = null;
  if (!src && !refs) want = s.form.mode === "t2i" ? null : "t2i";
  else if (src && hasMask(src.paint) && can("inpaint")) want = "inpaint";
  else if (src && s.form.mode === "inpaint" && can("inpaint")) want = null;           // ręcznie wybrany inpainting zostaje
  else if (src && refs && can("multi")) want = "multi";
  else if (src && can("edit")) want = "edit";
  else if (refs && can("multi")) want = "multi";
  if (want && want !== s.form.mode && can(want)) s.setForm({ mode: want }, true);
}

/** Po zmianie trybu/modelu: tryb edycji bez obrazu bierze zaznaczony obraz ze sceny. */
function syncInputsToMode() {
  const s = useStore.getState();
  const mode = s.form.mode;
  if ((mode === "edit" || mode === "inpaint") && !selSource(s)) {
    const sel = s.selectedId ? s.cache[s.selectedId] : null;
    if (sel) useStore.setState({
      attachments: [attach({ ref: { image_id: sel.id }, url: api.imageUrl(sel.id), name: sel.prompt.slice(0, 40), width: sel.width, height: sel.height }, "edit"), ...s.attachments],
    });
  }
}

function onJob(job: Job) {
  const st = useStore.getState();
  const prev = st.jobs[job.id];
  const jobs = { ...st.jobs, [job.id]: job };
  // utrzymuj tylko ostatnie 40 zakończonych
  const finished = Object.values(jobs).filter((j) => j.status !== "queued" && j.status !== "running").sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
  finished.slice(40).forEach((j) => delete jobs[j.id]);
  useStore.setState({ jobs });

  const known = prev?.result_image_ids.length ?? 0;
  if (job.result_image_ids.length > known) {
    const newIds = job.result_image_ids.slice(known);
    void Promise.all(newIds.map((id) => api.image(id).catch(() => null))).then((recs) => {
      const ok = recs.filter((r): r is ImageRecord => !!r);
      if (!ok.length) return;
      const s = useStore.getState();
      const cache = { ...s.cache };
      ok.forEach((r) => { cache[r.id] = r; });
      const recent = [...ok.reverse(), ...s.recent.filter((r) => !ok.some((o) => o.id === r.id))].slice(0, 30);
      useStore.setState({ cache, recent, selectedId: ok[0].id, libraryVersion: s.libraryVersion + 1 });
    });
  }
  // na scenie błąd pokazuje panel; poza sceną - toast
  if (job.status === "error" && prev?.status !== "error" && st.page !== "studio") useStore.getState().toast("error", job.error || tr("err.job"));
  if (job.status === "cancelled" && prev && prev.status !== "cancelled") useStore.getState().toast("info", tr("toast.cancelled"));
}
