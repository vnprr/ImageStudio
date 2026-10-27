"""Wykrywanie lokalnych modeli, checkpointów i LoRA oraz ich zgodności (bez ładowania wag)."""
from __future__ import annotations

import hashlib
import json
import re
import struct
import threading
from pathlib import Path

from .config import get_settings

CLASS_FAMILY = {"Flux2KleinPipeline": "flux2-klein", "Flux2KleinKVPipeline": "flux2-klein",
                "ZImagePipeline": "z-image", "QwenImagePipeline": "qwen-image", "QwenImageEditPipeline": "qwen-image"}
SKIP_DIRS = {"vae", "text_encoders", "text_encoder", "clip", "clip_vision", "controlnet", "upscale_models",
             "embeddings", "loras", "lora", "tokenizer", "scheduler", "transformer", ".cache", "__pycache__"}
MIN_MODEL_BYTES = int(1.5 * 2**30)
MAX_LORA_BYTES = 4 * 2**30

QWEN_REASON = ("Pliki w formacie ComfyUI (Qwen Image 2.1): inna architektura niż QwenImageTransformer2DModel z Diffusers "
               "— {blocks} bloków jednostrumieniowych o wymiarze {dim} (tensory txt_in.in_layer, modulation.1, img_mlp.gate_up) "
               "zamiast 60 bloków dwustrumieniowych o wymiarze 3072, a koder tekstu to Qwen3-VL-8B. Zgodność z backendem "
               "Diffusers nie została potwierdzona, więc model jest tylko wykryty (bez ładowania).")


def read_header(path: Path) -> dict:
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > 100_000_000:
            raise ValueError("nieprawidłowy nagłówek safetensors")
        return json.loads(f.read(n))


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def _hash(p: Path) -> str:
    return hashlib.sha1(str(p.resolve()).lower().encode()).hexdigest()[:8]


def _max_idx(keys: list[str], pat: str) -> int:
    best = -1
    rx = re.compile(pat)
    for k in keys:
        m = rx.search(k)
        if m:
            best = max(best, int(m.group(1)))
    return best


def sniff_transformer(h: dict) -> dict:
    """Rozpoznaj rodzinę po nazwach i kształtach tensorów pliku z samym transformerem."""
    keys = [k for k in h if k != "__metadata__"]
    blob = " ".join(keys[:4000])
    if "double_stream_modulation" in blob or ("double_blocks" in blob and "single_blocks" in blob and "img_in.weight" in h
                                               and h["img_in.weight"]["shape"][0] in (3072, 4096, 6144) and _max_idx(keys, r"double_blocks\.(\d+)\.") < 9):
        hid = h.get("img_in.weight", {}).get("shape", [0])[0]
        return {"family": "flux2-klein", "variant": {3072: "4b", 4096: "9b"}.get(hid, f"dim{hid}"), "hidden": hid}
    if "noise_refiner" in blob or "context_refiner" in blob or "cap_embedder" in blob:
        return {"family": "z-image", "variant": "turbo", "hidden": 0}
    if "txt_in.in_layer" in blob or ("transformer_blocks" in blob and "img_mlp" in blob):
        dim = h.get("img_in.weight", {}).get("shape", [0])[0]
        return {"family": "qwen-image", "variant": "comfy-2.1" if "txt_in.in_layer" in blob else "1.0", "hidden": dim,
                "blocks": _max_idx(keys, r"transformer_blocks\.(\d+)\.") + 1}
    return {"family": "unknown", "variant": "", "hidden": 0}


