"""Kontrola silnika bez serwera: LoRA (czas, powrót do czystej bazy), inpainting, edycja.  python tools/engine_checks.py [model_id]"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import torch  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from backend.engine import Timer, engine  # noqa: E402
from backend.registry import registry  # noqa: E402

OUT = Path(__file__).parent
mid = sys.argv[1] if len(sys.argv) > 1 else "flux-2-klein-4b"
registry.scan()
e = registry.get_model(mid)
t0 = time.perf_counter()
engine.load(e)
print(f"load {time.perf_counter() - t0:.1f}s")
steps = 4 if e["family"] == "flux2-klein" else 8
P = "a red fox sitting in a snowy forest at dawn, soft golden light, detailed fur, 85mm photo"


def gen(tag, loras=(), mode="t2i", w=768, source=None, refs=(), mask=None, denoise=None, prompt=P, seed=1234):
    tm = Timer()
    req = dict(mode=mode, prompt=prompt, negative_prompt="", width=w, height=w, steps=steps, cfg=None, denoise=denoise)
    t = time.perf_counter()
    for img, s, secs in engine.generate(req, list(loras), source, list(refs), mask, [seed], lambda *a: None, lambda: False, tm):
        pass
    img.save(OUT / f"chk_{tag}.png")
    print(f"{tag:22s} {time.perf_counter() - t:5.1f}s  enc {tm.t['encode']:.1f} den {tm.t['denoise']:.1f} vae {tm.t['vae']:.2f}  peakVRAM {torch.cuda.max_memory_allocated() / 2**30:.1f}GB", flush=True)
    return np.asarray(img, dtype=np.int16)


def diff(a, b):
    d = np.abs(a - b)
    return f"mean {d.mean():.3f} max {d.max()}"


A = gen("base")
loras = [l for l in registry.loras if l["status"] == "ready" and e["id"] in l["compatible_model_ids"]]
if loras:
    L1 = (loras[0], 0.8)
    x = gen("lora1_first_use", [L1])
    print("   LoRA vs baza:", diff(A, x), "(musi się różnić)")
    gen("lora1_cached", [L1])
    gen("lora1_strength_0.4", [(loras[0], 0.4)])
    B = gen("base_after_lora")
    print("   baza po LoRA vs baza przed:", diff(A, B), "(powinno być 0)")
    if len(loras) > 1:
        gen("two_loras", [L1, (loras[1], 0.6)])
        C = gen("base_after_two")
        print("   baza po 2 LoRA vs baza przed:", diff(A, C))
else:
    print("(brak zgodnych LoRA)")

src = Image.fromarray(A.astype(np.uint8))
caps = e and __import__("backend.engine", fromlist=["capabilities"]).capabilities(e)
if "edit" in caps["modes"]:
    gen("edit", mode="edit", source=src, w=768, prompt="make it night time with a full moon, keep the fox", denoise=0.6)
if "multi" in caps["modes"]:
    ref = Image.new("RGB", (512, 512), (30, 60, 200))
    gen("multi", mode="multi", source=src, refs=[ref], w=768, prompt="the fox wearing a blue scarf")
if "inpaint" in caps["modes"]:
    m = Image.new("L", (768, 768), 0)
    ImageDraw.Draw(m).ellipse((230, 230, 540, 540), fill=255)
    out = gen("inpaint", mode="inpaint", source=src, mask=m, w=768, prompt="a glowing blue crystal", denoise=0.95)
    keep = np.asarray(m) == 0
    print("   inpaint: piksele spoza maski vs źródło:", diff(A[keep], out[keep]), "| wewnątrz maski:", diff(A[~keep], out[~keep]))
print("OK")
