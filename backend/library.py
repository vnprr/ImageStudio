"""Trwała biblioteka: PNG na dysku + sidecar JSON + miniatura WebP + wiersz w SQLite."""
from __future__ import annotations

import io
import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, PngImagePlugin

from . import db
from .config import library_dir

THUMB_SIZE = 384
FORMATS = {"png": ("PNG", "image/png", "png"), "jpeg": ("JPEG", "image/jpeg", "jpg"), "webp": ("WEBP", "image/webp", "webp")}


def new_id() -> str:
    return uuid.uuid4().hex[:12]


# ───────────────────────── metadane ─────────────────────────

def a1111_text(r: dict) -> str:
    """Czytelny blok 'parameters' w stylu A1111 (rozpoznawany przez wiele narzędzi)."""
    req = r.get("request") or {}
    parts = [f"Steps: {r.get('steps')}"]
    if r.get("sampler"): parts.append(f"Sampler: {r['sampler']}")
    if r.get("scheduler"): parts.append(f"Schedule type: {r['scheduler']}")
    if r.get("cfg") is not None: parts.append(f"CFG scale: {r['cfg']}")
    parts += [f"Seed: {r.get('seed')}", f"Size: {r.get('width')}x{r.get('height')}", f"Model: {r.get('model_name')}"]
    if r.get("denoise") is not None: parts.append(f"Denoising strength: {r['denoise']}")
    if r.get("loras"):
        parts.append("Lora: " + ", ".join(f"{l.get('name') or l['id']}:{l['strength']}" for l in r["loras"]))
    neg = f"\nNegative prompt: {r['negative_prompt']}" if r.get("negative_prompt") else ""
    return f"{r.get('prompt', '')}{neg}\n" + ", ".join(parts)


def _png_info(rec: dict) -> PngImagePlugin.PngInfo:
    info = PngImagePlugin.PngInfo()
    info.add_text("parameters", a1111_text(rec))
    info.add_text("image-studio", json.dumps({k: rec[k] for k in (
        "prompt", "negative_prompt", "model_id", "model_name", "mode", "seed", "steps", "cfg", "sampler",
        "scheduler", "denoise", "width", "height", "loras", "gen_seconds", "request") if k in rec}, ensure_ascii=False))
    return info


def encode(img: Image.Image, fmt: str, quality: int = 92, meta: dict | None = None) -> bytes:
    """Zakoduj obraz do png/jpeg/webp; metadane: PNG tEXt, JPEG/WebP EXIF UserComment."""
    pil_fmt = FORMATS[fmt][0]
    buf = io.BytesIO()
    if fmt == "png":
        img.save(buf, "PNG", pnginfo=_png_info(meta) if meta else None, compress_level=6)
    else:
        im = img.convert("RGB")
        kw: dict[str, Any] = {"quality": int(quality)}
        if meta:
            exif = Image.Exif()
            exif[0x9286] = b"ASCII\x00\x00\x00" + a1111_text(meta).encode("utf-8", "replace")
            kw["exif"] = exif
        if fmt == "webp":
            kw["method"] = 4
        im.save(buf, pil_fmt, **kw)
    return buf.getvalue()


# ───────────────────────── zapis i odczyt ─────────────────────────

def _abs(rel: str) -> Path:
    return library_dir() / rel


