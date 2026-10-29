// Jedyny adapter do backendu FastAPI. Wszystkie dane UI przechodzą przez ten plik.
import { getConn } from "./connection";
import type {
  CatalogEntry, DownloadState, FsListing, GenerationRequest, ImageFilter, ImageRecord, ImageSort,
  Job, LibraryStats, LoraInfo, ModelInfo, Preset, PromptLibrary, RemoteStatus, RepoInspect, SaveFormat, Settings, SystemStats,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Adres zasobu (obraz, plik do pobrania): przy zdalnym silniku z adresem serwera i tokenem mediów (<img> nie wysyła nagłówków). */
export function media(path: string): string {
  const c = getConn();
  return c ? `${c.base}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(c.media)}` : path;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const c = getConn();
  const headers = new Headers(init?.headers);
  if (c) headers.set("Authorization", `Bearer ${c.token}`);
  try {
    res = await fetch((c?.base ?? "") + "/api" + path, { ...init, headers });
  } catch {
    throw new ApiError("Brak połączenia z backendem", 0);
  }
  if (res.status === 401) window.dispatchEvent(new Event("is:unauthorized"));
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch { /* ciało nie jest JSON-em */ }
    throw new ApiError(detail || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
};

export interface UploadResult { upload_id: string; width: number; height: number; url: string }
export interface ExportBody { format: SaveFormat; quality?: number; dest_dir: string; filename?: string; metadata?: boolean }

export const api = {
  system: () => call<SystemStats>("/system"),
  remoteStatus: () => call<RemoteStatus>("/remote"),
  remoteUpdate: (b: Partial<{ enabled: boolean; public_url: string; web_ui_url: string; rv_bypass: string; tunnel: "off" | "auto" }>) => call<RemoteStatus>("/remote", json("PUT", b)),
  remoteEnable: (enabled: boolean) => call<RemoteStatus>("/remote/enable", json("POST", { enabled })),
  remoteRotate: () => call<RemoteStatus>("/remote/rotate", { method: "POST" }),
  remoteTunnel: (action: "start" | "stop") => call<RemoteStatus>("/remote/tunnel", json("POST", { action })),
  settings: () => call<Settings>("/settings"),
  putSettings: (s: Settings) => call<Settings>("/settings", json("PUT", s)),
  fsList: (path: string) => call<FsListing>("/fs/list" + qs({ path })),

  models: () => call<ModelInfo[]>("/models"),
  loras: () => call<LoraInfo[]>("/loras"),
  rescan: () => call<{ models: number; loras: number }>("/rescan", { method: "POST" }),
  loadModel: (id: string) => call<ModelInfo>(`/models/${encodeURIComponent(id)}/load`, { method: "POST" }),
  unloadModel: () => call<Record<string, never>>("/models/unload", { method: "POST" }),
  catalog: () => call<CatalogEntry[]>("/catalog"),
  inspect: (repo: string) => call<RepoInspect>("/hf/inspect" + qs({ repo })),
  startDownload: (repo_id: string) => call<DownloadState>("/downloads", json("POST", { repo_id })),
  downloads: () => call<DownloadState[]>("/downloads"),
  cancelDownload: (id: string) => call<void>(`/downloads/${id}`, { method: "DELETE" }),

  upload: async (file: Blob, name = "image.png") => {
    const fd = new FormData();
    fd.append("file", file, name);
    return call<UploadResult>("/uploads", { method: "POST", body: fd });
  },
  createJob: (r: GenerationRequest) => call<Job>("/jobs", json("POST", r)),
  jobs: () => call<Job[]>("/jobs"),
  cancelJob: (id: string) => call<void>(`/jobs/${id}`, { method: "DELETE" }),

  images: (p: { query?: string; filter?: ImageFilter; sort?: ImageSort; model_id?: string; limit?: number; offset?: number }) =>
    call<{ total: number; items: ImageRecord[] }>("/images" + qs(p)),
  image: (id: string) => call<ImageRecord>(`/images/${id}`),
  patchImage: (id: string, patch: { favorite?: boolean; hidden?: boolean }) =>
    call<ImageRecord>(`/images/${id}`, json("PATCH", patch)),
  deleteImage: (id: string) => call<void>(`/images/${id}`, { method: "DELETE" }),
  importImages: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    return call<ImageRecord[]>("/images/import", { method: "POST", body: fd });
  },
  exportImage: (id: string, body: ExportBody) => call<{ path: string }>(`/images/${id}/export`, json("POST", body)),
  libraryDays: (p: { query?: string; filter?: ImageFilter; sort?: ImageSort; model_id?: string }) =>
    call<{ day: string; count: number }[]>("/library/days" + qs(p)),
  libraryStats: () => call<LibraryStats>("/library/stats"),

  presets: () => call<Preset[]>("/presets"),
  putPreset: (p: Preset) => call<Preset>(`/presets/${encodeURIComponent(p.id)}`, json("PUT", p)),
  deletePreset: (id: string) => call<void>(`/presets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  promptLibrary: () => call<PromptLibrary>("/prompt-library"),
  putPromptLibrary: (d: PromptLibrary) => call<PromptLibrary>("/prompt-library", json("PUT", d)),

  imageUrl: (id: string) => media(`/api/images/${id}/file`),
  thumbUrl: (id: string) => media(`/api/images/${id}/thumb`),
  /** do wyświetlania na scenie: przez sieć lekki podgląd WebP zamiast oryginalnego PNG */
  stageUrl: (id: string) => media(getConn() ? `/api/images/${id}/preview` : `/api/images/${id}/file`),
  uploadUrl: (id: string) => media(`/api/uploads/${id}`),
  downloadUrl: (id: string, format: SaveFormat, quality: number, metadata: boolean) =>
    media(`/api/images/${id}/download` + qs({ format, quality, metadata: metadata ? 1 : 0 })),
};

// ---------------------------------------------------------------- SSE

export type EventType = "system" | "job" | "download" | "models" | "library";

/** Połączenie SSE z automatycznym ponawianiem. Zwraca funkcję zamykającą. */
export function connectEvents(
  onEvent: (type: EventType, data: unknown) => void,
  onStatus: (online: boolean) => void,
): () => void {
  let es: EventSource | null = null;
  let timer: number | undefined;
  let delay = 1000;
  let stopped = false;
  const types: EventType[] = ["system", "job", "download", "models", "library"];

  const open = () => {
    if (stopped) return;
    es = new EventSource(media("/api/events"));
    es.onopen = () => { delay = 1000; onStatus(true); };
    for (const t of types) {
      es.addEventListener(t, (e) => {
        try { onEvent(t, JSON.parse((e as MessageEvent).data)); } catch { /* uszkodzony pakiet */ }
      });
    }
    es.onerror = () => {
      es?.close();
      es = null;
      onStatus(false);
      if (!stopped) {
        timer = window.setTimeout(open, delay);
        delay = Math.min(delay * 1.7, 6000);
      }
    };
  };
  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    es?.close();
  };
}
