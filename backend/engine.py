"""Silnik generowania: Diffusers + PyTorch ROCm. Model zostaje w pamięci między zadaniami.

Rezydencja komponentów (16 GB VRAM, 64 GB RAM):
  • transformer + VAE trzymane na GPU stale (brak przenoszenia przy każdej generacji),
  • koder tekstu (Qwen3, ~8 GB) czeka w RAM i jest strumieniowany na GPU tylko podczas kodowania promptu; embeddingi są cache'owane,
    więc ponowna generacja z tym samym promptem (inny seed, wariant) w ogóle go nie rusza,
  • jeśli wszystko mieści się w VRAM (tryb `gpu`), nic nie jest przenoszone.
Własne zarządzanie zamiast enable_model_cpu_offload(): ten kończy każde wywołanie zrzutem całego modelu do RAM.
"""
from __future__ import annotations

import gc
import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator

import numpy as np
import psutil
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

from . import fastattn
from . import qwen21
from .config import DATA, get_settings

GB = 2**30
DEV = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
fastattn.install()        # SDPA bez klifu wydajności na RDNA2 (tylko ROCm)
VRAM_FRACTION = 0.93      # twardy limit alokatora: lepszy czytelny błąd niż ciche wylewanie VRAM do RAM (WDDM) = 30× wolniej
if DEV.type == "cuda":
    torch.cuda.set_per_process_memory_fraction(VRAM_FRACTION)
BF16_FILE = DATA / "dtype_overrides.json"
MAX_ADAPTERS = 8


class Cancelled(Exception):
    pass


# ───────────────────────── możliwości modeli ─────────────────────────

def capabilities(e: dict) -> dict | None:
    fam = e["family"]
    res = {"min": 256, "max": 2048, "multiple": 16, "presets": [512, 768, 1024, 1280, 1536], "default": 1024}
    if fam == "flux2-klein":
        if e.get("is_distilled", True):
            return {"modes": ["t2i", "edit", "multi", "inpaint"], "steps": {"min": 1, "max": 12, "default": 4}, "cfg": None,
                    "negative_prompt": False,
                    "denoise": {"min": 0.1, "max": 1.0, "step": 0.05, "default": 0.85, "modes": ["inpaint"]},
                    "sampler": None, "scheduler": None, "max_batch": 4, "max_refs": 4, "resolution": res, "lora": True}
        return {"modes": ["t2i", "edit", "multi", "inpaint"], "steps": {"min": 8, "max": 80, "default": 30},
                "cfg": {"min": 1.0, "max": 10.0, "step": 0.5, "default": 4.0}, "negative_prompt": False,
                "denoise": {"min": 0.1, "max": 1.0, "step": 0.05, "default": 0.85, "modes": ["inpaint"]},
                "sampler": None, "scheduler": None, "max_batch": 4, "max_refs": 4, "resolution": res, "lora": True}
    if fam == "qwen-image-21":
        # bez inpaintingu (pipeline Diffusers go nie ma); obrazy wejściowe widzi koder Qwen3-VL i VAE; domyślnie 12 kroków, bez CFG
        r32 = {**res, "multiple": 32}
        return {"modes": ["t2i", "edit", "multi"], "steps": {"min": 1, "max": 40, "default": 12}, "cfg": None,
                "negative_prompt": False, "denoise": None, "sampler": None, "scheduler": None, "max_batch": 4, "max_refs": 3,
                "resolution": r32, "lora": True}
    if fam == "z-image":
        turbo = e.get("turbo", True)
        return {"modes": ["t2i", "edit", "inpaint"], "steps": {"min": 1, "max": 20 if turbo else 60, "default": 8 if turbo else 28},
                "cfg": None if turbo else {"min": 1.0, "max": 10.0, "step": 0.5, "default": 4.0},
                "negative_prompt": not turbo,
                "denoise": {"min": 0.1, "max": 1.0, "step": 0.05, "default": 0.65, "modes": ["edit", "inpaint"]},
                "sampler": None, "scheduler": None, "max_batch": 4, "max_refs": 0, "resolution": res, "lora": True}
    return None