def save_image(img: Image.Image, rec: dict, embed: bool = True, imported: bool = False) -> dict:
    """Zapisz obraz + sidecar + miniaturę + wiersz DB. `rec` to pola ImageRecord (bez url)."""
    iid = rec.get("id") or new_id()
    created = rec.get("created_at") or int(time.time() * 1000)
    sub = datetime.fromtimestamp(created / 1000).strftime("%Y-%m")
    rel = f"images/{sub}/{iid}.png"
    path = _abs(rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    rec = {**rec, "id": iid, "created_at": created, "width": img.width, "height": img.height}
    path.write_bytes(encode(img, "png", meta=rec if embed else None))
    path.with_suffix(".json").write_text(json.dumps(rec, ensure_ascii=False, indent=1), "utf-8")
    make_thumb(img, iid)

    loras = rec.get("loras") or []
    search = " ".join(str(x) for x in (rec.get("prompt"), rec.get("negative_prompt"), rec.get("model_name"),
                                       rec.get("mode"), rec.get("seed"), *[l.get("name") or l["id"] for l in loras])).lower()
    c = db.conn()
    c.execute("""INSERT INTO images(id,created_at,width,height,rel_path,prompt,negative_prompt,model_id,model_name,mode,
                 seed,steps,cfg,sampler,scheduler,denoise,gen_seconds,favorite,hidden,imported,loras_json,sources_json,
                 timings_json,request_json,search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (iid, created, rec["width"], rec["height"], rel, rec.get("prompt", ""), rec.get("negative_prompt", ""),
               rec.get("model_id"), rec.get("model_name"), rec.get("mode"), rec.get("seed"), rec.get("steps"),
               rec.get("cfg"), rec.get("sampler"), rec.get("scheduler"), rec.get("denoise"), rec.get("gen_seconds"),
               int(rec.get("favorite", False)), int(rec.get("hidden", False)), int(imported),
               json.dumps(loras, ensure_ascii=False), json.dumps(rec.get("sources") or [], ensure_ascii=False),
               json.dumps(rec.get("timings")) if rec.get("timings") else None,
               json.dumps(rec.get("request"), ensure_ascii=False) if rec.get("request") else None, search))
    c.commit()
    return get_image(iid)


def make_thumb(img: Image.Image, iid: str) -> None:
    t = img.convert("RGB")
    t.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
    p = library_dir() / "thumbs" / f"{iid}.webp"
    p.parent.mkdir(parents=True, exist_ok=True)
    t.save(p, "WEBP", quality=80, method=4)


def _row_to_record(r) -> dict:
    d = {k: r[k] for k in r.keys()}
    rec = {
        "id": d["id"], "created_at": d["created_at"], "width": d["width"], "height": d["height"], "format": "png",
        "prompt": d["prompt"], "negative_prompt": d["negative_prompt"], "model_id": d["model_id"],
        "model_name": d["model_name"], "mode": d["mode"], "loras": json.loads(d["loras_json"] or "[]"),
        "seed": d["seed"], "steps": d["steps"], "cfg": d["cfg"], "sampler": d["sampler"], "scheduler": d["scheduler"],
        "denoise": d["denoise"], "gen_seconds": d["gen_seconds"],
        "timings": json.loads(d["timings_json"]) if d["timings_json"] else None,
        "sources": json.loads(d["sources_json"] or "[]"),
        "request": json.loads(d["request_json"]) if d["request_json"] else None,
        "favorite": bool(d["favorite"]), "hidden": bool(d["hidden"]), "imported": bool(d["imported"]),
        "url": f"/api/images/{d['id']}/file", "thumb_url": f"/api/images/{d['id']}/thumb",
    }
    return rec


def get_image(iid: str) -> dict | None:
    r = db.conn().execute("SELECT * FROM images WHERE id=?", (iid,)).fetchone()
    return _row_to_record(r) if r else None


def image_path(iid: str) -> Path | None:
    r = db.conn().execute("SELECT rel_path FROM images WHERE id=?", (iid,)).fetchone()
    return _abs(r["rel_path"]) if r else None


def thumb_path(iid: str) -> Path:
    p = library_dir() / "thumbs" / f"{iid}.webp"
    if not p.exists():                       # odtwórz miniaturę, jeśli zniknęła
        src = image_path(iid)
        if src and src.exists():
            with Image.open(src) as im:
                make_thumb(im, iid)
    return p


def preview_path(iid: str, side: int = 1600) -> Path | None:
    """Podgląd WebP (dłuższy bok do `side` px) do przeglądania przez sieć: kilka razy mniejszy niż oryginalny PNG."""
    p = library_dir() / "thumbs" / f"{iid}_p.webp"
    if not p.exists():
        src = image_path(iid)
        if not src or not src.exists():
            return None
        with Image.open(src) as im:
            t = im.convert("RGB")
            t.thumbnail((side, side), Image.LANCZOS)
            p.parent.mkdir(parents=True, exist_ok=True)
            t.save(p, "WEBP", quality=88, method=4)
    return p


def list_images(query: str = "", flt: str = "all", sort: str = "new", model_id: str | None = None,
                limit: int = 60, offset: int = 0) -> dict:
    where, args = [], []
    if flt == "hidden":
        where.append("hidden=1")
    else:
        where.append("hidden=0")
        if flt == "favorite":
            where.append("favorite=1")
    if model_id:
        where.append("model_id=?"); args.append(model_id)
    for tok in re.split(r"\s+", query.strip().lower()):
        if tok:
            where.append("search_text LIKE ? ESCAPE '\\'")
            args.append("%" + tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
    w = " AND ".join(where)
    order = "ASC" if sort == "old" else "DESC"
    c = db.conn()
    total = c.execute(f"SELECT COUNT(*) FROM images WHERE {w}", args).fetchone()[0]
    rows = c.execute(f"SELECT * FROM images WHERE {w} ORDER BY created_at {order}, id {order} LIMIT ? OFFSET ?",
                     [*args, max(1, min(limit, 500)), max(0, offset)]).fetchall()
    return {"total": total, "items": [_row_to_record(r) for r in rows]}


def patch_image(iid: str, favorite: bool | None, hidden: bool | None) -> dict | None:
    c = db.conn()
    if favorite is not None:
        c.execute("UPDATE images SET favorite=? WHERE id=?", (int(favorite), iid))
    if hidden is not None:
        c.execute("UPDATE images SET hidden=? WHERE id=?", (int(hidden), iid))
    c.commit()
    return get_image(iid)


def delete_image(iid: str) -> bool:
    p = image_path(iid)
    if p is None:
        return False
    for f in (p, p.with_suffix(".json"), library_dir() / "thumbs" / f"{iid}.webp", library_dir() / "thumbs" / f"{iid}_p.webp"):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass
    c = db.conn()
    c.execute("DELETE FROM images WHERE id=?", (iid,))
    c.commit()
    return True


def stats() -> dict:
    c = db.conn()
    r = c.execute("SELECT COUNT(*) n, SUM(hidden) h, SUM(favorite) f FROM images").fetchone()
    size = 0
    d = library_dir() / "images"
    if d.exists():
        size = sum(f.stat().st_size for f in d.rglob("*.png"))
    return {"count": r["n"] or 0, "hidden": r["h"] or 0, "favorite": r["f"] or 0, "bytes": size, "dir": str(library_dir())}


# ───────────────────────── eksport / import ─────────────────────────

def render_export(iid: str, fmt: str, quality: int, with_meta: bool) -> tuple[bytes, str, str]:
    """→ (bajty, mime, nazwa pliku)."""
    rec, src = get_image(iid), image_path(iid)
    if not rec or not src or not src.exists():
        raise FileNotFoundError(iid)
    if fmt not in FORMATS:
        raise ValueError("Nieobsługiwany format")
    with Image.open(src) as im:
        im.load()
        data = encode(im, fmt, quality, rec if with_meta else None)
    name = re.sub(r"[^\w\-]+", "_", (rec["prompt"] or "image")[:40]).strip("_") or "image"
    return data, FORMATS[fmt][1], f"{name}_{rec['seed']}.{FORMATS[fmt][2]}"


def export_to_dir(iid: str, fmt: str, quality: int, with_meta: bool, dest_dir: str, filename: str | None) -> str:
    data, _, default = render_export(iid, fmt, quality, with_meta)
    d = Path(dest_dir)
    d.mkdir(parents=True, exist_ok=True)
    name = re.sub(r'[<>:"/\\|?*]', "_", filename) if filename else default
    if not name.lower().endswith("." + FORMATS[fmt][2]):
        name += "." + FORMATS[fmt][2]
    out = d / name
    n = 1
    while out.exists():
        out = d / f"{out.stem.rsplit('_dup', 1)[0]}_dup{n}{out.suffix}"; n += 1
    out.write_bytes(data)
    return str(out)


def import_image(data: bytes, name: str) -> dict:
    img = Image.open(io.BytesIO(data))
    img.load()
    meta: dict[str, Any] = {}
    raw = (img.info or {}).get("image-studio")           # odzyskaj parametry z naszych własnych PNG
    if raw:
        try:
            meta = json.loads(raw)
        except Exception:
            pass
    rec = {"prompt": meta.get("prompt") or (img.info.get("parameters", "").split("\nNegative")[0] if img.info else ""),
           "negative_prompt": meta.get("negative_prompt", ""), "model_id": meta.get("model_id"),
           "model_name": meta.get("model_name") or "Import", "mode": meta.get("mode") or "t2i",
           "loras": meta.get("loras") or [], "seed": meta.get("seed") or 0, "steps": meta.get("steps") or 0,
           "cfg": meta.get("cfg"), "sampler": meta.get("sampler"), "scheduler": meta.get("scheduler"),
           "denoise": meta.get("denoise"), "gen_seconds": None, "sources": [{"role": "source", "image_id": None, "name": name}],
           "request": meta.get("request")}
    return save_image(img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img, rec, embed=False, imported=True)


# ───────────────────────── uploads (źródła / referencje / maski) ─────────────────────────

def save_upload(data: bytes, name: str) -> dict:
    img = Image.open(io.BytesIO(data))
    img.load()
    uid = new_id()
    rel = f"sources/{uid}.png"
    p = _abs(rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p, "PNG")
    db.conn().execute("INSERT INTO uploads(id,rel_path,name,width,height,created_at) VALUES(?,?,?,?,?,?)",
                      (uid, rel, name, img.width, img.height, int(time.time() * 1000)))
    db.conn().commit()
    return {"upload_id": uid, "width": img.width, "height": img.height, "url": f"/api/uploads/{uid}"}


def upload_info(uid: str) -> dict | None:
    r = db.conn().execute("SELECT * FROM uploads WHERE id=?", (uid,)).fetchone()
    return {"path": _abs(r["rel_path"]), "name": r["name"]} if r else None
