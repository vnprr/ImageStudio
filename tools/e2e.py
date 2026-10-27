"""Testy end-to-end przeciw działającemu backendowi (http://127.0.0.1:8765). Wypisuje czasy i pamięć, zapisuje tools/e2e_report.json.

  python tools/e2e.py [model_id] [--long N] [--lora PATH_ID]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests
from PIL import Image, ImageDraw

B = "http://127.0.0.1:8765/api"
OUT = Path(__file__).parent
report: list[dict] = []


def get(p, **k):
    r = requests.get(B + p, timeout=60, **k); r.raise_for_status(); return r.json()


def post(p, js=None, **k):
    r = requests.post(B + p, json=js, timeout=600, **k)
    if r.status_code >= 400:
        raise RuntimeError(f"{p}: {r.status_code} {r.text[:300]}")
    return r.json()


def gb(x): return f"{(x or 0) / 2**30:.2f} GB"


def run_job(name: str, req: dict, timeout=1800) -> dict:
    t0 = time.perf_counter()
    j = post("/jobs", req)
    last = ""
    while True:
        j = get(f"/jobs/{j['id']}")
        s = f"{j['stage']} {j['step']}/{j['total_steps']}"
        if s != last and j["status"] == "running":
            last = s
        if j["status"] in ("done", "error", "cancelled"):
            break
        if time.perf_counter() - t0 > timeout:
            raise TimeoutError(name)
        time.sleep(0.4)
    wall = time.perf_counter() - t0
    tm = j.get("timings") or {}
    row = {"test": name, "status": j["status"], "wall_s": round(wall, 2), "error": j.get("error"),
           "load": round(tm.get("load", 0), 2), "encode": round(tm.get("encode", 0), 2), "denoise": round(tm.get("denoise", 0), 2),
           "vae": round(tm.get("vae", 0), 2), "save": round(tm.get("save", 0), 2), "cold": tm.get("cold"),
           "peak_vram": gb(tm.get("peak_vram")), "peak_ram": gb(tm.get("peak_ram")), "images": j["result_image_ids"], "w": req["width"], "h": req["height"], "steps": req["steps"]}
    report.append(row)
    print(f"{name:34s} {j['status']:6s} wall {wall:6.1f}s | load {row['load']:5.1f} enc {row['encode']:5.1f} den {row['denoise']:6.1f} "
          f"vae {row['vae']:5.1f} save {row['save']:4.1f} | VRAM peak {row['peak_vram']} RAM {row['peak_ram']}"
          + (f" ERR {j['error']}" if j.get("error") else ""))
    return j


def upload(img: Image.Image, name: str) -> str:
    p = OUT / name
    img.save(p)
    with open(p, "rb") as f:
        return requests.post(B + "/uploads", files={"file": (name, f, "image/png")}).json()["upload_id"]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    long_n = int(args[args.index("--long") + 1]) if "--long" in args else 0
    small = "--small" in args                      # testy funkcjonalne w 512 px (szybkie także przy obciążonym GPU)
    A, Bz, C = (512, 512, 512) if small else (512, 768, 1024)
    lora_id = args[args.index("--lora") + 1] if "--lora" in args else None
    sysinfo = get("/system")
    print("1) GPU:", sysinfo["gpu"]["name"], sysinfo["gpu"]["arch"], sysinfo["gpu"]["backend"], "available =", sysinfo["gpu"]["available"],
          "| VRAM", gb(sysinfo["gpu"]["vram_total"]), "| torch", sysinfo["versions"]["torch"], "hip", sysinfo["versions"]["hip"])
    assert sysinfo["gpu"]["available"] and sysinfo["gpu"]["backend"] == "rocm"
    models = get("/models")
    mid = next((a for a in args if not a.startswith("--") and any(m["id"] == a for m in models)), None) or \
        next(m["id"] for m in models if m["family"] == "flux2-klein" and m["status"] == "ready")
    m = next(x for x in models if x["id"] == mid)
    print("   model:", mid, m["capabilities"]["modes"])
    P = "a red fox sitting in a snowy forest at dawn, soft golden light, detailed fur, 85mm photo"
    base = dict(model_id=mid, mode="t2i", prompt=P, negative_prompt="", steps=m["capabilities"]["steps"]["default"], cfg=None,
                seed=1234, batch=1, loras=[])

    print("\n2/3) Zimny start + rozdzielczości")
    r512 = run_job(f"t2i {A} (cold)", {**base, "width": A, "height": A})
    if not small:
        run_job("t2i 768", {**base, "width": 768, "height": 768})
    r1024 = run_job(f"t2i {C}", {**base, "width": C, "height": C})
    print("\n6) Ponowna generacja bez przeładowania")
    run_job("same prompt new seed", {**base, "width": C, "height": C, "seed": 99})
    run_job("new prompt", {**base, "width": C, "height": C, "prompt": P + ", cinematic"})
    j_same = run_job("same seed (determinism)", {**base, "width": C, "height": C})
    a = requests.get("http://127.0.0.1:8765" + get(f"/images/{r1024['result_image_ids'][0]}")["url"]).content
    b = requests.get("http://127.0.0.1:8765" + get(f"/images/{j_same['result_image_ids'][0]}")["url"]).content
    import io
    pa, pb = Image.open(io.BytesIO(a)).convert("RGB"), Image.open(io.BytesIO(b)).convert("RGB")
    import numpy as np
    dd = np.abs(np.asarray(pa, dtype=np.int16) - np.asarray(pb, dtype=np.int16))
    print("   ten sam seed → identyczne piksele:", pa.tobytes() == pb.tobytes(), f"| różnica: średnio {dd.mean():.3f}/255, max {dd.max()}, "
          f"pikseli różnych {100 * (dd.sum(-1) > 0).mean():.1f}% | rozmiar PNG", len(a))

    if "edit" in m["capabilities"]["modes"]:
        print("\n4) Edycja i referencje")
        src = {"image_id": r1024["result_image_ids"][0]}
        run_job("edit", {**base, "mode": "edit", "width": Bz, "height": Bz, "source": src,
                              "prompt": "make it night time with a full moon"})
        ref2 = upload(Image.new("RGB", (512, 512), (200, 40, 40)), "ref_red.png")
        if m["capabilities"]["max_refs"] >= 2:
            run_job("multi 2 refs", {**base, "mode": "multi", "width": Bz, "height": Bz, "source": src,
                                          "references": [{"upload_id": ref2}], "prompt": "the fox wearing a red scarf"})
        if "inpaint" in m["capabilities"]["modes"]:
            mk = Image.new("L", (C, C), 0)
            ImageDraw.Draw(mk).ellipse((C * 3 // 10, C * 3 // 10, C * 7 // 10, C * 7 // 10), fill=255)
            mid_up = upload(mk, "mask.png")
            run_job("inpaint", {**base, "mode": "inpaint", "width": C, "height": C, "source": src, "mask": mid_up,
                                      "denoise": 0.9, "prompt": "a glowing blue crystal"})

    if lora_id:
        print("\n5) LoRA")
        run_job("t2i + LoRA", {**base, "width": Bz, "height": Bz, "loras": [{"id": lora_id, "strength": 0.8}]})
        run_job("t2i LoRA strength 0.3", {**base, "width": Bz, "height": Bz, "loras": [{"id": lora_id, "strength": 0.3}]})
        run_job("t2i LoRA off again", {**base, "width": Bz, "height": Bz})

    print("\n7/8) Biblioteka i odtwarzanie ustawień")
    rec = get(f"/images/{r1024['result_image_ids'][0]}")
    need = ["prompt", "model_id", "model_name", "seed", "steps", "cfg", "sampler", "scheduler", "width", "height", "gen_seconds", "timings", "request", "sources", "loras"]
    print("   brakujące pola:", [k for k in need if k not in rec] or "brak")
    png = Image.open(__import__("io").BytesIO(requests.get("http://127.0.0.1:8765" + rec["url"]).content))
    print("   PNG tEXt:", sorted(png.info.keys()), "| parameters:", png.info.get("parameters", "")[:80].replace("\n", " | "))
    replay = run_job("replay of record.request", rec["request"])
    c = requests.get("http://127.0.0.1:8765" + get(f"/images/{replay['result_image_ids'][0]}")["url"]).content
    pc = Image.open(io.BytesIO(c)).convert("RGB")
    print("   odtworzony z biblioteki obraz identyczny z oryginałem (piksele):", pc.tobytes() == pa.tobytes())
    print("   lista:", get("/images?limit=3")["total"], "obrazów; stats:", get("/library/stats"))

    if "--switch" in args:
        other = args[args.index("--switch") + 1]
        om = next(x for x in models if x["id"] == other)
        print(f"\n9a) Zmiana modelu {mid} → {other} → {mid} (zwolnienie pamięci i ładowanie, bez restartu)")
        ob = dict(model_id=other, mode="t2i", prompt=P, negative_prompt="", steps=om["capabilities"]["steps"]["default"], cfg=None,
                  seed=7, batch=1, loras=[], width=768, height=768)
        run_job(f"switch → {other} (cold)", ob)
        run_job(f"{other} warm", {**ob, "seed": 8})
        run_job(f"switch → {mid} (cold)", {**base, "width": 768, "height": 768, "seed": 9})
        run_job(f"{mid} warm", {**base, "width": 768, "height": 768, "seed": 10})
        s = get("/system"); print("   po przełączaniu: VRAM zajęte (system)", gb(s["gpu"]["vram_used"]), "| proces zarezerwował", gb(s["process"]["vram_reserved"]), "| RAM RSS", gb(s["process"]["ram_rss"]))

    if long_n:
        print(f"\n9) Praca ciągła: {long_n} generacji 768 px, zmiana seedów/promptów")
        vr, rm = [], []
        for i in range(long_n):
            run_job(f"long #{i + 1}", {**base, "width": 768, "height": 768, "seed": 5000 + i, "prompt": f"{P}, variation {i}"})
            s = get("/system"); vr.append(s["process"]["vram_reserved"]); rm.append(s["process"]["ram_rss"])
        print(f"   VRAM reserved: start {gb(vr[0])} → koniec {gb(vr[-1])} (max {gb(max(vr))}); RAM RSS: {gb(rm[0])} → {gb(rm[-1])} (max {gb(max(rm))})")

    (OUT / "e2e_report.json").write_text(json.dumps(report, indent=1), "utf-8")
    print("\nRaport:", OUT / "e2e_report.json")


if __name__ == "__main__":
    main()
