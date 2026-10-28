// Typy zgodne z API.md (źródło prawdy: kontrakt backendu).

export type Mode = "t2i" | "edit" | "multi" | "inpaint";
export type Family = "flux2-klein" | "z-image" | "qwen-image" | "qwen-image-21" | "unknown";

export interface Capabilities {
  modes: Mode[];
  steps: { min: number; max: number; default: number };
  cfg: { min: number; max: number; step: number; default: number } | null;
  negative_prompt: boolean;
  denoise: { min: number; max: number; step: number; default: number; modes: Mode[] } | null;
  sampler: string[] | null;
  scheduler: string[] | null;
  max_batch: number;
  max_refs: number;
  resolution: { min: number; max: number; multiple: number; presets: number[]; default: number };
  lora: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  family: Family;
  kind: "base" | "checkpoint";
  path: string;
  size_bytes: number;
  status: "ready" | "unsupported";
  unsupported_reason: string | null;
  loaded: boolean;
  loading: boolean;
  capabilities: Capabilities | null;
  license: string | null;
  notes: string | null;
}

export interface LoraInfo {
  id: string;
  name: string;
  path: string;
  size_bytes: number;
  family: Family;
  compatible_model_ids: string[];
  status: "ready" | "incompatible" | "unknown";
  reason: string | null;
  default_strength: number;
}

export interface SystemStats {
  gpu: {
    name: string;
    arch: string | null;
    backend: "rocm" | "cuda" | "cpu";
    available: boolean;
    vram_total: number;
    vram_used: number;
    vram_free: number;
  };
  process: { vram_allocated: number; vram_reserved: number; ram_rss: number };
  ram: { total: number; used: number };
  disk: { models_free: number; library_free: number };
  versions: { torch: string; hip: string | null; diffusers: string; python: string };
  active_model_id: string | null;
  queue: { running: number; queued: number };
}

export interface Timings {
  load: number;
  encode: number;
  denoise: number;
  vae: number;
  save: number;
  total: number;
  cold: boolean;
  peak_vram: number;
  peak_ram: number;
}

export interface LoraUse {
  id: string;
  name?: string;
  strength: number;
}

export type InputRef = { upload_id: string } | { image_id: string };

export interface GenerationRequest {
  model_id: string;
  mode: Mode;
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  cfg?: number | null;
  seed: number;
  batch: number;
  sampler?: string | null;
  scheduler?: string | null;
  denoise?: number | null;
  loras: LoraUse[];
  source?: InputRef | null;
  references?: InputRef[];
  mask?: string | null;
  tag?: string | null;
}

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
export type Stage = "queued" | "loading" | "encoding" | "denoising" | "decoding" | "saving" | "done";

export interface Job {
  id: string;
  status: JobStatus;
  request: GenerationRequest;
  stage: Stage;
  step: number;
  total_steps: number;
  image_index: number;
  image_count: number;
  fraction: number;
  message: string | null;
  queue_position: number | null;
  result_image_ids: string[];
  timings: Timings | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface ImageSource {
  role: "source" | "reference" | "mask";
  image_id: string | null;
  name: string | null;
}

export interface ImageRecord {
  id: string;
  created_at: number;
  width: number;
  height: number;
  format: "png";
  prompt: string;
  negative_prompt: string;
  model_id: string;
  model_name: string;
  mode: Mode;
  loras: LoraUse[];
  seed: number;
  steps: number;
  cfg: number | null;
  sampler: string | null;
  scheduler: string | null;
  denoise: number | null;
  gen_seconds: number | null;
  timings: Timings | null;
  sources: ImageSource[];
  request: GenerationRequest;
  favorite: boolean;
  hidden: boolean;
  imported: boolean;
  url: string;
  thumb_url: string;
}

export interface PresetValues {
  steps?: number;
  cfg?: number | null;
  sampler?: string | null;
  scheduler?: string | null;
  denoise?: number | null;
  batch?: number;
  mode?: Mode;
  ratio?: string;
  resolution?: number;
  loras?: LoraUse[];
}

export interface Preset {
  id: string;
  name: string;
  builtin: boolean;
  model_id: string | null;
  values: PresetValues;
}

export interface DownloadState {
  id: string;
  repo_id: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  bytes_done: number;
  bytes_total: number;
  speed: number;
  eta: number | null;
  current_file: string | null;
  error: string | null;
  target_dir: string;
}

export interface RepoInspect {
  repo_id: string;
  name: string;
  license: string | null;
  gated: boolean;
  requires_token: boolean;
  size_bytes: number;
  free_bytes: number;
  enough_space: boolean;
  files: number;
  family: Family;
  supported: boolean;
  note: string | null;
}

export interface CatalogEntry {
  repo_id: string;
  name: string;
  description: string;
  size_bytes: number;
  license: string | null;
  family: Family;
  installed: boolean;
}

export interface Settings {
  model_dirs: string[];
  lora_dirs: string[];
  library_dir: string;
  default_model_id: string | null;
  precision: "auto" | "bf16" | "fp16";
  offload: "auto" | "gpu" | "model";
  unload_mode: "manual" | "after_job" | "idle";
  unload_idle_minutes: number;
  hf_token: string | null;
  embed_metadata_png: boolean;
}

export interface Snippet {
  id: string;
  cat: string;
  title: string;
  text: string;
}

export interface Pack {
  id: string;
  cat: string;
  name: string;
  desc: string;
  ids: string[];
  extra: string;
}

export interface PromptLibrary {
  snippets: Snippet[];
  packs: Pack[];
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export interface LibraryStats {
  count: number;
  hidden: number;
  favorite: number;
  bytes: number;
  dir: string;
}

export type ImageFilter = "all" | "favorite" | "hidden";
export type ImageSort = "new" | "old";
export type SaveFormat = "png" | "jpeg" | "webp";
