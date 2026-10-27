"""Image Studio — launcher: uruchamia backend i otwiera okno aplikacji (bez kart i paska adresu).

Okno to Edge/Chrome w trybie `--app` z własnym profilem (data/app-profile). Zamknięcie okna zatrzymuje backend,
a tym samym zwalnia model z VRAM/RAM. Tylko biblioteka standardowa. Uruchamiaj przez pythonw (bez konsoli).

Interpreter z PyTorchem: zmienna IMAGE_STUDIO_PYTHON albo `data/launcher.json` -> {"python": "ścieżka\\do\\python.exe"}.
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("IMAGE_STUDIO_DATA") or ROOT / "data")
PORT = int(os.environ.get("IMAGE_STUDIO_PORT") or 8765)
URL = f"http://127.0.0.1:{PORT}"
APP_URL = f"{URL}/?desktop=1"                 # ?desktop=1: interfejs wyłącza menu przeglądarki i zaznaczanie tekstu
NO_WINDOW = 0x08000000


def message(text: str) -> None:
    ctypes.windll.user32.MessageBoxW(0, text, "Image Studio", 0x10)


def server_up() -> bool:
    try:
        urllib.request.urlopen(f"{URL}/api/system", timeout=1.5).read(1)
        return True
    except Exception:
        return False


def find_browser() -> str | None:
    pf = [os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LocalAppData")]
    rel = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe"]
    for r in rel:
        for base in pf:
            if base and (Path(base) / r).exists():
                return str(Path(base) / r)
    return None


def find_python() -> Path:
    env = os.environ.get("IMAGE_STUDIO_PYTHON")
    if env:
        return Path(env)
    try:
        cfg = json.loads((DATA / "launcher.json").read_text("utf-8"))
        if cfg.get("python"):
            return Path(cfg["python"])
    except Exception:
        pass
    return Path(sys.executable.replace("pythonw.exe", "python.exe"))


def main() -> None:
    DATA.mkdir(exist_ok=True)
    python = find_python()
    if not python.exists():
        message(f"Nie znaleziono interpretera Pythona: {python}\nUstaw IMAGE_STUDIO_PYTHON albo data\\launcher.json.")
        return
    server = None
    if not server_up():
        log = open(DATA / "server.log", "ab")
        server = subprocess.Popen(
            [str(python), "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
            cwd=ROOT, stdout=log, stderr=log, creationflags=NO_WINDOW)
        for _ in range(120):
            if server_up():
                break
            if server.poll() is not None:
                message("Backend nie wystartował. Szczegóły: data\\server.log")
                return
            time.sleep(0.5)
        else:
            message("Backend nie odpowiada. Szczegóły: data\\server.log")
            server.kill()
            return

    browser = find_browser()
    if not browser:
        # Bez Edge/Chrome nie ma okna aplikacji: zamiast po cichu otwierać zwykłą przeglądarkę, powiedz o tym.
        message(f"Nie znaleziono Edge/Chrome do okna aplikacji.\nBackend działa pod {URL} (zamknij go w Menedżerze zadań).")
        return
    profile = DATA / "app-profile"
    t0 = time.time()
    # Własny profil + flagi, które blokują wszystko, co mogłoby otworzyć zwykłe okno przeglądarki
    # (przywracanie sesji, strona powitalna, domyślna przeglądarka, praca w tle).
    proc = subprocess.Popen([browser, f"--app={APP_URL}", f"--user-data-dir={profile}", "--window-size=1560,980",
                             "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble",
                             "--hide-crash-restore-bubble", "--disable-background-mode", "--disable-sync",
                             "--disable-features=Translate,msEdgeSidebar,msEdgeSplitWindow,StartupBoost"])
    proc.wait()
    if time.time() - t0 < 6:                  # proces przekazał okno innemu: czekaj, aż zniknie ostatni z naszym profilem
        marker = "app-profile"
        while True:
            out = subprocess.run(["powershell", "-NoProfile", "-Command",
                                  f"(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -match '{marker}' }}).Count"],
                                 capture_output=True, text=True, creationflags=NO_WINDOW).stdout.strip()
            if not out or out == "0":
                break
            time.sleep(2)

    if server is not None:                    # okno zamknięte → zatrzymaj backend (zwalnia model z VRAM i RAM)
        subprocess.run(["taskkill", "/PID", str(server.pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)


if __name__ == "__main__":
    main()
