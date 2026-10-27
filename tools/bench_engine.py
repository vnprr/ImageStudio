"""Benchmark silnika bez serwera: python tools/bench_engine.py [model_id] [bf16|fp16]"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import torch  # noqa: E402

from backend.config import get_settings, save_settings  # noqa: E402
from backend.engine import Timer, engine  # noqa: E402
from backend.registry import registry  # noqa: E402

mid = sys.argv[1] if len(sys.argv) > 1 else "flux-2-klein-4b"
prec = sys.argv[2] if len(sys.argv) > 2 else "auto"
s = get_settings(); s.precision = prec; save_settings(s)
registry.scan()
e = registry.get_model(mid)
t0 = time.perf_counter()
load = engine.load(e, on_msg=print)
print(f"LOAD {load:.1f}s  residency={engine.residency} dtype={engine.dtype} vram={torch.cuda.memory_allocated() / 2**30:.2f}GB")
P = "a red fox sitting in a snowy forest at dawn, soft golden light, detailed fur, 85mm photo"
steps = 4 if e["family"] == "flux2-klein" else 8
import os
for w in [int(x) for x in os.environ.get('BENCH_SIZES', '512,768,1024,1024,768').split(',')]:
    tm = Timer()
    torch.cuda.reset_peak_memory_stats()
    req = dict(mode="t2i", prompt=P, negative_prompt="", width=w, height=w, steps=steps, cfg=None)
    t = time.perf_counter()
    marks = []
    for img, seed, secs in engine.generate(req, [], None, [], None, [1234], lambda *a: marks.append(time.perf_counter()), lambda: False, tm):
        pass
    steps_t = [round(b - a, 2) for a, b in zip([t] + marks[:-1], marks)]
    print("   step times:", steps_t, "reserved %.1fGB" % (torch.cuda.memory_reserved() / 2**30))
    wall = time.perf_counter() - t
    print(f"{w}px wall {wall:6.2f}s | enc {tm.t['encode']:5.2f} den {tm.t['denoise']:6.2f} vae {tm.t['vae']:5.2f} "
          f"| peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f}GB  std={float(__import__('numpy').asarray(img).std()):.1f}")
    img.save(Path(__file__).parent / f"bench_{mid}_{w}.png")
# nowy prompt (cache embeddingów pudłuje)
tm = Timer()
req["prompt"] = P + ", cinematic"
for img, seed, secs in engine.generate(req, [], None, [], None, [7], lambda *a: None, lambda: False, tm):
    pass
print(f"new prompt 768: enc {tm.t['encode']:.2f}s den {tm.t['denoise']:.2f} vae {tm.t['vae']:.2f}")