def model_notes(e: dict) -> str | None:
    if e["family"] == "flux2-klein":
        return ("Destylowany: 4 kroki, CFG nieaktywne. Edycja i multi-reference przez obrazy referencyjne."
                if e.get("is_distilled", True) else "Wariant bazowy: więcej kroków i aktywne CFG.")
    if e["family"] == "qwen-image-21":
        return (f"GGUF {e.get('quant', '')}: transformer i koder Qwen3-VL skwantyzowane, obliczenia w fp32. Bez CFG, domyślnie 12 kroków. "
                "Edycja i referencje przez obrazy wejściowe (do 3 + obraz do edycji), bez inpaintingu.")
    if e["family"] == "z-image":
        return "Turbo: ok. 8 kroków, CFG nieaktywne (guidance = 0)." if e.get("turbo", True) else "Wariant bazowy: CFG i negatywny prompt aktywne."
    return None


# ───────────────────────── pomiary ─────────────────────────

def _sync() -> None:
    if DEV.type == "cuda":
        torch.cuda.synchronize()


def _rss() -> int:
    return psutil.Process(os.getpid()).memory_info().rss


def gpu_stats() -> dict:
    if DEV.type != "cuda":
        return {"name": "CPU", "arch": None, "backend": "cpu", "available": False, "vram_total": 0, "vram_used": 0, "vram_free": 0}
    free, total = torch.cuda.mem_get_info()
    p = torch.cuda.get_device_properties(0)
    return {"name": p.name, "arch": getattr(p, "gcnArchName", None), "backend": "rocm" if torch.version.hip else "cuda",
            "available": True, "vram_total": total, "vram_used": total - free, "vram_free": free}


def _module_bytes(m: torch.nn.Module) -> int:
    return sum(p.numel() * p.element_size() for p in m.parameters())


@dataclass
class Timer:
    t: dict = field(default_factory=lambda: {"load": 0.0, "encode": 0.0, "denoise": 0.0, "vae": 0.0, "save": 0.0})
    peak_ram: int = 0

    def sample_ram(self) -> None:
        self.peak_ram = max(self.peak_ram, _rss())


# ───────────────────────── silnik ─────────────────────────

class Fp32Linear(torch.nn.Linear):
    """Waga zostaje w fp16 (pamięć), mnożenie macierzy liczone w fp32. Na RDNA2 fp32 daje ~18 TFLOPS wobec ~7 dla bf16
    (brak natywnego bf16), a ma pełny zakres — modele z aktywacjami >65504 (np. Z-Image) przepełniają fp16."""

    def forward(self, x):
        return F.linear(x.float(), self.weight.float(), None if self.bias is None else self.bias.float())


def to_fp32_compute(model: torch.nn.Module) -> None:
    for m in model.modules():
        if isinstance(m, torch.nn.Linear):
            m.__class__ = Fp32Linear
        else:
            for t in (*m.parameters(recurse=False), *m.buffers(recurse=False)):
                if t.is_floating_point():
                    t.data = t.data.float()
    model.__class__ = type(model.__class__.__name__, (model.__class__,), {"dtype": property(lambda s: torch.float32)})


class Q8Linear(torch.nn.Linear):
    """Wagi int8 (per kanał wyjściowy) + obliczenia w fp32. Zmniejsza transformer o połowę względem fp16 (Z-Image: 12,2 → 6,1 GB),
    co daje zapas VRAM — przy 13+ GB zajętych z 16 inne aplikacje wywołują stronicowanie WDDM i krok zwalnia 10–80×."""

    def forward(self, x):
        y = F.linear(x.float(), self.weight.float()) * self.scale.view(1, -1)
        return y if self.bias is None else y + self.bias.float()


