"""Sprawdza model bezpieczeństwa zdalnego dostępu na działającym backendzie (Host udaje zdalnego klienta).

  python tools/remote_checks.py [http://127.0.0.1:8765]
Wymaga włączonego trybu zdalnego (Ustawienia → Zdalny dostęp) i tokenu z /api/remote (lokalnie).
"""
from __future__ import annotations

import sys

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765").rstrip("/")
REMOTE_HOST = "engine.example.test"
fails = 0


def check(name: str, ok: bool, extra: str = "") -> None:
    global fails
    fails += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + name + (f"  [{extra}]" if extra else ""))


def req(method: str, path: str, host: str | None = None, token: str | None = None, headers: dict | None = None, **kw):
    h = {"Host": host} if host else {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    h.update(headers or {})
    return requests.request(method, BASE + path, headers=h, timeout=20, **kw)


st = req("GET", "/api/remote")
check("lokalnie /api/remote działa bez tokenu", st.status_code == 200)
cfg = st.json()
token = cfg["token"]
if not cfg["enabled"]:
    req("PUT", "/api/remote", json={"enabled": True, "tunnel": "off"})

# --- zdalny klient
r = req("GET", "/api/ping", host=REMOTE_HOST)
check("zdalnie bez tokenu: 401", r.status_code == 401)
r = req("GET", "/api/ping", host=REMOTE_HOST, token="zly-token")
check("zdalnie ze złym tokenem: 401", r.status_code == 401)
r = req("GET", "/api/ping", host=REMOTE_HOST, token=token)
check("zdalnie z tokenem: 200 i token mediów", r.status_code == 200 and bool(r.json().get("media")))
media = r.json().get("media", "")
check("CORS tylko dla zdalnych", r.headers.get("access-control-allow-origin") == "*" and "access-control-allow-origin" not in req("GET", "/api/ping").headers)
pre = req("OPTIONS", "/api/jobs", host=REMOTE_HOST, headers={"Origin": "https://x.vercel.app", "Access-Control-Request-Method": "POST"})
check("preflight 204 z nagłówkami CORS", pre.status_code == 204 and "authorization" in pre.headers.get("access-control-allow-headers", ""))

for method, path in [("GET", "/api/fs/list"), ("PUT", "/api/settings"), ("POST", "/api/rescan"), ("GET", "/api/catalog"), ("POST", "/api/downloads"),
                     ("GET", "/api/remote"), ("PUT", "/api/remote"), ("POST", "/api/remote/rotate"), ("POST", "/api/remote/tunnel"),
                     ("DELETE", "/api/images/abc"), ("POST", "/api/images/abc/export")]:
    r = req(method, path, host=REMOTE_HOST, token=token, json={} if method in ("PUT", "POST") else None)
    check(f"zdalnie zabronione {method} {path}", r.status_code == 403, str(r.status_code))

s = req("GET", "/api/settings", host=REMOTE_HOST, token=token).json()
check("ustawienia dla zdalnego bez ścieżek i tokenu HF", not s["model_dirs"] and not s["lora_dirs"] and not s["library_dir"] and not s["hf_token"])
ms = req("GET", "/api/models", host=REMOTE_HOST, token=token).json()
check("modele dla zdalnego bez ścieżek", all(m["path"] == "" for m in ms))

r = req("GET", "/api/images?limit=1", host=REMOTE_HOST, token=token).json()
if r["items"]:
    iid = r["items"][0]["id"]
    for kind in ("thumb", "preview", "file"):
        ok = req("GET", f"/api/images/{iid}/{kind}?token={media}", host=REMOTE_HOST)
        check(f"token mediów czyta /{kind}", ok.status_code == 200 and len(ok.content) > 100)
    check("token mediów nie czyta rekordu JSON", req("GET", f"/api/images/{iid}?token={media}", host=REMOTE_HOST).status_code == 401)
    check("token mediów nie pozwala na zapis", req("PATCH", f"/api/images/{iid}?token={media}", host=REMOTE_HOST, json={"favorite": True}).status_code == 401)
    pv = req("GET", f"/api/images/{iid}/preview?token={media}", host=REMOTE_HOST)
    check("podgląd to WebP", pv.headers.get("content-type") == "image/webp")
check("token mediów nie czyta listy zadań", req("GET", f"/api/jobs?token={media}", host=REMOTE_HOST).status_code == 401)

# --- wyłączony tryb
req("PUT", "/api/remote", json={"enabled": False})
check("po wyłączeniu zdalnie 403 nawet z tokenem", req("GET", "/api/ping", host=REMOTE_HOST, token=token).status_code == 403)
check("po wyłączeniu lokalnie dalej działa", req("GET", "/api/ping").status_code == 200)
req("PUT", "/api/remote", json={"enabled": True})

# --- lokalnie: obca strona nie sięga do localhost
r = req("GET", "/api/images?limit=1", headers={"Origin": "https://zla-strona.example"})
check("lokalnie: Origin spoza loopbacku zablokowany", r.status_code == 403)
r = req("GET", "/api/ping", headers={"Origin": "http://localhost:5173"})
check("lokalnie: Origin loopback (dev server) przechodzi", r.status_code == 200)
r = req("GET", "/api/ping", host="evil.example:8765")
check("DNS-rebinding (obcy Host) wymaga tokenu", r.status_code == 401)

print(f"\n{'WSZYSTKO OK' if not fails else str(fails) + ' BŁĘDÓW'}")
sys.exit(1 if fails else 0)
