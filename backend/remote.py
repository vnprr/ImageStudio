"""Zdalny dostęp („tryb silnika"): ten sam backend obsługuje interfejs web (np. na Vercelu) przez tunel HTTPS.

Model bezpieczeństwa:
  • Żądanie jest *lokalne*, gdy nagłówek Host to 127.0.0.1 / localhost / [::1]. Tunele (cloudflared, tailscale serve) łączą się z
    loopbacku, więc adres klienta nic nie mówi, ale Host zawiera publiczną nazwę. Tak samo odpada DNS-rebinding.
  • Lokalne żądania nie wymagają tokenu (okno aplikacji), ale są odrzucane, jeśli Origin pochodzi spoza loopbacku
    (strona w przeglądarce nie może sięgać do biblioteki przez localhost).
  • Zdalne żądania do /api wymagają włączonego trybu i tokenu (Authorization: Bearer albo ?token=). Mają wąską listę dozwolonych
    endpointów: bez przeglądania dysku, zmiany ustawień, pobierania modeli, trwałego usuwania i eksportu do folderu.
  • <img> i EventSource nie wysyłają nagłówków, więc dla odczytu mediów jest drugi, pochodny token (HMAC), który nie pozwala
    wywołać niczego innego.
  • CORS jest dodawany tylko do odpowiedzi zdalnych, a niepoprawny token spowalnia odpowiedź (utrudnia zgadywanie).
"""
from __future__ import annotations

import asyncio
import base64
import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

from .config import DATA, PORT

REMOTE_FILE = DATA / "remote.json"
LOOPBACK = {"127.0.0.1", "localhost", "[::1]"}

# (metoda, wzorzec ścieżki) dozwolone dla klienta zdalnego z głównym tokenem
_ALLOWED = [
    ("GET", r"/api/(ping|system|events|models|loras|jobs|images|library/(stats|days)|presets|prompt-library|settings)"),
    ("GET", r"/api/(jobs|images|uploads)/[^/]+"),
    ("GET", r"/api/images/[^/]+/(file|thumb|preview|download)"),
    ("POST", r"/api/(jobs|uploads|images/import|models/unload)"),
    ("POST", r"/api/models/[^/]+/load"),
    ("DELETE", r"/api/jobs/[^/]+"),
    ("PATCH", r"/api/images/[^/]+"),
    ("PUT", r"/api/(presets/[^/]+|prompt-library)"),
    ("DELETE", r"/api/presets/[^/]+"),
]
_ALLOWED_RX = [(m, re.compile(p + r"/?$")) for m, p in _ALLOWED]
# to, co może odczytać pochodny token mediów
_MEDIA_RX = re.compile(r"/api/(events|images/[^/]+/(file|thumb|preview|download)|uploads/[^/]+)/?$")


# ───────────────────────── stan i token ─────────────────────────

_lock = threading.Lock()
_state: dict | None = None
_KEYS = ("enabled", "token", "public_url", "web_ui_url", "tunnel", "rv_secret", "rv_bypass")


def _defaults() -> dict:
    return {"enabled": False, "token": secrets.token_urlsafe(24), "public_url": "", "web_ui_url": "", "tunnel": "off",
            "rv_secret": secrets.token_urlsafe(32), "rv_bypass": ""}


def _override() -> dict:
    # tryb silnika z launchera: zdalny dostęp włączony na czas tej sesji (bez zapisu do pliku)
    return {"enabled": True, "tunnel": "auto"} if os.environ.get("IMAGE_STUDIO_ENGINE") == "1" else {}


def get() -> dict:
    global _state
    with _lock:
        if _state is None:
            try:
                _state = {**_defaults(), **json.loads(REMOTE_FILE.read_text("utf-8"))}
            except Exception:
                _state = _defaults()
            _save_locked()
        return {**_state, **_override()}


def _save_locked() -> None:
    assert _state is not None
    DATA.mkdir(parents=True, exist_ok=True)
    REMOTE_FILE.write_text(json.dumps({k: _state[k] for k in _KEYS}, indent=2), "utf-8")


def update(**kw) -> dict:
    get()
    with _lock:
        assert _state is not None
        for k, v in kw.items():
            if k in ("enabled", "public_url", "web_ui_url", "tunnel", "rv_bypass") and v is not None:
                _state[k] = v
        _save_locked()
        return {**_state, **_override()}


