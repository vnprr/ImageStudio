"""Image Studio — FastAPI. Uruchom: python -m uvicorn backend.app:app --port 8765"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import string
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import diffusers
import psutil
import torch
from fastapi import FastAPI, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from . import db, downloads, library
from .config import PORT, ROOT, Settings, get_settings, library_dir, save_settings
from .engine import capabilities, engine, gpu_stats, model_notes
from .jobs import JobManager
from .registry import registry

DEFAULTS = Path(__file__).parent / "defaults"
DIST = ROOT / "frontend" / "dist"


# ───────────────────────── SSE ─────────────────────────

class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.subs: set[asyncio.Queue] = set()

    def emit(self, event: str, data: dict) -> None:            # wołane z dowolnego wątku
        if self.loop is None:
            return
        payload = (event, json.dumps(data, ensure_ascii=False, default=str))
        self.loop.call_soon_threadsafe(self._push, payload)

    def _push(self, payload: tuple[str, str]) -> None:
        for q in list(self.subs):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(payload)


hub = Hub()
jobs: JobManager
dl: downloads.Downloads


def system_stats() -> dict:
    vm = psutil.virtual_memory()
    cuda = torch.cuda.is_available()
    return {
        "gpu": gpu_stats(),
        "process": {"vram_allocated": torch.cuda.memory_allocated() if cuda else 0,
                    "vram_reserved": torch.cuda.memory_reserved() if cuda else 0,
                    "ram_rss": psutil.Process(os.getpid()).memory_info().rss},
        "ram": {"total": vm.total, "used": vm.total - vm.available},
        "disk": {"models_free": downloads.free_bytes(downloads.target_root()), "library_free": downloads.free_bytes(library_dir())},
        "versions": {"torch": torch.__version__, "hip": torch.version.hip, "diffusers": diffusers.__version__,
                     "python": platform.python_version()},
        "active_model_id": engine.loaded_id,
        "queue": jobs.counts(),
    }


def maybe_idle_unload() -> None:
    """Tryb „po czasie": zwolnij model po N minutach bez zadań (nie rusza modelu, gdy trwa generowanie lub ładowanie)."""
    st = get_settings()
    if st.unload_mode != "idle" or engine.loaded_id is None or jobs.running_id or jobs.counts()["queued"]:
        return
    if time.monotonic() - engine.last_used < st.unload_idle_minutes * 60:
        return
    if engine.lock.acquire(blocking=False):
        try:
            engine.unload()
        finally:
            engine.lock.release()
        hub.emit("models", {})


@asynccontextmanager
async def lifespan(app: FastAPI):
    global jobs, dl
    hub.loop = asyncio.get_running_loop()
    db.conn()
    get_settings()
    registry.scan()
    jobs = JobManager(hub.emit)
    dl = downloads.Downloads(hub.emit, lambda: (registry.scan(), hub.emit("models", {})))

    async def ticker():
        while True:
            await asyncio.sleep(2)
            await run_in_threadpool(maybe_idle_unload)
            if hub.subs:
                try:
                    hub.emit("system", await run_in_threadpool(system_stats))
                except Exception:
                    pass
    task = asyncio.create_task(ticker())
    yield
    task.cancel()
    engine.unload()                                          # zamknięcie programu = zwolnienie modelu z VRAM/RAM


app = FastAPI(title="Image Studio", lifespan=lifespan)


def _model_info(e: dict) -> dict:
    return {"id": e["id"], "name": e["name"], "family": e["family"], "kind": e["kind"], "path": e["path"],
            "size_bytes": e["size_bytes"], "status": e["status"], "unsupported_reason": e.get("unsupported_reason"),
            "loaded": engine.loaded_id == e["id"], "loading": engine.loading_id == e["id"],
            "capabilities": capabilities(e) if e["status"] == "ready" else None, "license": e.get("license"),
            "notes": model_notes(e) if e["status"] == "ready" else None}


def _lora_info(l: dict) -> dict:
    return {k: l.get(k) for k in ("id", "name", "path", "size_bytes", "family", "compatible_model_ids", "status", "reason", "default_strength")}


# ───────────────────────── system / settings ─────────────────────────

