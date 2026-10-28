// Połączenie z silnikiem. Lokalnie (okno aplikacji) nie ma żadnego: UI gada z backendem pod tym samym adresem, bez tokenu.
// W wersji web (Vercel) albo przez tunel UI łączy się ze zdalnym silnikiem: adres + token zapisane w localStorage.

export interface Conn {
  /** adres silnika bez końcowego ukośnika, np. https://xyz.trycloudflare.com */
  base: string;
  /** główny token (nagłówek Authorization) */
  token: string;
  /** pochodny token tylko do odczytu mediów: trafia do adresów obrazów i EventSource, które nie wysyłają nagłówków */
  media: string;
}

const KEY = "is.conn";

/** Build dla Vercela (`npm run build:web`, tryb vite „web”): nie ma lokalnego backendu, więc zawsze trzeba się połączyć. */
export const IS_WEB = import.meta.env.MODE === "web";

function load(): Conn | null {
  try {
    const raw = localStorage.getItem(KEY);
    const c = raw ? (JSON.parse(raw) as Conn) : null;
    return c && c.base && c.token ? c : null;
  } catch { return null; }
}

let conn: Conn | null = load();

export const getConn = () => conn;
export const isRemote = () => conn !== null;

export function setConn(c: Conn | null): void {
  conn = c;
  try { c ? localStorage.setItem(KEY, JSON.stringify(c)) : localStorage.removeItem(KEY); } catch { /* tryb prywatny */ }
}

/** Adres z formularza → postać kanoniczna (dopisuje schemat, usuwa końcowe / i /api). */
export function normalizeBase(input: string): string {
  let u = input.trim().replace(/\/+$/, "").replace(/\/api$/i, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = (/^(localhost|127\.|192\.168\.|10\.)/.test(u) ? "http://" : "https://") + u;
  return u;
}

/** Sprawdza adres i token. Zwraca gotowe połączenie albo rzuca czytelny błąd (kod: 401, 403, 0 = brak połączenia). */
export async function probe(base: string, token: string): Promise<Conn> {
  let res: Response;
  try {
    res = await fetch(base + "/api/ping", { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw Object.assign(new Error("network"), { code: 0 });
  }
  if (!res.ok) throw Object.assign(new Error(String(res.status)), { code: res.status });
  let body: { app?: string; media?: string } = {};
  try { body = await res.json(); } catch { /* to nie jest silnik */ }
  if (body.app !== "image-studio") throw Object.assign(new Error("not-engine"), { code: -1 });
  return { base, token, media: body.media ?? "" };
}

// --- link parowania: https://ui.example/#connect=<base64url JSON {u, t}>. Fragment nigdy nie trafia do żadnego serwera.

export const encodeLink = (base: string, token: string) =>
  btoa(JSON.stringify({ u: base, t: token })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeLink(s: string): { u: string; t: string } | null {
  try {
    const j = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof j.u === "string" && typeof j.t === "string" ? j : null;
  } catch { return null; }
}

/** Link parowania z adresu (czyszczony od razu, żeby token nie został w historii przeglądarki). */
export const pendingLink: { u: string; t: string } | null = (() => {
  try {
    const m = /(?:^#|&)connect=([^&]+)/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, "", location.pathname + location.search);
    return decodeLink(m[1]);
  } catch { return null; }
})();

// Wklejenie linku parowania do już otwartej karty zmienia tylko fragment adresu: wtedy przeładuj, żeby go odczytać.
try { window.addEventListener("hashchange", () => { if (/connect=/.test(location.hash)) location.reload(); }); } catch { /* brak window */ }
