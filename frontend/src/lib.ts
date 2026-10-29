import type { Capabilities, Mode, SaveFormat } from "./types";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const uid = (p = "id") => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}

export function fmtSec(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 120) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtEta(s: number | null): string {
  if (s == null || !isFinite(s)) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Dzień „RRRR-MM-DD" z API → lokalna data (północ). */
export function parseDay(d: string): Date {
  const [y, m, da] = d.split("-").map(Number);
  return new Date(y, (m || 1) - 1, da || 1);
}

/** Nagłówek dnia: „Dzisiaj", „Wczoraj" albo „środa, 28 października 2026". */
export function fmtDayHead(day: string, lang: string, today: string, yesterday: string): string {
  const d = parseDay(day);
  const diff = Math.round((new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() - d.getTime()) / 86400000);
  if (diff === 0) return today;
  if (diff === 1) return yesterday;
  try { return d.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); } catch { return day; }
}

export function fmtMonth(day: string, lang: string): string {
  try { return parseDay(day).toLocaleDateString(lang, { month: "short", year: "numeric" }); } catch { return day.slice(0, 7); }
}

export function fmtDate(ms: number, lang: string, withTime = false): string {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  try { return d.toLocaleString(lang, opts); } catch { return d.toISOString(); }
}

// ------------------------------------------------------------ wymiary

/** Proporcje w układzie poziomym (dłuższy bok = szerokość). Pionowe powstają przez odwrócenie. */
export const RATIOS_LANDSCAPE = ["1:1", "5:4", "4:3", "3:2", "16:9"];
export const RATIOS = [...RATIOS_LANDSCAPE, "4:5", "3:4", "2:3", "9:16"];

const flip = (r: string) => r.split(":").reverse().join(":");

/** Lista proporcji dla wybranej orientacji: pionowo 4:5, 3:4, 2:3, 9:16; poziomo 5:4, 4:3, 3:2, 16:9 (nigdy obu naraz). */
export const ratiosFor = (portrait: boolean) => (portrait ? RATIOS_LANDSCAPE.map(flip) : RATIOS_LANDSCAPE);

export const isPortrait = (w: number, h: number) => h > w;

const snap = (v: number, m: number) => Math.max(m, Math.round(v / m) * m);

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Czytelny opis proporcji wymiarów: „3:2" albo dla niestandardowych „≈ 1.46:1". */
export function ratioText(w: number, h: number): string {
  const r = detectRatio(w, h);
  if (r !== "custom") return r;
  const g = gcd(w, h);
  const a = w / g, b = h / g;
  return a <= 32 && b <= 32 ? `${a}:${b}` : `≈ ${(w / h).toFixed(2)}:1`;
}

/** Wymiary dla proporcji i dłuższego boku, zaokrąglone do wielokrotności `multiple`. */
export function dimsFor(ratio: string, longSide: number, multiple: number): { width: number; height: number } {
  const [a, b] = ratio.split(":").map(Number);
  if (!a || !b) return { width: longSide, height: longSide };
  if (a >= b) return { width: snap(longSide, multiple), height: snap((longSide * b) / a, multiple) };
  return { width: snap((longSide * a) / b, multiple), height: snap(longSide, multiple) };
}

export function detectRatio(w: number, h: number): string {
  const r = w / h;
  let best = "custom";
  let err = 0.02;
  for (const s of RATIOS) {
    const [a, b] = s.split(":").map(Number);
    const e = Math.abs(a / b - r);
    if (e < err) { err = e; best = s; }
  }
  return best;
}

export function clampRes(caps: Capabilities, w: number, h: number) {
  const { min, max, multiple } = caps.resolution;
  return { width: clamp(snap(w, multiple), min, max), height: clamp(snap(h, multiple), min, max) };
}

// ------------------------------------------------------------ tryby

export const MODES: Mode[] = ["t2i", "edit", "multi", "inpaint"];

export function mimeFor(f: SaveFormat) { return f === "jpeg" ? "image/jpeg" : f === "webp" ? "image/webp" : "image/png"; }
export function extFor(f: SaveFormat) { return f === "jpeg" ? "jpg" : f; }

export function fileSafe(s: string, max = 48): string {
  const t = s.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return t || "image";
}

/** Złączenie ścieżki z użyciem separatora wykrytego w bazie (Windows/Unix). */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") || /^[A-Za-z]:/.test(base) ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

export function loadImageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => rej(new Error("image"));
    im.src = url;
  });
}

/** Okno aplikacji desktopowej (launcher otwiera `/?desktop=1`): tam wyłączamy menu przeglądarki i zaznaczanie tekstu. */
export function isDesktop(): boolean {
  try {
    if (new URLSearchParams(location.search).get("desktop") === "1") sessionStorage.setItem("is.desktop", "1");
    return sessionStorage.getItem("is.desktop") === "1";
  } catch { return false; }
}

// ------------------------------------------------------------ przeciąganie obrazów między miejscami w aplikacji

export const IMAGE_DRAG = "application/x-is-image";

/** Podpina identyfikator obrazu do przeciąganego elementu (miniatura w historii albo w galerii). */
export function startImageDrag(e: React.DragEvent, id: string): void {
  e.dataTransfer.setData(IMAGE_DRAG, id);
  e.dataTransfer.effectAllowed = "copy";
}

// ------------------------------------------------------------ motyw (auto / ciemny / jasny)

export type ThemePref = "auto" | "dark" | "light";
const THEME_KEY = "is.theme";

export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(THEME_KEY); return v === "dark" || v === "light" ? v : "auto"; } catch { return "auto"; }
}

/** Ustawia motyw na <html>; „auto" podąża za systemem. Wybór trzymany osobno, żeby zastosować go przed pierwszym malowaniem. */
export function applyTheme(pref: ThemePref): void {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* tryb prywatny */ }
  const dark = pref === "dark" || (pref === "auto" && !window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#000000" : "#f6f7f9");
}