def rotate_token() -> dict:
    get()
    with _lock:
        assert _state is not None
        _state["token"] = secrets.token_urlsafe(24)
        _save_locked()
        return {**_state, **_override()}


def media_token(token: str) -> str:
    return hmac.new(token.encode(), b"media", hashlib.sha256).hexdigest()[:32]


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


# ───────────────────────── middleware ─────────────────────────

def _hostname(host: str) -> str:
    h = host.strip().lower()
    return h[: h.index("]") + 1] if h.startswith("[") and "]" in h else h.split(":")[0]


def is_local_host(host: str) -> bool:
    return _hostname(host) in LOOPBACK


def _origin_is_loopback(origin: str) -> bool:
    try:
        return (urllib.parse.urlsplit(origin).hostname or "") in {"127.0.0.1", "localhost", "::1"}
    except ValueError:
        return False


def _allowed(method: str, path: str) -> bool:
    return any(m == method and rx.match(path) for m, rx in _ALLOWED_RX)


CORS_HEADERS = [
    (b"access-control-allow-origin", b"*"),
    (b"access-control-allow-headers", b"authorization, content-type"),
    (b"access-control-allow-methods", b"GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    (b"access-control-expose-headers", b"content-disposition"),
    (b"access-control-max-age", b"86400"),
    (b"vary", b"origin"),
]


class RemoteGate:
    """Czysty middleware ASGI (bez buforowania, więc SSE działa)."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope["headers"]}
        local = is_local_host(headers.get("host", ""))
        scope["is_remote"] = not local
        path, method = scope["path"], scope["method"]

        async def reply(status: int, detail: str, cors: bool, extra: list | None = None):
            body = json.dumps({"detail": detail}).encode()
            hdr = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *(extra or [])]
            await send({"type": "http.response.start", "status": status, "headers": hdr + (CORS_HEADERS if cors else [])})
            await send({"type": "http.response.body", "body": body})

        if local:
            origin = headers.get("origin")
            if origin and path.startswith("/api/") and not _origin_is_loopback(origin):
                return await reply(403, "Żądanie z obcej strony do lokalnej aplikacji zostało zablokowane.", False)
            return await self.app(scope, receive, send)

        # --- żądanie zdalne ---
        if method == "OPTIONS":
            return await self._preflight(send)
        if not path.startswith("/api/"):                       # statyczny interfejs jest publiczny, dane nie
            return await self.app(scope, receive, send)

        st = get()
        if not st["enabled"]:
            return await reply(403, "Zdalny dostęp jest wyłączony na tym komputerze.", True)
        q = urllib.parse.parse_qs(scope.get("query_string", b"").decode("latin1"))
        auth = headers.get("authorization", "")
        supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else (q.get("token") or [""])[0]
        ok_main = bool(supplied) and _eq(supplied, st["token"])
        ok_media = bool(supplied) and method == "GET" and bool(_MEDIA_RX.match(path)) and _eq(supplied, media_token(st["token"]))
        if not (ok_main or ok_media):
            await asyncio.sleep(0.4)                           # utrudnia zgadywanie tokenu
            return await reply(401, "Brak lub niepoprawny token dostępu.", True)
        if ok_main and not _allowed(method, path):
            return await reply(403, "Ta operacja jest dostępna tylko na komputerze z silnikiem.", True)

        async def send_cors(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), *CORS_HEADERS]}
            await send(message)

        return await self.app(scope, receive, send_cors)

    @staticmethod
    async def _preflight(send):
        await send({"type": "http.response.start", "status": 204, "headers": CORS_HEADERS})
        await send({"type": "http.response.body", "body": b""})


# ───────────────────────── instalacja cloudflared (jednym kliknięciem) ─────────────────────────

RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"
ASSET = "cloudflared-windows-amd64.exe"
_UA = {"User-Agent": "image-studio-remote"}


class Installer:
    """Pobiera oficjalny cloudflared z GitHuba do data/bin. Plik jest uruchamiany dopiero po weryfikacji: skrót SHA-256 z API wydania
    (niezależne źródło od samego pliku) albo ważny podpis Authenticode wystawiony dla Cloudflare."""

    def __init__(self) -> None:
        self.state = "idle"          # idle | downloading | verifying | done | error
        self.progress = 0.0
        self.error = ""
        self._lock = threading.Lock()

    def run(self) -> bool:
        with self._lock:
            if find_cloudflared():
                self.state = "done"
                return True
            if os.name != "nt":
                self.state, self.error = "error", "Automatyczna instalacja tunelu działa tylko w Windows."
                return False
            self.state, self.progress, self.error = "downloading", 0.0, ""
            dest = DATA / "bin" / "cloudflared.exe"
            part = dest.with_suffix(".part")
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                rel = json.loads(urllib.request.urlopen(urllib.request.Request(RELEASE_API, headers=_UA), timeout=20).read())
                asset = next(a for a in rel["assets"] if a["name"] == ASSET)
                url = asset["browser_download_url"]
                if not url.startswith("https://github.com/cloudflare/cloudflared/"):
                    raise RuntimeError("Nieoczekiwany adres pobierania.")
                sha = hashlib.sha256()
                with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=30) as r, open(part, "wb") as f:
                    total = int(r.headers.get("Content-Length") or asset.get("size") or 0)
                    done = 0
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                        sha.update(chunk)
                        done += len(chunk)
                        self.progress = done / total if total else 0.0
                self.state = "verifying"
                want = str(asset.get("digest") or "").removeprefix("sha256:").lower()
                if want:
                    if sha.hexdigest() != want:
                        raise RuntimeError("Suma kontrolna pobranego pliku się nie zgadza. Plik odrzucony.")
                elif not _signed_by_cloudflare(part):
                    raise RuntimeError("Nie udało się zweryfikować pobranego pliku (brak sumy i podpisu). Plik odrzucony.")
                os.replace(part, dest)
                self.state, self.progress = "done", 1.0
                return True
            except Exception as ex:
                part.unlink(missing_ok=True)
                self.state, self.error = "error", f"Instalacja tunelu nie powiodła się: {ex}"
                return False

    def info(self) -> dict:
        return {"state": self.state, "progress": round(self.progress, 3), "error": self.error}


def _signed_by_cloudflare(path: Path) -> bool:
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              f"$s=Get-AuthenticodeSignature -LiteralPath '{path}'; \"$($s.Status)|$($s.SignerCertificate.Subject)\""],
                             capture_output=True, text=True, timeout=60, creationflags=0x08000000).stdout.strip()
        status, _, subject = out.partition("|")
        return status == "Valid" and "cloudflare" in subject.lower()
    except Exception:
        return False


installer = Installer()


# ───────────────────────── tunel ─────────────────────────

_URL_RX = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def find_cloudflared() -> str | None:
    cands = [shutil.which("cloudflared"), str(DATA / "bin" / "cloudflared.exe")]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands += glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages", "Cloudflare.cloudflared_*", "cloudflared.exe"))
        cands += glob.glob(os.path.join(local, "Microsoft", "WinGet", "Links", "cloudflared.exe"))
    for pf in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        if pf:
            cands.append(os.path.join(pf, "cloudflared", "cloudflared.exe"))
    return next((c for c in cands if c and Path(c).is_file()), None)


class Tunnel:
    """Tunel Cloudflare „quick" (cloudflared tunnel --url): bez konta, z losowym adresem HTTPS. Adres bez tokenu nic nie daje."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.state = "off"                  # off | starting | up | error | missing
        self.url = ""
        self.error = ""
        self.on_up = None                   # wywoływane z nowym adresem
        self._lock = threading.Lock()

    def start(self, port: int = PORT) -> None:
        with self._lock:
            if self.proc and self.proc.poll() is None:
                return
            exe = find_cloudflared()
            if not exe:
                self.state, self.error, self.url = "missing", "Tunel nie jest zainstalowany.", ""
                return
            self.state, self.error, self.url = "starting", "", ""
            flags = 0x08000000 if os.name == "nt" else 0
            self.proc = subprocess.Popen([exe, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"], stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", creationflags=flags)
            threading.Thread(target=self._read, args=(self.proc,), daemon=True).start()

    def _read(self, proc: subprocess.Popen) -> None:
        tail: list[str] = []
        for line in proc.stdout or []:
            tail = (tail + [line.strip()])[-6:]
            m = _URL_RX.search(line)
            if m and self.proc is proc and self.state != "up":
                self.url, self.state = m.group(0), "up"
                if self.on_up:
                    threading.Thread(target=self.on_up, args=(self.url,), daemon=True).start()
        if self.proc is proc and self.state != "off":
            self.state, self.url = "error", ""
            self.error = " | ".join(tail)[-300:] or "Tunel zakończył pracę."

    def stop(self) -> None:
        with self._lock:
            proc, self.proc = self.proc, None
            self.state, self.url = "off", ""
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()

    def info(self) -> dict:
        return {"state": self.state, "url": self.url, "error": self.error, "installed": find_cloudflared() is not None}


tunnel = Tunnel()


# ───────────────────────── stały adres: rejestracja w usłudze na Vercelu ─────────────────────────
# Adres tunelu „quick" zmienia się przy każdym starcie. Interfejs web (na Vercelu) ma małą funkcję /api/rv, w której silnik zapisuje
# swój bieżący adres pod identyfikatorem wyliczonym z tajnego klucza (id = SHA-256(klucz)); zapisać może tylko właściciel klucza.
# Link połączenia zawiera ten identyfikator, więc działa po każdym restarcie komputera.

class Registry:
    def __init__(self) -> None:
        self.state = "off"          # off | ok | error
        self.error = ""
        self.at = 0.0

    def rv_id(self) -> str:
        return hashlib.sha256(get()["rv_secret"].encode()).hexdigest()[:32]

    def register(self, url: str) -> bool:
        st = get()
        web = st["web_ui_url"].rstrip("/")
        if not web or not url:
            self.state, self.error = "off", ""
            return False
        headers = {"Content-Type": "application/json", **_UA}
        if st["rv_bypass"]:                                   # ochrona wdrożenia (logowanie) przepuszcza tylko to wywołanie silnika
            headers["x-vercel-protection-bypass"] = st["rv_bypass"]
        body = json.dumps({"reg": st["rv_secret"], "url": url}).encode()
        last = ""
        for delay in (0, 2, 5, 12):
            time.sleep(delay)
            try:
                with urllib.request.urlopen(urllib.request.Request(web + "/api/rv", data=body, headers=headers, method="POST"), timeout=15) as r:
                    if r.status == 200:
                        self.state, self.error, self.at = "ok", "", time.time()
                        return True
                    last = f"HTTP {r.status}"
            except Exception as ex:
                last = str(ex)
        self.state, self.error = "error", f"Rejestracja adresu w wersji web nie powiodła się: {last}"
        return False


registry = Registry()
tunnel.on_up = registry.register


def connect_link(url: str, token: str) -> tuple[str, bool]:
    """Link połączenia: z identyfikatorem rejestru (stały), gdy adres jest zarejestrowany, inaczej z gołym adresem tunelu."""
    st = get()
    base = st["web_ui_url"].rstrip("/") or url
    if not base:
        return "", False
    stable = bool(st["web_ui_url"] and registry.state == "ok")
    payload = {"t": token, **({"i": registry.rv_id()} if stable else {}), **({"u": url} if url else {})}
    code = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    return f"{base}/#connect={code}", stable


# ───────────────────────── włączanie jednym przyciskiem ─────────────────────────

_watch_lock = threading.Lock()
_watch_on = False


def bring_up() -> None:
    """Instaluje tunel (jeśli trzeba), uruchamia go i pilnuje, żeby działał, dopóki zdalny dostęp jest włączony."""
    global _watch_on

    def run() -> None:
        global _watch_on
        try:
            while True:
                st = get()
                if not st["enabled"] or st["tunnel"] != "auto":
                    return
                if not find_cloudflared() and installer.state != "error":
                    installer.run()
                if find_cloudflared() and tunnel.state in ("off", "error", "missing"):
                    tunnel.start(PORT)
                time.sleep(15)
        finally:
            with _watch_lock:
                _watch_on = False

    with _watch_lock:
        if _watch_on:
            return
        _watch_on = True
    threading.Thread(target=run, daemon=True).start()


def retry_install() -> None:
    installer.state = "idle"
    bring_up()


def status(include_secret: bool = True) -> dict:
    st = get()
    t = tunnel.info()
    url = st["public_url"] or t["url"]
    out = {"enabled": st["enabled"], "public_url": st["public_url"], "web_ui_url": st["web_ui_url"], "tunnel_mode": st["tunnel"],
           "tunnel": t, "install": installer.info(), "effective_url": url, "port": PORT,
           "engine_env": os.environ.get("IMAGE_STUDIO_ENGINE") == "1",
           "registry": {"state": registry.state, "error": registry.error, "configured": bool(st["web_ui_url"]), "protected": bool(st["rv_bypass"])}}
    if include_secret:
        out["token"] = st["token"]
        out["link"], out["link_stable"] = connect_link(url, st["token"])
    return out
