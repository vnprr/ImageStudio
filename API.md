# Image Studio — kontrakt API (UI ↔ FastAPI)

Backend: `http://127.0.0.1:8765`, wszystko pod `/api`. JSON, UTF-8. Czasy w sekundach (float), daty jako
epoch-ms (int). Obrazy i miniatury serwowane jako pliki. Produkcyjnie backend serwuje też `frontend/dist` pod `/`.
Dev: Vite proxy `/api` → `127.0.0.1:8765`.

Błędy: HTTP 4xx/5xx z ciałem `{"detail": "czytelny komunikat po polsku"}`.

## Typy

```ts
type Mode = "t2i" | "edit" | "multi" | "inpaint";

interface Capabilities {
  modes: Mode[];
  steps: { min: number; max: number; default: number };
  cfg: { min: number; max: number; step: number; default: number } | null;      // null => nie pokazuj
  negative_prompt: boolean;
  denoise: { min: number; max: number; step: number; default: number; modes: Mode[] } | null; // suwak tylko w tych trybach
  sampler: string[] | null;       // null => nie pokazuj (Klein i Z-Image: stały FlowMatchEuler)
  scheduler: string[] | null;
  max_batch: number;
  max_refs: number;               // max obrazów referencyjnych (tryb multi)
  resolution: { min: number; max: number; multiple: number; presets: number[]; default: number }; // presets = dłuższy bok
  lora: boolean;
}

interface ModelInfo {
  id: string;                     // stabilny, np. "flux2-klein-4b" albo "ckpt:<hash>"
  name: string;
  family: "flux2-klein" | "z-image" | "qwen-image" | "qwen-image-21" | "unknown";   // qwen-image-21: folder GGUF (model/, text_encoder/, mmproj/, vae/)
  kind: "base" | "checkpoint";    // checkpoint = alternatywny pełny fine-tune tej samej rodziny
  path: string;
  size_bytes: number;
  status: "ready" | "unsupported";
  unsupported_reason: string | null;   // po polsku, np. dlaczego wykryty model nie działa w Diffusers
  loaded: boolean;
  loading: boolean;
  capabilities: Capabilities | null;   // null gdy unsupported
  license: string | null;
  notes: string | null;           // np. "Destylowany: 4 kroki, CFG nieaktywne"
}

interface LoraInfo {
  id: string;                     // "lora:<hash>"
  name: string;                   // z nazwy pliku
  path: string;
  size_bytes: number;
  family: ModelInfo["family"];    // wykryta architektura
  compatible_model_ids: string[]; // modele które można z nią użyć
  status: "ready" | "incompatible" | "unknown";
  reason: string | null;
  default_strength: number;       // 1.0
}

interface SystemStats {
  gpu: { name: string; arch: string | null; backend: "rocm" | "cuda" | "cpu"; available: boolean;
         vram_total: number; vram_used: number; vram_free: number };   // bajty; used = zajęte przez cały system
  process: { vram_allocated: number; vram_reserved: number; ram_rss: number };
  ram: { total: number; used: number };
  disk: { models_free: number; library_free: number };
  versions: { torch: string; hip: string | null; diffusers: string; python: string };
  active_model_id: string | null;
  queue: { running: number; queued: number };
}

interface Timings {
  load: number;         // ładowanie modelu/LoRA (0 gdy model już w pamięci)
  encode: number;       // text encoding
  denoise: number;
  vae: number;
  save: number;
  total: number;
  cold: boolean;        // true gdy model musiał być ładowany w tym zadaniu
  peak_vram: number;    // bajty (max allocated PyTorch w trakcie zadania)
  peak_ram: number;     // bajty (RSS procesu, max)
}

interface LoraUse { id: string; name?: string; strength: number }

interface GenerationRequest {
  model_id: string;
  mode: Mode;
  prompt: string;
  negative_prompt?: string;
  width: number; height: number;      // wielokrotności resolution.multiple
  steps: number;
  cfg?: number | null;
  seed: number;                       // -1 => losowy (backend zwraca faktyczny w rekordzie obrazu)
  batch: number;                      // kolejne seedy: seed, seed+1, ...
  sampler?: string | null;
  scheduler?: string | null;
  denoise?: number | null;
  loras: LoraUse[];                   // tylko włączone
  source?: InputRef | null;           // edit / inpaint
  references?: InputRef[];            // multi (a w inpaint opcjonalnie)
  mask?: string | null;               // upload_id PNG; biały = zmieniaj, czarny = zachowaj
  tag?: string | null;                // dowolna etykieta UI (np. "variant")
}
type InputRef = { upload_id: string } | { image_id: string };   // upload z /api/uploads albo obraz z biblioteki

type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";
type Stage = "queued" | "loading" | "encoding" | "denoising" | "decoding" | "saving" | "done";

interface Job {
  id: string;
  status: JobStatus;
  request: GenerationRequest;
  stage: Stage;
  step: number; total_steps: number;      // krok dla bieżącego obrazu z batcha
  image_index: number; image_count: number;
  fraction: number;                       // 0..1 łączny postęp zadania
  message: string | null;                 // np. "Ładowanie modelu FLUX.2 Klein 4B…"
  queue_position: number | null;
  result_image_ids: string[];             // uzupełniane na bieżąco
  timings: Timings | null;
  error: string | null;
  created_at: number; started_at: number | null; finished_at: number | null;
}

interface ImageRecord {
  id: string;
  created_at: number;
  width: number; height: number;
  format: "png";                          // plik w katalogu biblioteki jest zawsze PNG
  prompt: string; negative_prompt: string;
  model_id: string; model_name: string;
  mode: Mode;
  loras: LoraUse[];                       // z nazwami
  seed: number; steps: number; cfg: number | null;
  sampler: string | null; scheduler: string | null; denoise: number | null;
  gen_seconds: number | null;
  timings: Timings | null;
  sources: { role: "source" | "reference" | "mask"; image_id: string | null; name: string | null }[];
  request: GenerationRequest;             // dokładne parametry do "Użyj ustawień" (seed = faktyczny)
  favorite: boolean; hidden: boolean;
  imported: boolean;                      // zaimportowany (nie wygenerowany)
  url: string;                            // /api/images/{id}/file
  thumb_url: string;                      // /api/images/{id}/thumb
}

interface Preset { id: string; name: string; builtin: boolean; model_id: string | null; values: Partial<Pick<GenerationRequest,
  "steps"|"cfg"|"sampler"|"scheduler"|"denoise"|"batch"|"mode">> & { ratio?: string; resolution?: number; loras?: LoraUse[] } }

interface DownloadState {
  id: string; repo_id: string; status: "queued"|"running"|"done"|"error"|"cancelled";
  bytes_done: number; bytes_total: number; speed: number; eta: number | null;
  current_file: string | null; error: string | null; target_dir: string;
}
interface RepoInspect {
  repo_id: string; name: string; license: string | null; gated: boolean; requires_token: boolean;
  size_bytes: number; free_bytes: number; enough_space: boolean; files: number;
  family: ModelInfo["family"]; supported: boolean; note: string | null;
}
interface Settings {
  model_dirs: string[];     // dodatkowe foldery z modelami (np. ComfyUI/models/diffusion_models)
  lora_dirs: string[];      // foldery LoRA (np. ComfyUI/models/loras)
  library_dir: string;
  default_model_id: string | null;
  precision: "auto" | "bf16" | "fp16";   // auto = fp16 (szybkie na RDNA2) + automatyczny tryb bezpieczny (fp32-compute) dla modeli, które przepełniają fp16; bf16 = wymuszone, ~5× wolniejsze na RX 6000
  offload: "auto" | "gpu" | "model" ;   // auto: sam wybiera; gpu: wszystko na GPU; model: model_cpu_offload
  unload_mode: "manual" | "after_job" | "idle";   // manual: tylko przycisk Zwolnij lub zmiana modelu; after_job: po każdym zadaniu; idle: po unload_idle_minutes bez zadań
  unload_idle_minutes: number;                    // 1–1440, używane w trybie idle
  hf_token: string | null;  // opcjonalny, tylko do gated repo
  embed_metadata_png: boolean;   // zapisuj metadane w plikach PNG biblioteki
}
```

