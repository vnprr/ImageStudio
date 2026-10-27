# Image Studio

Local AI image generation and editing: a **React + TypeScript + Vite** UI on top of a **FastAPI + Diffusers + PyTorch** engine.
No cloud, no ComfyUI server. Designed for Windows 11 with a ROCm-capable AMD GPU (developed and measured on an RX 6950 XT, gfx1030, 16 GB;
CUDA has not been tested). The interface is available in Polish, English, German, French and Spanish.

This repository contains **code only**. Models, the image library, settings and any history are stored in a separate
application folder and are never part of the repository (see [Code vs. application](#code-vs-application)).

## Features

- Text to image, image editing, multi-reference generation and inpainting (FLUX.2 klein 4B, Z-Image Turbo), LoRA support.
- Images live under the prompt like attachments in a chat. Each one is **to edit**, **inspiration** or **inactive**, and any of
  them can be painted on: an inpainting **mask** and colored **doodles** (the doodled image is what the model receives).
- Bottom gallery with a size slider, full gallery with grid/list layout and Ctrl+scroll zoom, context menus on images.
- One parameters panel: basic settings plus an "Advanced" switch (exact width and height in pixels, seed, guidance, ...).
- Model manager with downloads (size, license and free space shown before downloading), load/unload to free VRAM.
- Desktop window (Edge/Chrome `--app` mode) without the browser's context menu or text selection.

## Requirements

- Windows 11, Python (developed on 3.13) with a **PyTorch build for your GPU** already installed. Do not let `pip`
  replace it: install the remaining packages against a constraints file.
- Node.js to build the UI.
- Edge or Chrome for the app window (any browser works for development).

```powershell
pip freeze > constraints.txt
pip install -c constraints.txt -r backend/requirements.txt
cd frontend; npm ci; npm run build
```

## Running

Development (hot reload UI on :5173, API on :8765):

```powershell
python -m uvicorn backend.app:app --port 8765
cd frontend; npm run dev
```

Desktop window: `run.bat` starts the backend and opens the app window; closing the window stops the backend and frees the model.
Set the interpreter that has PyTorch with `IMAGE_STUDIO_PYTHON` or `data/launcher.json` (`{"python": "C:\\path\\to\\python.exe"}`).
`tools/make_shortcut.py` creates an icon and a `.lnk` shortcut. Diagnostics: `set IMAGE_STUDIO_CONSOLE=1` before `run.bat`,
backend log in `data/server.log`.

## Code vs. application

| | Code (this repository) | Installed application |
|---|---|---|
| Contents | `backend/`, `frontend/src`, `tools/`, docs | `backend/` + built `frontend/dist`, `launcher.pyw`, `run.bat` |
| Plus | | `data/` (settings, library, thumbnails, SQLite), `models/` (checkpoints, LoRA) |

`tools/deploy.ps1` builds the UI and copies the code into the application folder without touching `data/` or `models/`:

```powershell
powershell -File tools/deploy.ps1 -AppDir "D:\Apps\ImageStudio"     # or set IMAGE_STUDIO_APP
```

Where things live is configurable, so the code can also run against any data folder:

| Variable | Meaning | Default |
|---|---|---|
| `IMAGE_STUDIO_DATA` | settings, SQLite library, generated images | `<root>/data` |
| `IMAGE_STUDIO_MODELS` | default model folder | `<root>/models` |
| `IMAGE_STUDIO_PORT` | backend port | `8765` |
| `IMAGE_STUDIO_PYTHON` | interpreter that has PyTorch (launcher) | current Python |
| `COMFYUI_DIR` | optional ComfyUI folder whose `models/` is scanned | auto-detected |

## Models

| Model | Modes | Notes |
|---|---|---|
| FLUX.2 klein 4B | text to image, edit, multi-reference (up to 4), inpainting, LoRA | distilled: 4 steps, CFG inactive |
| Z-Image Turbo | text to image, img2img (denoise), inpainting, LoRA | 8 steps |

Install models from the UI (Settings, Models) or copy a Diffusers-layout folder into the models directory. Extra folders
(including `ComfyUI/models/...`) can be added in Settings. Stand-alone transformer checkpoints of the same family are detected
as alternative models and loaded on top of the installed base model (text encoder and VAE). Files in other architectures are
listed as unsupported with the reason, without loading them.

## GPU notes (RDNA2 / ROCm)

These come from measurements on gfx1030 and are why the engine looks the way it does:

- RDNA2 has no native bf16: fp16 is about 5x faster. Transformer and VAE run in fp16, the text encoder in bf16. A model that
  overflows fp16 is detected automatically (degenerate image) and switched to a "safe mode" (fp32 compute); the decision is
  remembered in `data/dtype_overrides.json`.
- This PyTorch build has no flash/mem-efficient SDPA for gfx1030 and the math path has a cliff at 4608 tokens;
  `backend/fastattn.py` replaces it with head-chunked matmul+softmax (ROCm only).
- The transformer and VAE stay on the GPU, the text encoder is streamed from RAM during prompt encoding; the allocator limit
  (93% of VRAM) prevents silent spilling into shared memory, which slows steps 10-80x.
- Other GPU programs (browsers, other AI jobs) distort timings. `tools/gpu_busy.ps1` exits 0 when the GPU is free.

## Tests and tools

```
python tools/e2e.py <model-id> --long 10      # end-to-end series through the API (needs a running backend)
python tools/engine_checks.py [model-id]      # LoRA, edit, multi-reference, inpainting (no server)
python tools/bench_engine.py [model-id]       # stage and step timings
cd frontend; npm run typecheck
```

The UI-to-backend contract is in [API.md](API.md).

## Privacy

Nothing user-specific is stored in the code: no prompts, generations, model or LoRA names, paths or tokens.
`.gitignore` excludes `data/`, `models/`, databases, logs, weights and local settings. A Hugging Face token, if you set one,
lives only in `data/settings.json`.