@app.get("/api/system")
async def get_system():
    return await run_in_threadpool(system_stats)


@app.get("/api/events")
async def events():
    q: asyncio.Queue = asyncio.Queue(maxsize=300)

    async def gen():
        hub.subs.add(q)
        try:
            yield "retry: 2000\n\n"
            yield f"event: system\ndata: {json.dumps(await run_in_threadpool(system_stats))}\n\n"
            for j in jobs.list():
                if j["status"] in ("queued", "running"):
                    yield f"event: job\ndata: {json.dumps(j, default=str)}\n\n"
            while True:
                try:
                    ev, data = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"event: {ev}\ndata: {data}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            hub.subs.discard(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/settings")
def api_get_settings():
    return get_settings()


@app.put("/api/settings")
def api_put_settings(s: Settings):
    save_settings(s)
    registry.scan()
    hub.emit("models", {})
    return get_settings()


@app.get("/api/fs/list")
def fs_list(path: str = ""):
    if not path:
        if sys.platform == "win32":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
            return {"path": "", "parent": None, "entries": [{"name": d, "path": d, "is_dir": True} for d in drives]}
        path = str(Path.home())
    p = Path(path)
    if not p.is_dir():
        raise HTTPException(404, "Folder nie istnieje.")
    entries = []
    try:
        for c in sorted(p.iterdir(), key=lambda x: x.name.lower()):
            try:
                if c.is_dir() and not c.name.startswith(("$", ".")):
                    entries.append({"name": c.name, "path": str(c), "is_dir": True})
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(403, "Brak dostępu do folderu.")
    parent = str(p.parent) if p.parent != p else ""
    return {"path": str(p), "parent": parent, "entries": entries}


# ───────────────────────── modele / LoRA / pobieranie ─────────────────────────

@app.get("/api/models")
def api_models():
    return [_model_info(e) for e in registry.models]


@app.get("/api/loras")
def api_loras():
    return [_lora_info(l) for l in registry.loras]


@app.post("/api/rescan")
def api_rescan():
    m, l = registry.scan()
    hub.emit("models", {})
    return {"models": m, "loras": l}


@app.post("/api/models/unload")
def api_unload():
    if jobs.running_id:
        raise HTTPException(409, "Trwa generowanie — poczekaj na koniec zadania.")
    engine.unload()
    hub.emit("models", {})
    return {}


@app.post("/api/models/{mid}/load")
async def api_load(mid: str):
    e = registry.get_model(mid)
    if not e:
        raise HTTPException(404, "Nie znaleziono modelu.")
    if e["status"] != "ready":
        raise HTTPException(400, e.get("unsupported_reason") or "Model nieobsługiwany.")

    def work():
        engine.load(e)

    hub.emit("models", {})
    try:
        task = asyncio.create_task(run_in_threadpool(work))
        await asyncio.sleep(0.3)
        hub.emit("models", {})
        await task
    except Exception as ex:                                      # noqa: BLE001
        hub.emit("models", {})
        raise HTTPException(500, f"Nie udało się załadować modelu: {ex}")
    hub.emit("models", {})
    return _model_info(e)


@app.get("/api/catalog")
def api_catalog():
    installed = {Path(m["path"]).name.lower() for m in registry.models}
    out = []
    for c in downloads.CATALOG:
        out.append({**c, "license": "apache-2.0", "installed": c["repo_id"].split("/")[-1].lower() in installed})
    return out


@app.get("/api/hf/inspect")
async def api_inspect(repo: str):
    try:
        return await run_in_threadpool(downloads.inspect, repo.strip())
    except PermissionError as ex:
        raise HTTPException(403, str(ex))
    except LookupError as ex:
        raise HTTPException(404, str(ex))
    except Exception as ex:                                      # noqa: BLE001
        raise HTTPException(502, str(ex))


class DownloadReq(BaseModel):
    repo_id: str


@app.post("/api/downloads")
async def api_start_download(r: DownloadReq):
    try:
        return await run_in_threadpool(dl.start, r.repo_id.strip())
    except (ValueError, PermissionError, OSError) as ex:
        raise HTTPException(400, str(ex))
    except Exception as ex:                                      # noqa: BLE001
        raise HTTPException(502, str(ex))


