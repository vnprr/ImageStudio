"""Kolejka zadań generowania (jeden wątek roboczy = jedno zadanie GPU naraz)."""
from __future__ import annotations

import json
import queue
import threading
import time
import traceback
import uuid
from typing import Callable

import torch
from PIL import Image

from . import db, library
from .config import get_settings
from .engine import Cancelled, Timer, capabilities, engine, _rss
from .registry import registry

MODES = {"t2i", "edit", "multi", "inpaint"}


class JobManager:
    def __init__(self, emit: Callable[[str, dict], None]) -> None:
        self.emit = emit
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.q: queue.Queue[str] = queue.Queue()
        self.cancel_flags: dict[str, bool] = {}
        self.running_id: str | None = None
        self._last_emit = 0.0
        threading.Thread(target=self._worker, name="gen-worker", daemon=True).start()

    # ───── API ─────
    def submit(self, req: dict) -> dict:
        self._validate(req)
        jid = uuid.uuid4().hex[:10]
        job = {"id": jid, "status": "queued", "request": req, "stage": "queued", "step": 0, "total_steps": req["steps"],
               "image_index": 0, "image_count": req["batch"], "fraction": 0.0, "message": None, "queue_position": None,
               "result_image_ids": [], "timings": None, "error": None, "created_at": int(time.time() * 1000),
               "started_at": None, "finished_at": None}
        self.jobs[jid] = job
        self.order.append(jid)
        self.q.put(jid)
        self._renumber()
        self._publish(job, force=True)
        return job

    def cancel(self, jid: str) -> dict | None:
        job = self.jobs.get(jid)
        if not job:
            return None
        if job["status"] == "queued":
            job.update(status="cancelled", stage="done", message="Anulowano", finished_at=int(time.time() * 1000))
            self._renumber()
            self._publish(job, force=True)
        elif job["status"] == "running":
            self.cancel_flags[jid] = True
            job["message"] = "Anulowanie…"
            self._publish(job, force=True)
        return job

    def list(self) -> list[dict]:
        return [self.jobs[j] for j in self.order[-60:]]

    def counts(self) -> dict:
        return {"running": 1 if self.running_id else 0, "queued": sum(1 for j in self.jobs.values() if j["status"] == "queued")}

    # ───── walidacja ─────
    def _validate(self, req: dict) -> None:
        m = registry.get_model(req["model_id"])
        if not m:
            raise ValueError("Nie znaleziono wybranego modelu.")
        if m["status"] != "ready":
            raise ValueError(f"Model nie jest obsługiwany: {m.get('unsupported_reason') or 'brak powodu'}")
        caps = capabilities(m)
        if req["mode"] not in MODES or req["mode"] not in caps["modes"]:
            raise ValueError("Wybrany model nie obsługuje tego trybu pracy.")
        r = caps["resolution"]
        for k in ("width", "height"):
            v = req[k]
            if v < r["min"] or v > r["max"] or v % r["multiple"]:
                raise ValueError(f"Wymiary muszą mieścić się w {r['min']}–{r['max']} px i być wielokrotnością {r['multiple']}.")
        req["steps"] = max(caps["steps"]["min"], min(int(req["steps"]), caps["steps"]["max"]))
        req["batch"] = max(1, min(int(req["batch"]), caps["max_batch"]))
        if req["mode"] in ("edit", "inpaint") and not req.get("source") and not (req["mode"] == "edit" and req.get("references")):
            raise ValueError("Ten tryb wymaga obrazu źródłowego.")
        if req["mode"] == "multi" and not (req.get("references") or req.get("source")):
            raise ValueError("Tryb referencji wymaga co najmniej jednego obrazu.")
        if req["mode"] == "inpaint" and not req.get("mask"):
            raise ValueError("Inpainting wymaga narysowanej maski.")
        if len(req.get("references") or []) > caps["max_refs"] and req["mode"] != "t2i":
            raise ValueError(f"Ten model przyjmuje maksymalnie {caps['max_refs']} obrazów referencyjnych.")
        for l in req.get("loras") or []:
            lo = registry.get_lora(l["id"])
            if not lo:
                raise ValueError("Nie znaleziono wybranej LoRA.")
            if m["id"] not in lo.get("compatible_model_ids", []):
                raise ValueError(f"LoRA „{lo['name']}” nie jest zgodna z modelem {m['name']}.")

    # ───── wątek roboczy ─────
    def _renumber(self) -> None:
        pos = 1
        for jid in self.order:
            j = self.jobs[jid]
            if j["status"] == "queued":
                j["queue_position"] = pos; pos += 1
            else:
                j["queue_position"] = None

    def _publish(self, job: dict, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_emit > 0.08:
            self._last_emit = now
            self.emit("job", job)

    def _worker(self) -> None:
        while True:
            jid = self.q.get()
            job = self.jobs.get(jid)
            if not job or job["status"] != "queued":
                continue
            self.running_id = jid
            self._renumber()
            try:
                self._run(job)
            except Cancelled:
                job.update(status="cancelled", stage="done", message="Anulowano")
            except BaseException as ex:                          # noqa: BLE001 — błąd zadania nie zabija wątku
                traceback.print_exc()
                job.update(status="error", stage="done", error=str(ex) or ex.__class__.__name__, message=None)
                if isinstance(ex, torch.OutOfMemoryError) or "out of memory" in str(ex).lower():
                    job["error"] = "Brak pamięci VRAM. Zmniejsz rozdzielczość lub liczbę obrazów referencyjnych."
                    torch.cuda.empty_cache()
            finally:
                job["finished_at"] = int(time.time() * 1000)
                self.running_id = None
                self.cancel_flags.pop(jid, None)
                engine.last_used = time.monotonic()
                if get_settings().unload_mode == "after_job" and self.q.empty():
                    engine.unload()
                self._renumber()
                self._publish(job, force=True)
                self.emit("library", {})
                self.emit("models", {})

    def _open(self, ref: dict | None) -> tuple[Image.Image | None, dict | None]:
        if not ref:
            return None, None
        if ref.get("upload_id"):
            u = library.upload_info(ref["upload_id"])
            if not u:
                raise RuntimeError("Nie znaleziono wgranego obrazu (upload) — dodaj go ponownie.")
            return Image.open(u["path"]).convert("RGB"), {"image_id": None, "name": u["name"], "upload_id": ref["upload_id"]}
        p = library.image_path(ref.get("image_id", ""))
        if not p or not p.exists():
            raise RuntimeError("Nie znaleziono obrazu źródłowego w bibliotece.")
        return Image.open(p).convert("RGB"), {"image_id": ref["image_id"], "name": None}

    @staticmethod
    def _mask(upload_id: str) -> Image.Image:
        u = library.upload_info(upload_id)
        if not u:
            raise RuntimeError("Nie znaleziono maski — narysuj ją ponownie.")
        im = Image.open(u["path"])
        if "A" in im.getbands():
            a = im.getchannel("A")
            if a.getextrema() != (255, 255):
                return a
        return im.convert("L")

    def _run(self, job: dict) -> None:
        req = job["request"]
        jid = job["id"]
        entry = registry.get_model(req["model_id"])
        job.update(status="running", started_at=int(time.time() * 1000), stage="loading", message="Przygotowanie…")
        self._publish(job, force=True)
        t_job = time.perf_counter()
        cancelled = lambda: self.cancel_flags.get(jid, False)           # noqa: E731

        src, src_meta = self._open(req.get("source"))
        refs, ref_meta = [], []
        for r in req.get("references") or []:
            im, meta = self._open(r); refs.append(im); ref_meta.append(meta)
        mask = self._mask(req["mask"]) if req.get("mask") else None
        loras = [(registry.get_lora(l["id"]), float(l["strength"])) for l in req.get("loras") or []]
        sources = ([{"role": "source", **src_meta}] if src_meta else []) + [{"role": "reference", **m} for m in ref_meta]
        if req.get("mask"):
            sources.append({"role": "mask", "image_id": None, "name": "mask", "upload_id": req["mask"]})

        tm = Timer()
        with engine.lock:
            if cancelled():
                raise Cancelled()
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            cold = engine.loaded_id != entry["id"]
            if cold:
                job["message"] = f"Ładowanie modelu {entry['name']}…"
                self._publish(job, force=True)
            tm.t["load"] = engine.load(entry, on_msg=lambda m: (job.update(message=m), self._publish(job, force=True)))
            tm.sample_ram()
            job.update(stage="encoding", message="Kodowanie promptu…")
            self._publish(job, force=True)

            n = req["batch"]
            base_seed = req["seed"] if req["seed"] >= 0 else int.from_bytes(uuid.uuid4().bytes[:4], "big")
            seeds = [base_seed + i for i in range(n)]
            job["image_count"] = n

            def on_step(idx: int, step: int, total: int) -> None:
                job.update(stage="denoising" if step < total else "decoding", image_index=idx, step=step, total_steps=total,
                           fraction=(idx + step / total) / n * 0.98, message=None)
                self._publish(job)

            gen = engine.generate(req, loras, src, refs, mask, seeds, on_step, cancelled, tm)
            prev = {**tm.t, "load": 0.0}           # czas ładowania liczymy do pierwszego obrazu
            scheduler_name = type(engine.pipe.scheduler).__name__.replace("Scheduler", "")
            for idx in range(n):
                job.update(image_index=idx, step=0, stage="encoding" if idx == 0 else "denoising")
                img, seed, secs = next(gen)
                job.update(stage="saving", message="Zapisywanie…")
                self._publish(job, force=True)
                t_save = time.perf_counter()
                delta = {k: tm.t[k] - prev[k] for k in tm.t}
                prev = dict(tm.t)
                peak_vram = torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0
                per = {**delta, "save": 0.0, "total": 0.0, "cold": cold and idx == 0, "peak_vram": peak_vram,
                       "peak_ram": max(tm.peak_ram, _rss())}
                eff_req = {**req, "seed": seed, "batch": 1}
                rec = {"prompt": req["prompt"], "negative_prompt": req.get("negative_prompt") or "", "model_id": entry["id"],
                       "model_name": entry["name"], "mode": req["mode"],
                       "loras": [{"id": l["id"], "name": l["name"], "strength": s} for l, s in loras],
                       "seed": seed, "steps": req["steps"], "cfg": req.get("cfg") if engine_cfg_active(entry) else None,
                       "sampler": "Euler (flow match)", "scheduler": scheduler_name,
                       "denoise": req.get("denoise") if req["mode"] in (capabilities(entry)["denoise"] or {"modes": []})["modes"] else None,
                       "gen_seconds": round(secs + (delta["load"] + delta["encode"]), 3), "sources": sources, "request": eff_req,
                       "timings": per}
                saved = library.save_image(img, rec, embed=get_settings().embed_metadata_png)
                per["save"] = time.perf_counter() - t_save
                per["total"] = sum(per[k] for k in ("load", "encode", "denoise", "vae", "save"))
                # zapisz pełne czasy (z czasem zapisu) w bazie
                db.conn().execute("UPDATE images SET timings_json=?, gen_seconds=? WHERE id=?",
                                  (json.dumps(per), round(per["total"] - per["save"], 3), saved["id"]))
                db.conn().commit()
                tm.t["save"] += per["save"]
                job["result_image_ids"].append(saved["id"])
                job.update(fraction=(idx + 1) / n * 0.98)
                self._publish(job, force=True)
                self.emit("library", {})
            tm.sample_ram()
            total = time.perf_counter() - t_job
            job["timings"] = {**tm.t, "total": total, "cold": cold,
                              "peak_vram": torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0,
                              "peak_ram": max(tm.peak_ram, _rss())}
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        job.update(status="done", stage="done", fraction=1.0, message=None)


def engine_cfg_active(entry: dict) -> bool:
    return bool(capabilities(entry)["cfg"])