## Endpointy

### System
- `GET /api/system` → `SystemStats`
- `GET /api/events` — **SSE** (`text/event-stream`). Każda wiadomość: `event: <typ>` + `data: <json>`.
  Typy: `system` (SystemStats, co ~2 s), `job` (Job — przy każdej zmianie, throttling ≤10/s), `download` (DownloadState),
  `models` (`{}` — lista modeli/LoRA się zmieniła → pobierz ponownie), `library` (`{}` — zmiana w bibliotece).
  Po połączeniu serwer wysyła aktualny `system` i wszystkie nieukończone `job`.
- `GET /api/settings` / `PUT /api/settings` (pełny obiekt) → `Settings`
- `GET /api/fs/list?path=` → `{path, parent, entries:[{name, path, is_dir}]}` (tylko katalogi; pusty `path` = dyski/katalog domowy) — do wskazywania folderów.

### Modele i LoRA
- `GET /api/models` → `ModelInfo[]` ; `GET /api/loras` → `LoraInfo[]`
- `POST /api/rescan` → `{models: n, loras: n}` (ponowne skanowanie folderów)
- `POST /api/models/{id}/load` → `ModelInfo` (blokuje do końca ładowania; UI zwykle polega na zdarzeniach)
- `POST /api/models/unload` → `{}` (zwalnia VRAM/RAM)
- `GET /api/catalog` → `{repo_id, name, description, size_bytes, license, family, installed}[]` (polecane: FLUX.2 klein 4B, Z-Image Turbo)
- `GET /api/hf/inspect?repo=owner/name` → `RepoInspect` (rozmiar, licencja, wolne miejsce)
- `POST /api/downloads` `{repo_id}` → `DownloadState` ; `GET /api/downloads` → `DownloadState[]` ; `DELETE /api/downloads/{id}` (anuluj)

