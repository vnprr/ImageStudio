"""Instalacja modeli z Hugging Face: inspekcja (rozmiar, licencja, miejsce), pobieranie z postępem, wznawianie, anulowanie."""
from __future__ import annotations

import fnmatch
import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

import requests
from huggingface_hub import HfApi, hf_hub_download

from .config import get_settings

SKIP = ["*.md", ".gitattributes", "assets/*", "*.jpg", "*.jpeg", "*.png", "*.gif", "*.pdf", ".cache/*"]
KNOWN = {"Flux2KleinPipeline": "flux2-klein", "Flux2KleinKVPipeline": "flux2-klein", "ZImagePipeline": "z-image"}

CATALOG = [
    {"repo_id": "black-forest-labs/FLUX.2-klein-4B", "name": "FLUX.2 klein 4B",
     "description": "Szybki model 4 kroki: tekst → obraz, edycja, wiele referencji, LoRA, inpainting. Licencja Apache-2.0.",
     "family": "flux2-klein", "size_bytes": 16_000_000_000},
    {"repo_id": "Tongyi-MAI/Z-Image-Turbo", "name": "Z-Image Turbo",
     "description": "Szybki model T2I (ok. 8 kroków), img2img i inpainting, LoRA. Licencja Apache-2.0. Duże pliki (fp32).",
     "family": "z-image", "size_bytes": 32_900_000_000},
]


def _api() -> HfApi:
    return HfApi(token=get_settings().hf_token or None)


def _wanted(path: str, has_index: bool) -> bool:
    if any(fnmatch.fnmatch(path, p) for p in SKIP):
        return False
    if has_index and "/" not in path and path.endswith((".safetensors", ".ckpt", ".pt", ".bin")):
        return False                                    # duplikat modelu w korzeniu repo (układ Diffusers wystarcza)
    return True


def free_bytes(path: Path) -> int:
    p = path
    while not p.exists() and p.parent != p:
        p = p.parent
    return shutil.disk_usage(p).free


def target_root() -> Path:
    d = Path(get_settings().model_dirs[0])
    d.mkdir(parents=True, exist_ok=True)
    return d


def inspect(repo: str) -> dict:
    api = _api()
    try:
        info = api.model_info(repo, files_metadata=True)
    except Exception as ex:
        msg = str(ex)
        if "401" in msg or "403" in msg or "gated" in msg.lower():
            raise PermissionError("To repozytorium wymaga zaakceptowania licencji na Hugging Face i tokenu (Ustawienia → token HF).")
        if "404" in msg:
            raise LookupError("Nie znaleziono takiego repozytorium na Hugging Face.")
        raise RuntimeError(f"Błąd połączenia z Hugging Face: {msg}")
    files = info.siblings or []
    has_index = any(s.rfilename == "model_index.json" for s in files)
    use = [s for s in files if _wanted(s.rfilename, has_index)]
    size = sum(s.size or 0 for s in use)
    lic = (info.card_data.get("license") if info.card_data else None) or next(
        (t.split(":", 1)[1] for t in (info.tags or []) if t.startswith("license:")), None)
    family, note = "unknown", None
    if has_index:
        try:
            p = hf_hub_download(repo, "model_index.json", token=get_settings().hf_token or None)
            cls = json.loads(Path(p).read_text("utf-8")).get("_class_name", "")
            family = KNOWN.get(cls, "unknown")
            if family == "unknown":
                note = f"Pipeline „{cls}” nie jest obsługiwany przez ten backend."
        except Exception:
            note = "Nie udało się odczytać model_index.json."
    else:
        note = "Repozytorium nie ma układu Diffusers (model_index.json) — instaluj modele w formacie Diffusers."
    free = free_bytes(target_root())
    gated = bool(info.gated)
    return {"repo_id": repo, "name": repo.split("/")[-1], "license": lic, "gated": gated,
            "requires_token": gated and not get_settings().hf_token, "size_bytes": size, "free_bytes": free,
            "enough_space": free > size * 1.05 + 2 * 2**30, "files": len(use), "family": family,
            "supported": family != "unknown", "note": note}


