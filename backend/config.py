"""Ścieżki i trwałe ustawienia (data/settings.json)."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
# Dane i modele leżą poza kodem: domyślnie obok niego, ale można je przenieść zmiennymi środowiskowymi
# (repozytorium z kodem i zainstalowana aplikacja z danymi mogą być w różnych folderach).
DATA = Path(os.environ.get("IMAGE_STUDIO_DATA") or ROOT / "data")
DEFAULT_MODELS = Path(os.environ.get("IMAGE_STUDIO_MODELS") or ROOT / "models")
SETTINGS_FILE = DATA / "settings.json"
PORT = int(os.environ.get("IMAGE_STUDIO_PORT") or 8765)


def detect_comfy() -> Path | None:
    """Znajdź istniejący katalog models/ ComfyUI (zmienna COMFYUI_DIR lub typowe lokalizacje)."""
    cands = [os.environ.get("COMFYUI_DIR"), r"C:\ComfyUI", str(Path.home() / "ComfyUI")]
    for c in cands:
        if c and (Path(c) / "models").is_dir():
            return Path(c) / "models"
    return None


class Settings(BaseModel):
    model_dirs: list[str] = Field(default_factory=list)
    lora_dirs: list[str] = Field(default_factory=list)
    library_dir: str = str(DATA / "library")
    default_model_id: str | None = None
    precision: Literal["auto", "bf16", "fp16"] = "auto"
    offload: Literal["auto", "gpu", "model"] = "auto"
    # zwalnianie modelu z pamięci: manual = tylko przyciskiem lub przy zmianie modelu; after_job = po każdym zadaniu;
    # idle = po N minutach bezczynności
    unload_mode: Literal["manual", "after_job", "idle"] = "manual"
    unload_idle_minutes: int = Field(default=10, ge=1, le=1440)
    hf_token: str | None = None
    embed_metadata_png: bool = True


_lock = threading.Lock()
_cache: Settings | None = None


def _initial() -> Settings:
    s = Settings(model_dirs=[str(DEFAULT_MODELS)], lora_dirs=[str(DEFAULT_MODELS / "loras")])
    comfy = detect_comfy()
    if comfy:
        for sub, target in (("diffusion_models", s.model_dirs), ("checkpoints", s.model_dirs), ("loras", s.lora_dirs)):
            if (comfy / sub).is_dir():
                target.append(str(comfy / sub))
    return s


def get_settings() -> Settings:
    global _cache
    with _lock:
        if _cache is None:
            DATA.mkdir(parents=True, exist_ok=True)
            if SETTINGS_FILE.exists():
                try:
                    raw = json.loads(SETTINGS_FILE.read_text("utf-8"))
                    if raw.pop("keep_model_loaded", True) is False and "unload_mode" not in raw:
                        raw["unload_mode"] = "after_job"          # migracja ze starego ustawienia
                    _cache = Settings(**raw)
                except Exception:
                    _cache = _initial()
            else:
                _cache = _initial()
                SETTINGS_FILE.write_text(_cache.model_dump_json(indent=2), "utf-8")
        return _cache


def save_settings(s: Settings) -> Settings:
    global _cache
    with _lock:
        for p in [s.library_dir, *s.model_dirs]:
            Path(p).mkdir(parents=True, exist_ok=True)
        _cache = s
        DATA.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(s.model_dump_json(indent=2), "utf-8")
        return s


def library_dir() -> Path:
    p = Path(get_settings().library_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p