@app.get("/api/downloads")
def api_downloads():
    return dl.list()


@app.delete("/api/downloads/{did}")
def api_cancel_download(did: str):
    d = dl.stop(did)
    if not d:
        raise HTTPException(404, "Nie ma takiego pobierania.")
    return d


# ───────────────────────── generowanie ─────────────────────────

class InputRef(BaseModel):
    upload_id: str | None = None
    image_id: str | None = None


class LoraUse(BaseModel):
    id: str
    name: str | None = None
    strength: float = 1.0


class GenReq(BaseModel):
    model_id: str
    mode: Literal["t2i", "edit", "multi", "inpaint"] = "t2i"
    prompt: str = Field(default="", max_length=20000)
    negative_prompt: str | None = ""
    width: int = 1024
    height: int = 1024
    steps: int = 4
    cfg: float | None = None
    seed: int = -1
    batch: int = 1
    sampler: str | None = None
    scheduler: str | None = None
    denoise: float | None = None
    loras: list[LoraUse] = []
    source: InputRef | None = None
    references: list[InputRef] = []
    mask: str | None = None
    tag: str | None = None


@app.post("/api/uploads")
async def api_upload(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return await run_in_threadpool(library.save_upload, data, file.filename or "upload")
    except Exception:
        raise HTTPException(400, "To nie jest poprawny plik obrazu.")


@app.get("/api/uploads/{uid}")
def api_get_upload(uid: str):
    u = library.upload_info(uid)
    if not u or not u["path"].exists():
        raise HTTPException(404)
    return FileResponse(u["path"], media_type="image/png")


@app.post("/api/jobs")
def api_submit(r: GenReq):
    d = r.model_dump()
    d["source"] = {k: v for k, v in (d["source"] or {}).items() if v} or None
    d["references"] = [{k: v for k, v in x.items() if v} for x in d["references"]]
    try:
        return jobs.submit(d)
    except ValueError as ex:
        raise HTTPException(400, str(ex))


@app.get("/api/jobs")
def api_jobs():
    return jobs.list()


@app.get("/api/jobs/{jid}")
def api_job(jid: str):
    j = jobs.jobs.get(jid)
    if not j:
        raise HTTPException(404, "Nie ma takiego zadania.")
    return j


@app.delete("/api/jobs/{jid}")
def api_cancel_job(jid: str):
    j = jobs.cancel(jid)
    if not j:
        raise HTTPException(404, "Nie ma takiego zadania.")
    return j


# ───────────────────────── biblioteka ─────────────────────────

@app.get("/api/images")
def api_images(query: str = "", filter: Literal["all", "favorite", "hidden"] = "all", sort: Literal["new", "old"] = "new",
               model_id: str | None = None, limit: int = 60, offset: int = 0):
    return library.list_images(query, filter, sort, model_id, limit, offset)


@app.get("/api/library/stats")
def api_lib_stats():
    return library.stats()


@app.post("/api/images/import")
async def api_import(files: list[UploadFile] = File(...)):
    out = []
    for f in files:
        data = await f.read()
        try:
            out.append(await run_in_threadpool(library.import_image, data, f.filename or "import"))
        except Exception:
            raise HTTPException(400, f"Plik „{f.filename}” nie jest poprawnym obrazem.")
    hub.emit("library", {})
    return out


@app.get("/api/images/{iid}")
def api_image(iid: str):
    r = library.get_image(iid)
    if not r:
        raise HTTPException(404, "Nie znaleziono obrazu.")
    return r


@app.get("/api/images/{iid}/file")
def api_image_file(iid: str):
    p = library.image_path(iid)
    if not p or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/images/{iid}/thumb")
def api_image_thumb(iid: str):
    p = library.thumb_path(iid)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


class ImagePatch(BaseModel):
    favorite: bool | None = None
    hidden: bool | None = None


@app.patch("/api/images/{iid}")
def api_image_patch(iid: str, p: ImagePatch):
    r = library.patch_image(iid, p.favorite, p.hidden)
    if not r:
        raise HTTPException(404)
    hub.emit("library", {})
    return r


@app.delete("/api/images/{iid}")
def api_image_delete(iid: str):
    if not library.delete_image(iid):
        raise HTTPException(404)
    hub.emit("library", {})
    return {}


@app.get("/api/images/{iid}/download")
def api_image_download(iid: str, format: Literal["png", "jpeg", "webp"] = "png", quality: int = 92, metadata: int = 1):
    try:
        data, mime, name = library.render_export(iid, format, quality, bool(metadata))
    except FileNotFoundError:
        raise HTTPException(404)
    return Response(data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'})


class ExportReq(BaseModel):
    format: Literal["png", "jpeg", "webp"] = "png"
    quality: int = 92
    dest_dir: str
    filename: str | None = None
    metadata: bool = True


@app.post("/api/images/{iid}/export")
def api_image_export(iid: str, r: ExportReq):
    try:
        return {"path": library.export_to_dir(iid, r.format, r.quality, r.metadata, r.dest_dir, r.filename)}
    except FileNotFoundError:
        raise HTTPException(404)
    except OSError as ex:
        raise HTTPException(400, f"Nie można zapisać w tym folderze: {ex}")


# ───────────────────────── presety i biblioteka promptów ─────────────────────────

BUILTIN_PRESETS = [
    {"id": "builtin-fast", "name": "Szybki", "builtin": True, "model_id": None,
     "values": {"steps": 4, "batch": 1, "ratio": "1:1", "resolution": 768, "mode": "t2i"}},
    {"id": "builtin-photo", "name": "Fotorealizm", "builtin": True, "model_id": None,
     "values": {"steps": 8, "batch": 1, "ratio": "4:5", "resolution": 1024, "mode": "t2i"}},
    {"id": "builtin-illustration", "name": "Ilustracja", "builtin": True, "model_id": None,
     "values": {"steps": 6, "batch": 1, "ratio": "3:2", "resolution": 1024, "mode": "t2i"}},
    {"id": "builtin-quality", "name": "Jakość", "builtin": True, "model_id": None,
     "values": {"steps": 10, "batch": 1, "ratio": "4:5", "resolution": 1280, "mode": "t2i"}},
    {"id": "builtin-edit", "name": "Edycja", "builtin": True, "model_id": None,
     "values": {"steps": 6, "denoise": 0.6, "mode": "edit", "ratio": "4:5", "resolution": 1024}},
]


@app.get("/api/presets")
def api_presets():
    rows = db.conn().execute("SELECT data FROM presets ORDER BY rowid").fetchall()
    return BUILTIN_PRESETS + [json.loads(r["data"]) for r in rows]


@app.put("/api/presets/{pid}")
def api_preset_put(pid: str, body: dict):
    if pid.startswith("builtin-"):
        raise HTTPException(400, "Presety wbudowane są tylko do odczytu.")
    body = {**body, "id": pid, "builtin": False}
    if not str(body.get("name", "")).strip():
        raise HTTPException(400, "Podaj nazwę presetu.")
    c = db.conn()
    c.execute("INSERT INTO presets(id,name,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, data=excluded.data",
              (pid, body["name"], json.dumps(body, ensure_ascii=False)))
    c.commit()
    return body


@app.delete("/api/presets/{pid}")
def api_preset_delete(pid: str):
    if pid.startswith("builtin-"):
        raise HTTPException(400, "Presetów wbudowanych nie można usunąć.")
    db.conn().execute("DELETE FROM presets WHERE id=?", (pid,))
    db.conn().commit()
    return {}


@app.get("/api/prompt-library")
def api_plib_get():
    doc = db.kv_get("prompt_library")
    if doc is None:
        doc = json.loads((DEFAULTS / "prompt_library.json").read_text("utf-8"))
        db.kv_set("prompt_library", doc)
    return doc


@app.put("/api/prompt-library")
def api_plib_put(doc: dict):
    if not isinstance(doc.get("snippets"), list) or not isinstance(doc.get("packs"), list):
        raise HTTPException(400, "Dokument musi zawierać pola snippets i packs.")
    db.kv_set("prompt_library", {"snippets": doc["snippets"], "packs": doc["packs"]})
    return {}


# ───────────────────────── frontend (produkcyjnie) ─────────────────────────

if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