def _dir_size(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*.safetensors") if f.is_file())


def _transformer_hidden(p: Path) -> int:
    try:
        c = json.loads((p / "transformer" / "config.json").read_text("utf-8"))
        return int(c["num_attention_heads"]) * int(c["attention_head_dim"])
    except Exception:
        return 0


def _scan_model_dir(root: Path, out: list[dict]) -> None:
    if not root.is_dir():
        return

    def walk(d: Path, depth: int):
        mi = d / "model_index.json"
        if mi.exists():
            try:
                cls = json.loads(mi.read_text("utf-8")).get("_class_name", "")
                idx = json.loads(mi.read_text("utf-8"))
            except Exception:
                cls, idx = "", {}
            fam = CLASS_FAMILY.get(cls, "unknown")
            e = {"id": slug(d.name) or _hash(d), "name": d.name, "family": fam, "kind": "base", "path": str(d),
                 "format": "diffusers", "size_bytes": _dir_size(d), "status": "ready", "unsupported_reason": None,
                 "hidden": _transformer_hidden(d), "is_distilled": bool(idx.get("is_distilled", True)),
                 "turbo": "turbo" in d.name.lower(), "license": "apache-2.0" if fam in ("flux2-klein", "z-image") else None}
            # kompletność: bez wag transformera folder to niedokończone pobieranie
            partial = ((d / ".cache").is_dir() and any((d / ".cache").rglob("*.incomplete"))) or any(d.rglob("*.part"))
            if fam != "unknown" and (partial or not any((d / "transformer").glob("*.safetensors"))):
                e["status"], e["unsupported_reason"] = "unsupported", "Niekompletny folder modelu (brak wag transformera) — dokończ pobieranie."
            elif fam == "qwen-image":
                e["status"] = "unsupported"
                e["unsupported_reason"] = "Format Diffusers Qwen-Image wykryty, ale zgodność tego wariantu nie została przetestowana — wyłączony."
            elif fam == "unknown":
                e["status"], e["unsupported_reason"] = "unsupported", f"Nieobsługiwany pipeline ({cls or 'brak _class_name'})."
            out.append(e)
            return
        if depth <= 0:
            return
        try:
            children = sorted(d.iterdir())
        except OSError:
            return
        for c in children:
            if c.is_dir() and c.name.lower() not in SKIP_DIRS and not c.name.startswith("."):
                walk(c, depth - 1)
            elif c.is_file() and c.suffix == ".safetensors":
                try:
                    size = c.stat().st_size
                except OSError:
                    continue
                if size < MIN_MODEL_BYTES or d.name.lower() in SKIP_DIRS - {"transformer"}:
                    continue
                try:
                    sn = sniff_transformer(read_header(c))
                except Exception as ex:
                    out.append({"id": f"ckpt-{_hash(c)}", "name": c.stem, "family": "unknown", "kind": "checkpoint", "path": str(c),
                                "format": "single-file", "size_bytes": size, "status": "unsupported",
                                "unsupported_reason": f"Nie udało się odczytać nagłówka: {ex}", "license": None})
                    continue
                e = {"id": f"ckpt-{slug(c.stem)[:40]}-{_hash(c)[:4]}", "name": c.stem, "family": sn["family"], "kind": "checkpoint",
                     "path": str(c), "format": "single-file", "size_bytes": size, "status": "ready", "unsupported_reason": None,
                     "hidden": sn.get("hidden", 0), "variant": sn.get("variant", ""), "license": None}
                if sn["family"] == "qwen-image":
                    e["status"] = "unsupported"
                    e["unsupported_reason"] = QWEN_REASON.format(blocks=sn.get("blocks", "?"), dim=sn.get("hidden", "?"))
                elif sn["family"] == "unknown":
                    e["status"], e["unsupported_reason"] = "unsupported", "Nie rozpoznano architektury pliku."
                out.append(e)

    walk(root, 4)


def sniff_lora(path: Path) -> dict:
    """Wykryj architekturę LoRA po nazwach kluczy / kształtach / metadanych."""
    h = read_header(path)
    meta = h.get("__metadata__") or {}
    keys = [k for k in h if k != "__metadata__"]
    blob = " ".join(keys)
    base_hint = (meta.get("ss_base_model_version") or meta.get("modelspec.architecture") or "").lower()

    def in_dim() -> int:
        for k in keys:
            if (".lora_A." in k or "lora_down" in k) and k.endswith("weight") and len(h[k]["shape"]) == 2:
                return h[k]["shape"][1]
        return 0

    if "qwen" in base_hint:
        return {"family": "qwen-image", "detail": base_hint}
    if "noise_refiner" in blob or "context_refiner" in blob or "adaLN_modulation" in blob or "feed_forward.w1" in blob:
        return {"family": "z-image", "detail": ""}
    flux_like = any(s in blob for s in ("double_blocks", "single_blocks", "single_transformer_blocks", "double_stream_modulation"))
    if flux_like:
        nd = max(_max_idx(keys, r"double_blocks[._](\d+)"), _max_idx(keys, r"(?<!single_)transformer_blocks[._](\d+)"))
        ns = max(_max_idx(keys, r"single_blocks[._](\d+)"), _max_idx(keys, r"single_transformer_blocks[._](\d+)"))
        if nd >= 9 or ns >= 30:
            return {"family": "flux1-or-dev", "detail": f"double≤{nd}, single≤{ns}"}
        d = in_dim()
        return {"family": "flux2-klein", "detail": f"hidden={d}", "hidden": d}
    if "transformer_blocks" in blob and _max_idx(keys, r"transformer_blocks[._](\d+)") >= 9:
        return {"family": "qwen-image", "detail": "transformer_blocks bez single-bloków"}
    return {"family": "unknown", "detail": ""}


class Registry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.models: list[dict] = []
        self.loras: list[dict] = []

    def scan(self) -> tuple[int, int]:
        s = get_settings()
        models: list[dict] = []
        seen: set[str] = set()
        for d in s.model_dirs:
            tmp: list[dict] = []
            _scan_model_dir(Path(d), tmp)
            for e in tmp:
                if e["path"] in seen:
                    continue
                seen.add(e["path"])
                models.append(e)
        # unikalne id
        ids: set[str] = set()
        for e in models:
            base, n = e["id"], 2
            while e["id"] in ids:
                e["id"] = f"{base}-{n}"; n += 1
            ids.add(e["id"])
        # checkpointy wymagają bazy tej samej rodziny i wymiaru
        for e in models:
            if e["kind"] == "checkpoint" and e["status"] == "ready":
                base = next((b for b in models if b["kind"] == "base" and b["status"] == "ready" and b["family"] == e["family"]
                             and (not e.get("hidden") or not b.get("hidden") or b["hidden"] == e["hidden"])), None)
                if base:
                    e["base_id"] = base["id"]
                    e["is_distilled"] = base.get("is_distilled", True)
                    e["turbo"] = base.get("turbo", False) or "turbo" in e["name"].lower()
                else:
                    e["status"] = "unsupported"
                    e["unsupported_reason"] = "Samodzielny checkpoint wymaga zainstalowanego modelu bazowego tej samej rodziny (koder tekstu i VAE)."
        loras: list[dict] = []
        lseen: set[str] = set()
        for d in s.lora_dirs:
            root = Path(d)
            if not root.is_dir():
                continue
            for f in sorted(root.rglob("*.safetensors")):
                if str(f) in lseen:
                    continue
                lseen.add(str(f))
                try:
                    size = f.stat().st_size
                    if size > MAX_LORA_BYTES:
                        continue
                    sn = sniff_lora(f)
                except Exception as ex:
                    loras.append({"id": f"lora:{_hash(f)}", "name": f.stem, "path": str(f), "size_bytes": 0, "family": "unknown",
                                  "compatible_model_ids": [], "status": "unknown", "reason": f"Nie udało się odczytać: {ex}",
                                  "default_strength": 1.0})
                    continue
                loras.append({"id": f"lora:{_hash(f)}", "name": f.stem, "path": str(f), "size_bytes": size, "family": sn["family"],
                              "detail": sn.get("detail", ""), "hidden": sn.get("hidden", 0), "default_strength": 1.0})
        for l in loras:
            if "status" in l:
                continue
            compat = [m["id"] for m in models if m["status"] == "ready" and m["family"] == l["family"]
                      and (l["family"] != "flux2-klein" or not l.get("hidden") or not m.get("hidden") or l["hidden"] == m["hidden"])]
            l["compatible_model_ids"] = compat
            if compat:
                l["status"], l["reason"] = "ready", None
            elif l["family"] in ("unknown",):
                l["status"], l["reason"] = "unknown", "Nie rozpoznano architektury LoRA."
            else:
                names = {"qwen-image": "Qwen Image", "flux1-or-dev": "FLUX.1 / FLUX.2 dev", "flux2-klein": "FLUX.2 Klein", "z-image": "Z-Image"}
                l["status"] = "incompatible"
                l["reason"] = f"LoRA do architektury {names.get(l['family'], l['family'])} — brak zgodnego, zainstalowanego modelu."
        with self._lock:
            self.models, self.loras = models, loras
        return len(models), len(loras)

    def get_model(self, mid: str) -> dict | None:
        with self._lock:
            return next((m for m in self.models if m["id"] == mid), None)

    def get_lora(self, lid: str) -> dict | None:
        with self._lock:
            return next((l for l in self.loras if l["id"] == lid), None)


registry = Registry()