### Generowanie
- `POST /api/uploads` (multipart `file`) → `{upload_id, width, height, url}` — obraz źródłowy, referencja lub maska. `GET /api/uploads/{id}` zwraca plik.
- `POST /api/jobs` `GenerationRequest` → `Job` (trafia do kolejki)
- `GET /api/jobs` → `Job[]` (aktywne + 50 ostatnich) ; `GET /api/jobs/{id}`
- `DELETE /api/jobs/{id}` — anuluje (queued → usuwa, running → przerywa po bieżącym kroku)

### Biblioteka
- `GET /api/images?query=&filter=all|favorite|hidden&sort=new|old&model_id=&limit=60&offset=0` → `{total, items: ImageRecord[]}`
  (`all` = bez ukrytych; wyszukiwanie po prompcie, nazwie modelu, LoRA, seedzie)
- `GET /api/images/{id}` → `ImageRecord`
- `GET /api/images/{id}/file` (PNG) ; `GET /api/images/{id}/thumb` (WebP ~384 px)
- `PATCH /api/images/{id}` `{favorite?, hidden?}` → `ImageRecord` (ukrywanie NIE usuwa pliku)
- `DELETE /api/images/{id}` — trwale usuwa wpis i plik (UI zawsze pyta o potwierdzenie)
- `GET /api/images/{id}/download?format=png|jpeg|webp&quality=92&metadata=1` → bajty z `Content-Disposition` (natywny zapis przeglądarki)
- `POST /api/images/{id}/export` `{format, quality?, dest_dir, filename?, metadata?}` → `{path}` (zapis do dowolnego folderu na dysku)
- `POST /api/images/import` (multipart `files[]`) → `ImageRecord[]`
- `GET /api/library/stats` → `{count, hidden, favorite, bytes, dir}`