@torch.no_grad()
def quantize_int8(model: torch.nn.Module) -> None:
    for m in model.modules():
        if isinstance(m, Fp32Linear):
            w = m.weight.data.float()
            scale = (w.abs().amax(dim=1, keepdim=True).clamp_min(1e-8) / 127.0)
            m.weight = torch.nn.Parameter((w / scale).round().clamp_(-127, 127).to(torch.int8), requires_grad=False)
            m.register_buffer("scale", scale.squeeze(1).contiguous(), persistent=False)
            m.__class__ = Q8Linear
            del w, scale


class TextEncoderStreamer:
    """Koder tekstu żyje w RAM; do VRAM trafia grupa po grupie (warstwa dekodera, embeddingi, norma, lm_head) tylko na czas jej
    forwardu, a potem kopia GPU jest zwalniana (bez transferu zwrotnego). Zwykłe hooki PyTorcha — bez `_hf_hook`, bo
    diffusers po wykryciu hooków accelerate przełącza CAŁY pipeline w sequential offload przy ładowaniu LoRA."""

    def __init__(self, te: torch.nn.Module, pin: bool = True) -> None:
        self.cpu: dict[int, tuple[torch.Tensor, torch.Tensor]] = {}     # id(tensor) -> (tensor, kopia w RAM)
        self.pin = pin
        te.to("cpu")
        te.register_forward_pre_hook(self._inputs_to_gpu, with_kwargs=True)      # input_ids/attention_mask → GPU
        for g in self._groups(te):
            tensors = [*g.parameters(), *g.buffers()]
            for t in tensors:
                if id(t) not in self.cpu:
                    self.cpu[id(t)] = (t, t.data.pin_memory() if pin else t.data)
                    t.data = self.cpu[id(t)][1]
            g.register_forward_pre_hook(lambda m, a, ts=tensors: self._load(ts))
            g.register_forward_hook(lambda m, a, out, ts=tensors: self._free(ts))

    @staticmethod
    def _inputs_to_gpu(_m, args, kwargs):
        mv = lambda x: x.to(DEV) if isinstance(x, torch.Tensor) else x          # noqa: E731
        return tuple(mv(a) for a in args), {k: mv(v) for k, v in kwargs.items()}

    @staticmethod
    def _groups(m: torch.nn.Module) -> list[torch.nn.Module]:
        out: list[torch.nn.Module] = []
        for name, ch in m.named_children():
            if isinstance(ch, torch.nn.ModuleList):
                out += list(ch)
            elif name == "model":
                out += TextEncoderStreamer._groups(ch)
            else:
                out.append(ch)
        return out

    def _load(self, ts) -> None:
        for t in ts:
            t.data = self.cpu[id(t)][1].to(DEV, non_blocking=True)

    def _free(self, ts) -> None:
        for t in ts:
            t.data = self.cpu[id(t)][1]