class Downloads:
    def __init__(self, emit: Callable[[str, dict], None], on_done: Callable[[], None]) -> None:
        self.emit, self.on_done = emit, on_done
        self.items: dict[str, dict] = {}
        self.cancel: dict[str, threading.Event] = {}

    def list(self) -> list[dict]:
        return list(self.items.values())

    def start(self, repo: str) -> dict:
        for d in self.items.values():
            if d["repo_id"] == repo and d["status"] in ("queued", "running"):
                return d
        meta = inspect(repo)
        if not meta["supported"]:
            raise ValueError(meta["note"] or "Nieobsługiwany model.")
        if meta["requires_token"]:
            raise PermissionError("Model wymaga tokenu Hugging Face (Ustawienia).")
        if not meta["enough_space"]:
            raise OSError(f"Za mało miejsca na dysku: potrzeba {meta['size_bytes'] / 2**30:.1f} GB, wolne {meta['free_bytes'] / 2**30:.1f} GB.")
        did = uuid.uuid4().hex[:8]
        target = target_root() / repo.split("/")[-1]
        st = {"id": did, "repo_id": repo, "status": "queued", "bytes_done": 0, "bytes_total": meta["size_bytes"], "speed": 0.0,
              "eta": None, "current_file": None, "error": None, "target_dir": str(target)}
        self.items[did] = st
        self.cancel[did] = threading.Event()
        threading.Thread(target=self._run, args=(did,), daemon=True, name=f"dl-{did}").start()
        return st

    def stop(self, did: str) -> dict | None:
        if did in self.cancel:
            self.cancel[did].set()
        return self.items.get(did)

    def _run(self, did: str) -> None:
        st, stop = self.items[did], self.cancel[did]
        token = get_settings().hf_token or None
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            st["status"] = "running"
            info = _api().model_info(st["repo_id"], files_metadata=True)
            has_index = any(s.rfilename == "model_index.json" for s in info.siblings or [])
            files = [(s.rfilename, s.size or 0) for s in info.siblings or [] if _wanted(s.rfilename, has_index)]
            target = Path(st["target_dir"])
            done_before = 0
            t0, last_emit, last_bytes, last_t = time.monotonic(), 0.0, 0, time.monotonic()
            for rel, size in files:
                if stop.is_set():
                    raise InterruptedError()
                dest = target / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                st["current_file"] = rel
                if dest.exists() and dest.stat().st_size == size:
                    done_before += size
                    st["bytes_done"] = done_before
                    continue
                part = dest.with_name(dest.name + ".part")
                have = part.stat().st_size if part.exists() else 0
                url = f"https://huggingface.co/{st['repo_id']}/resolve/main/{rel}"
                h = dict(headers)
                if have:
                    h["Range"] = f"bytes={have}-"
                with requests.get(url, headers=h, stream=True, timeout=30, allow_redirects=True) as r:
                    if r.status_code == 416:                      # część już kompletna
                        have = size
                    else:
                        r.raise_for_status()
                        if r.status_code == 200:
                            have = 0                              # serwer zignorował Range
                        with open(part, "ab" if have else "wb") as f:
                            for chunk in r.iter_content(1 << 20):
                                if stop.is_set():
                                    raise InterruptedError()
                                f.write(chunk)
                                have += len(chunk)
                                st["bytes_done"] = done_before + have
                                now = time.monotonic()
                                if now - last_t >= 1.0:
                                    st["speed"] = (st["bytes_done"] - last_bytes) / (now - last_t)
                                    last_bytes, last_t = st["bytes_done"], now
                                    rem = st["bytes_total"] - st["bytes_done"]
                                    st["eta"] = rem / st["speed"] if st["speed"] > 1 else None
                                if now - last_emit > 0.5:
                                    last_emit = now
                                    self.emit("download", st)
                part.replace(dest)
                done_before += size
                st["bytes_done"] = done_before
            st.update(status="done", current_file=None, speed=0.0, eta=0, bytes_done=st["bytes_total"])
            self.on_done()
        except InterruptedError:
            st.update(status="cancelled", speed=0.0, eta=None)
        except Exception as ex:                                    # noqa: BLE001
            st.update(status="error", error=str(ex), speed=0.0, eta=None)
        finally:
            self.emit("download", st)