### Presety i biblioteka promptów
- `GET /api/presets` → `Preset[]` (wbudowane: Szybki, Fotorealizm, Ilustracja, Jakość, Edycja + własne) ; `PUT /api/presets/{id}` (`Preset`, tworzy lub zmienia własny) ; `DELETE /api/presets/{id}`
- `GET /api/prompt-library` → `{snippets: Snippet[], packs: Pack[]}` ; `PUT /api/prompt-library` (cały dokument; backend zapisuje trwale)
  - `Snippet {id, cat, title, text}` ; `Pack {id, cat, name, desc, ids: string[], extra: string}` (jak w mockupie; pierwsze wywołanie zwraca zestaw startowy z mockupu).

## Zasady zachowania
- Jedno zadanie GPU naraz, kolejka FIFO. Model aktywny zostaje w pamięci między zadaniami; zmiana modelu = zwolnij poprzedni, załaduj nowy.
- Zmiana LoRA nie przeładowuje pipeline'u (adaptery cache'owane i przełączane).
- Każdy ukończony obraz od razu ląduje w bibliotece (SQLite + PNG + miniatura) i jest zgłaszany w `job.result_image_ids` oraz zdarzeniem `library`.
- Parametry nieobsługiwane przez model backend ignoruje, a UI ich nie pokazuje (`capabilities`).

## Zmiany UI→backend
- `Preset.values.ratio` bywa zapisane przez UI jako `"<szer>:<wys>"` w pikselach (np. `"816:1024"`) razem z `resolution` = dłuższy bok;
  UI traktuje je jako stosunek, więc backend może przechowywać to pole jako zwykły string.
- UI nie wysyła pól nieobsługiwanych przez `capabilities` modelu (`cfg`, `sampler`, `scheduler`, `denoise`, `negative_prompt` są pomijane).
- `GET /api/catalog`: `size_bytes` jest teraz `0` — UI w takim wypadku ukrywa rozmiar (dokładny rozmiar pokazuje `GET /api/hf/inspect`).
- Maska wysyłana jako PNG (biały = zmieniaj) o dłuższym boku 1024 px i proporcjach źródła; backend ma ją przeskalować do `width×height`.

## Zdalny dostęp

- `GET /api/ping` → `{ok, app: "image-studio", remote, media?}`; zdalnie zwraca też pochodny token mediów (do `<img>` i SSE).
- `GET /api/remote` → stan: `enabled`, `token`, `public_url`, `web_ui_url`, `tunnel{state,url,error,installed}`, `effective_url`. **Tylko lokalnie.**
- `POST /api/remote/enable` `{enabled}`: jeden przycisk (instalacja tunelu z weryfikacją, start, rejestracja adresu). Stan: `install{state,progress}`, `tunnel`, `registry{state}`, `link`, `link_stable`.
- `PUT /api/remote` `{enabled?, public_url?, web_ui_url?, rv_bypass?, tunnel?}`, `POST /api/remote/rotate`, `POST /api/remote/tunnel` `{action}`. **Tylko lokalnie.**
- `GET/POST /api/rv` (funkcja na hostingu UI, nie w backendzie): rejestr bieżącego adresu silnika pod stałym identyfikatorem.
- `GET /api/images/{id}/preview` → podgląd WebP (do 1600 px) do przeglądania przez sieć.
- Klient zdalny wysyła `Authorization: Bearer <token>`; media i `/api/events` przyjmują `?token=<token mediów>`. Dozwolone endpointy zdalne
  są wymienione w `backend/remote.py` (`_ALLOWED`); reszta zwraca 403. `/api/settings`, `/api/models` i `/api/loras` nie zawierają ścieżek.