class Engine:
    def __init__(self) -> None:
        self.lock = threading.RLock()          # jedna operacja GPU naraz
        self.entry: dict | None = None
        self.pipe = None
        self.pipes: dict[str, object] = {}
        self.adapters: OrderedDict[str, str] = OrderedDict()     # lora_id -> nazwa adaptera
        self.streamer = None
        self.lora_key: tuple = ()                                # aktualnie aktywny zestaw (id, siła)
        self.lora_fused = False
        self.quantized = False                                   # wagi transformera w int8 (bez fuse LoRA)
        self.base_snapshot: dict[str, torch.Tensor] | None = None  # dokładna kopia wag transformera (RAM) do przywrócenia po fuse
        self.embeds: OrderedDict[str, object] = OrderedDict()
        self.loading_id: str | None = None
        self.last_used = time.monotonic()                        # ostatnia aktywność (do zwalniania po bezczynności)
        self._loading_entry_id: str | None = None
        self.residency = "gpu"                                   # gpu | text-swap
        self.dtype = torch.float16               # dtype transformera (embeddingi są do niego rzutowane)
        self.safe_ids: set[str] = set(self._read_safe_ids())   # modele, w których fp16 daje NaN/czarny obraz → tryb fp32-compute
        self._vae_time = 0.0
        self._encode_time = 0.0                  # czas kodowania promptu wewnątrz pipeline'u (Qwen koduje przy każdym wywołaniu)

    # ----- stan -----
    @property
    def loaded_id(self) -> str | None:
        return self.entry["id"] if self.pipe is not None and self.entry else None

    @staticmethod
    def _read_safe_ids() -> list[str]:
        try:
            return json.loads(BF16_FILE.read_text("utf-8"))
        except Exception:
            return []

    def _mark_safe(self, mid: str) -> None:
        self.safe_ids.add(mid)
        BF16_FILE.parent.mkdir(parents=True, exist_ok=True)
        BF16_FILE.write_text(json.dumps(sorted(self.safe_ids)), "utf-8")

    def _dtype_map(self, model_id: str | None = None) -> dict:
        """RDNA2 nie ma natywnego bf16: matmul ~5× i conv ~8× wolniej niż fp16. Dlatego domyślnie transformer i VAE w fp16
        (VAE w fp16 zmierzone: różnica ≤1/255 względem fp32, a szybsze), koder tekstu bf16 (fp16 potrafi się w nim przepełniać)."""
        if get_settings().precision == "bf16":
            return {"default": torch.bfloat16}
        return {"default": torch.float16, "text_encoder": torch.bfloat16}

    # ----- ładowanie / zwalnianie -----
    def unload(self) -> None:
        with self.lock:
            self.pipes.clear()
            self.pipe = None
            self.entry = None
            self.adapters.clear()
            self.embeds.clear()
            self.lora_key, self.lora_fused, self.base_snapshot, self.streamer, self.quantized = (), False, None, None, False
            gc.collect()
            if DEV.type == "cuda":
                torch.cuda.empty_cache()
                if hasattr(torch._C, "_host_emptyCache"):
                    torch._C._host_emptyCache()          # cache pinned RAM (koder tekstu, ok. 8 GB) inaczej zostaje w procesie

    def load(self, entry: dict, on_msg: Callable[[str], None] | None = None) -> float:
        """Załaduj model (zwalniając poprzedni). Zwraca czas w s; 0 gdy już załadowany."""
        with self.lock:
            if self.loaded_id == entry["id"]:
                return 0.0
            t0 = time.perf_counter()
            self.loading_id = entry["id"]
            try:
                self.unload()
                say = on_msg or (lambda m: None)
                say(f"Ładowanie modelu {entry['name']}…")
                self.dtype = self._dtype_map(entry["id"])["default"]
                if entry["family"] == "qwen-image-21":
                    self.dtype = torch.float32           # Qwen Image 2.1 przepełnia fp16, a bf16 jest na RDNA2 wolniejsze od fp32
                base_entry = entry
                if entry["kind"] == "checkpoint":
                    from .registry import registry
                    base_entry = registry.get_model(entry["base_id"]) or entry
                self._loading_entry_id = entry["id"]
                try:
                    pipe = self._from_pretrained(base_entry)
                except (ValueError, OSError, TypeError) as ex:      # zdarzają się przejściowe błędy odczytu plików modelu (JSONDecodeError, gguf)
                    print(f"[engine] ładowanie nieudane ({ex}); ponawiam raz", flush=True)
                    gc.collect(); time.sleep(1.5)
                    pipe = self._from_pretrained(base_entry)
                if entry["kind"] == "checkpoint":
                    say("Wczytywanie checkpointu transformera…")
                    cls = type(pipe.transformer)
                    tr = cls.from_single_file(entry["path"], config=base_entry["path"], subfolder="transformer", torch_dtype=self.dtype)
                    pipe.register_modules(transformer=tr)
                say("Przenoszenie na GPU…")
                self._place(pipe)
                if entry["id"] in self.safe_ids and get_settings().precision != "bf16" and entry["family"] != "qwen-image-21":
                    say("Tryb bezpieczny: obliczenia w fp32 (model przepełnia fp16)…")
                    to_fp32_compute(pipe.transformer)
                    pipe.vae.to(torch.float32)           # dekoder VAE też przepełnia fp16 (Z-Image) — fp32 jest szybki i tani
                    self.dtype = torch.float32
                    if _module_bytes(pipe.transformer) > 9 * GB:
                        say("Kwantyzacja wag transformera do int8 (oszczędność VRAM)…")
                        quantize_int8(pipe.transformer)
                        self.quantized = True
                        gc.collect(); torch.cuda.empty_cache()
                self.pipe = self._patch(pipe)
                self.pipes = {"base": self.pipe}
                self.entry = entry
                _sync()
                self.last_used = time.monotonic()
                return time.perf_counter() - t0
            except BaseException:
                self.unload()
                raise
            finally:
                self.loading_id = None

    def _from_pretrained(self, e: dict):
        if e["family"] == "flux2-klein":
            from diffusers import Flux2KleinPipeline as P
        elif e["family"] == "z-image":
            from diffusers import ZImagePipeline as P
        elif e["family"] == "qwen-image-21":
            paths = qwen21.find_bundle(Path(e["path"]))
            if not paths:
                raise RuntimeError("Brak plików modelu Qwen Image 2.1 (model/, text_encoder/, mmproj/, vae/).")
            return qwen21.build_pipeline(paths, DATA, torch.float32)
        else:
            raise RuntimeError(f"Nieobsługiwana rodzina modelu: {e['family']}")
        return P.from_pretrained(e["path"], torch_dtype=self._dtype_map(self._loading_entry_id), low_cpu_mem_usage=True)

    def _place(self, pipe) -> None:
        """transformer + VAE na GPU; koder tekstu w RAM, chyba że całość mieści się w VRAM."""
        mode = get_settings().offload
        tot = sum(_module_bytes(m) for m in (pipe.transformer, pipe.vae, pipe.text_encoder))
        free = torch.cuda.mem_get_info()[0]
        fits = tot + 2.5 * GB < free
        if type(pipe).__name__ == "QwenImage21Pipeline":
            # transformer (GGUF, ok. 4 GB) i VAE na GPU; koder Qwen3-VL (ok. 6,6 GB) wraca do RAM po każdym kodowaniu promptu
            self.residency = "text-swap"
            pipe.transformer.to(DEV)
            pipe.vae.to(DEV)
            qwen21.tune_vae(pipe.vae)
            qwen21.attach_text_swap(pipe, DEV, on_time=self._add_encode_time)
            self.quantized = True                 # wagi GGUF: LoRA zawsze jako osobna gałąź (bez fuse)
        elif mode == "gpu" or (mode == "auto" and fits):
            self.residency = "gpu"
            pipe.to(DEV)
        else:
            # koder tekstu (~8 GB) zostaje w RAM i jest strumieniowany do VRAM grupa po grupie, więc 7 GB transformera
            # nigdy nie musi opuszczać GPU
            self.residency = "text-stream"
            pipe.transformer.to(DEV)
            pipe.vae.to(DEV)
            t0 = time.perf_counter()
            self.streamer = TextEncoderStreamer(pipe.text_encoder)
            print(f"[engine] koder tekstu w pinned RAM: {time.perf_counter() - t0:.1f}s", flush=True)
            gc.collect()
        # kafelkowanie VAE (kafel 512 px): ogranicza zapotrzebowanie MIOpen na workspace (przy 1024 px fp32 prosił o 4,5 GiB)
        # i daje stałe kształty konwolucji niezależnie od rozdzielczości obrazu
        if hasattr(pipe.vae, "enable_tiling"):
            pipe.vae.enable_tiling()
            if not type(pipe).__name__ == "QwenImage21Pipeline":
                pipe.vae.tile_sample_min_size = 512
                pipe.vae.tile_latent_min_size = 512 // 8
        orig = pipe.vae.decode
        eng = self

        def timed_decode(z, *a, **k):                   # dokładny czas VAE niezależnie od pipeline'u
            _sync(); t = time.perf_counter()
            try:
                return orig(z.to(pipe.vae.dtype), *a, **k)
            finally:
                _sync(); eng._vae_time += time.perf_counter() - t
        pipe.vae.decode = timed_decode

    @staticmethod
    def _patch(pipe):
        """Wymuś urządzenie wykonania (komponenty są rozproszone między GPU i CPU, bez hooków accelerate)."""
        pipe.__class__ = type(pipe.__class__.__name__, (pipe.__class__,), {"_execution_device": property(lambda s: DEV)})
        return pipe

    def _add_encode_time(self, dt: float) -> None:
        self._encode_time += dt

    def _pipe(self, mode: str):
        fam = self.entry["family"]
        if fam == "qwen-image-21":
            return self.pipe
        key = {"inpaint": "inpaint", "edit": "img2img" if fam == "z-image" else "base"}.get(mode, "base")
        if key in self.pipes:
            return self.pipes[key]
        if fam == "flux2-klein":
            from diffusers import Flux2KleinInpaintPipeline as P
        elif key == "inpaint":
            from diffusers import ZImageInpaintPipeline as P
        else:
            from diffusers import ZImageImg2ImgPipeline as P
        # NIE from_pipe(): kończy się .to(dtype=float32) na wspólnych komponentach (transformer → fp32, OOM, popsuty stan)
        extra = {"is_distilled": bool(self.pipe.config.is_distilled)} if fam == "flux2-klein" else {}
        p = self._patch(P(**self.pipe.components, **extra))
        self.pipes[key] = p
        return p

    # ----- LoRA -----
    def _snapshot_base(self) -> None:
        """Przed pierwszym scaleniem LoRA zapisz dokładną kopię wag transformera w RAM (ok. 7 GB dla Klein)."""
        if self.base_snapshot is None:
            self.base_snapshot = {n.replace(".base_layer", ""): p.data.to("cpu", copy=True)
                                  for n, p in self.pipe.transformer.named_parameters() if "lora_" not in n}

    @torch.no_grad()
    def _restore_base(self) -> None:
        if self.base_snapshot is None:
            return
        for n, p in self.pipe.transformer.named_parameters():
            src = self.base_snapshot.get(n.replace(".base_layer", ""))
            if src is not None and "lora_" not in n:
                p.data.copy_(src)

    def _apply_loras(self, loras: list[tuple[dict, float]]) -> None:
        """Przełącza zestaw LoRA bez przeładowania pipeline'u.
        Aktywny zestaw jest scalany z wagami (fuse) → zero narzutu na krok (PEFT bez fuse: +60% czasu).
        Zmiana zestawu = unfuse + przywrócenie dokładnych wag z kopii w RAM → nowy fuse. Brak LoRA = czysta baza (unload)."""
        pipe = self.pipe
        key = tuple((l["id"], round(float(w), 4)) for l, w in loras)
        if key == self.lora_key:
            return
        if self.lora_fused:
            pipe.unfuse_lora(components=["transformer"])
            self.lora_fused = False
            self._restore_base()                         # unfuse w fp16 zostawia błąd zaokrągleń → wracamy do dokładnych wag
        if not loras:
            if self.adapters:
                pipe.unload_lora_weights()
                self.adapters.clear()
            self.lora_key = key
            return
        names, weights = [], []
        for l, strength in loras:
            name = self.adapters.get(l["id"])
            if name is None:
                name = "a" + hashlib.sha1(l["id"].encode()).hexdigest()[:10]
                try:
                    src = qwen21.convert_lora(l["path"]) if self.entry["family"] == "qwen-image-21" else l["path"]
                    pipe.load_lora_weights(src, adapter_name=name)
                except Exception as ex:
                    raise RuntimeError(f"Nie udało się wczytać LoRA „{l['name']}”: {ex}") from ex
                self.adapters[l["id"]] = name
            self.adapters.move_to_end(l["id"])
            names.append(name); weights.append(float(strength))
        while len(self.adapters) > MAX_ADAPTERS:        # usuń najdawniej użyty adapter spoza bieżącego zestawu
            old = next((k for k in self.adapters if self.adapters[k] not in names), None)
            if old is None:
                break
            pipe.delete_adapters(self.adapters.pop(old))
        pipe.set_adapters(names, adapter_weights=weights)
        try:
            if self.quantized:
                raise RuntimeError("wagi int8 — LoRA działa jako osobna gałąź")
            self._snapshot_base()
            pipe.fuse_lora(components=["transformer"], adapter_names=names, safe_fusing=True)
            self.lora_fused = True
        except Exception as ex:                          # np. NaN przy scalaniu → zostaje wolniejsza ścieżka PEFT
            print(f"[engine] fuse_lora nieudane ({ex}); używam adapterów PEFT bez scalania", flush=True)
        self.lora_key = key

    # ----- kodowanie promptu -----
    def _encode(self, prompt: str, negative: str, cfg_on: bool, tm: Timer):
        fam = self.entry["family"]
        key = f"{self.entry['id']}|{prompt}|{negative if cfg_on else ''}|{cfg_on}"
        if key in self.embeds:
            self.embeds.move_to_end(key)
            return self.embeds[key]
        _sync(); t = time.perf_counter()
        with torch.no_grad():
            if fam == "flux2-klein":
                emb = self.pipe.encode_prompt(prompt=prompt, device=DEV)[0].detach().to("cpu")
            else:
                pe, ne = self.pipe.encode_prompt(prompt=prompt, device=DEV, do_classifier_free_guidance=cfg_on,
                                                 negative_prompt=negative or None)
                emb = ([x.detach().to("cpu") for x in pe], [x.detach().to("cpu") for x in ne] if ne else [])
        _sync(); tm.t["encode"] += time.perf_counter() - t
        self.embeds[key] = emb
        while len(self.embeds) > 16:
            self.embeds.popitem(last=False)
        return emb

    # ----- generowanie -----
    def generate(self, req: dict, loras: list[tuple[dict, float]], source: Image.Image | None, refs: list[Image.Image],
                 mask: Image.Image | None, seeds: list[int], on_step: Callable[[int, int, int], None],
                 should_cancel: Callable[[], bool], tm: Timer) -> Iterator[tuple[Image.Image, int, float]]:
        """Generator: dla każdego seeda → (obraz, seed, sekundy). Wywołuj pod `engine.lock`."""
        e = self.entry
        caps = capabilities(e)
        mode = req["mode"]
        w, h = int(req["width"]), int(req["height"])
        steps = int(req["steps"])
        cfg = req.get("cfg")
        cfg_on = bool(caps["cfg"]) and cfg is not None and float(cfg) > 1.0
        self._apply_loras(loras)
        pipe = self._pipe(mode)
        qwen = e["family"] == "qwen-image-21"
        emb = None if qwen else self._encode(req["prompt"], req.get("negative_prompt") or "", cfg_on, tm)
        tm.sample_ram()

        if source is not None and mode in ("edit", "inpaint"):
            src_fit = ImageOps.fit(source.convert("RGB"), (w, h), Image.LANCZOS)
        mask_fit = ImageOps.fit(mask.convert("L"), (w, h), Image.BILINEAR) if mask is not None else None

        def build(idx: int, seed: int, state: dict, _emb) -> dict:
            gen = torch.Generator("cpu").manual_seed(int(seed) & 0x7FFFFFFFFFFFFFFF)

            def cb(_p, i, _t, kw):
                if should_cancel():
                    raise Cancelled()
                _sync(); state["last"] = time.perf_counter()
                on_step(idx, i + 1, steps)
                tm.sample_ram()
                return kw

            kw = dict(height=h, width=w, num_inference_steps=steps, generator=gen, callback_on_step_end=cb)
            if qwen:
                # prompt i obrazy koduje sam pipeline (koder Qwen3-VL widzi obrazy wejściowe razem z tekstem)
                kw["prompt"] = req["prompt"]
                kw["output_resolution"] = max(512, int((w * h) ** 0.5) // 32 * 32)
                if mode in ("edit", "multi"):
                    ims = ([source.convert("RGB")] if source is not None else []) + [r.convert("RGB") for r in refs]
                    if not ims:
                        raise RuntimeError("Tryb edycji wymaga obrazu źródłowego lub referencji.")
                    kw["image"] = ims
                    # Pipeline skaluje każdy obraz wejściowy do ok. output_resolution². Klucze i wartości obrazów trafiają do cache KV
                    # (ok. 1 GB na każde 1000 tokenów w fp32), więc budżet tokenów dzielimy między obrazy wejściowe.
                    kw["output_resolution"] = max(384, int(kw["output_resolution"] / len(ims) ** 0.5) // 32 * 32)
            elif e["family"] == "flux2-klein":
                kw["prompt_embeds"] = _emb.to(DEV, self.dtype)
                kw["guidance_scale"] = float(cfg) if cfg_on else 1.0
                if mode in ("edit", "multi"):
                    ims = ([source.convert("RGB")] if source is not None else []) + [r.convert("RGB") for r in refs]
                    if not ims:
                        raise RuntimeError("Tryb edycji wymaga obrazu źródłowego lub referencji.")
                    kw["image"] = ims
                elif mode == "inpaint":
                    kw.update(image=src_fit, mask_image=mask_fit, strength=float(req.get("denoise") or 0.85))
                    if refs:
                        kw["image_reference"] = [r.convert("RGB") for r in refs]
            else:  # z-image
                pe, ne = _emb
                kw.update(prompt_embeds=[x.to(DEV, self.dtype) for x in pe],
                          negative_prompt_embeds=[x.to(DEV, self.dtype) for x in ne] if ne else None,
                          guidance_scale=float(cfg) if cfg_on else 0.0)
                if mode == "edit":
                    kw.update(image=src_fit, strength=float(req.get("denoise") or 0.65))
                elif mode == "inpaint":
                    kw.update(image=src_fit, mask_image=mask_fit, strength=float(req.get("denoise") or 1.0))
            return kw

        def call(pipe_, kw) -> Image.Image:
            for attempt in (1, 2):
                self._vae_time = 0.0
                try:
                    with torch.no_grad():
                        self._encode_time = 0.0
                        img = pipe_(**kw).images[0]
                        tm.t["encode"] += self._encode_time
                        return img
                except torch.OutOfMemoryError as ex:
                    gc.collect(); torch.cuda.empty_cache()          # zwolnij bufory podręczne i spróbuj raz jeszcze
                    if attempt == 2:
                        raise RuntimeError("Brak pamięci VRAM. Zmniejsz rozdzielczość lub liczbę obrazów referencyjnych "
                                           "albo zwolnij inne aplikacje używające GPU.") from ex

        for idx, seed in enumerate(seeds):
            state: dict = {"last": None}
            _sync()
            t_call = time.perf_counter()
            img = call(pipe, build(idx, seed, state, emb))
            if self.dtype == torch.float16 and not qwen and _degenerate(img):
                # fp16 dał NaN/czarny obraz → przełącz model na tryb fp32-compute (wolniej, ale poprawnie) i powtórz
                print("[engine] fp16 dał zdegenerowany obraz — przeładowanie w trybie bezpiecznym (fp32-compute)", flush=True)
                entry = self.entry
                self._mark_safe(entry["id"])
                pipe = img = emb = None                  # zwolnij referencje, inaczej stare wagi zostaną w VRAM
                self.unload()
                gc.collect()
                torch.cuda.empty_cache()
                self.load(entry)
                self._apply_loras(loras)
                pipe = self._pipe(mode)
                emb = self._encode(req["prompt"], req.get("negative_prompt") or "", cfg_on, tm)
                state = {"last": None}
                t_call = time.perf_counter()
                img = call(pipe, build(idx, seed, state, emb))
            _sync()
            t_end = time.perf_counter()
            tm.t["vae"] += self._vae_time
            tm.t["denoise"] += max(0.0, (state["last"] or t_call) - t_call)
            yield img, int(seed), t_end - t_call
            tm.sample_ram()


def _degenerate(img: Image.Image) -> bool:
    a = np.asarray(img.convert("RGB").resize((64, 64)), dtype=np.float32)
    return (not np.isfinite(a).all()) or float(a.std()) < 1.0

engine = Engine()
