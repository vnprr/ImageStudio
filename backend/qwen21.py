"""Qwen Image 2.1 z plików GGUF: transformer (GGUF), koder Qwen3-VL (GGUF) z projektorem wizji (mmproj) i VAE (safetensors).

Diffusers ma klasy `QwenImage21*`, a nazwy tensorów w GGUF transformera zgadzają się z nimi (poza sklejonym `img_mlp.gate_up`,
który diffusers sam rozcina). Koder tekstu składamy z dwóch plików GGUF do `Qwen3VLForConditionalGeneration`: warstwy liniowe zostają
skwantyzowane (`GGUFLinear`, dekwantyzacja w locie), więc koder zajmuje ok. 6 GB zamiast 17 GB.

Układ katalogu modelu (dowolna nazwa folderu):
    model/*.gguf          transformer
    text_encoder/*.gguf   Qwen3-VL (część językowa)
    mmproj/*.gguf         Qwen3-VL (wieża wizji + projektor)
    vae/*.safetensors     VAE
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import torch

SUBDIRS = {"transformer": "model", "text_encoder": "text_encoder", "mmproj": "mmproj", "vae": "vae"}

# domyślny harmonogram: jak w oficjalnej konfiguracji Qwen-Image (przesunięcie rośnie z liczbą tokenów obrazu)
SCHEDULER_CONFIG = {
    "base_image_seq_len": 256, "max_image_seq_len": 8192, "base_shift": 0.5, "max_shift": 0.9, "shift": 1.0,
    "use_dynamic_shifting": True, "time_shift_type": "exponential", "num_train_timesteps": 1000, "invert_sigmas": False,
    "shift_terminal": None, "stochastic_sampling": False,
}

# Wartości architektury Qwen3-VL-8B (wymiary i tokeny specjalne); reszta pochodzi z metadanych GGUF.
VISION = dict(depth=27, hidden_size=1152, intermediate_size=4304, num_heads=16, in_channels=3, patch_size=16,
              spatial_merge_size=2, temporal_patch_size=2, out_hidden_size=4096, num_position_embeddings=2304,
              deepstack_visual_indexes=[8, 16, 24], hidden_act="gelu_pytorch_tanh")
TOKENS = dict(image_token_id=151655, video_token_id=151656, vision_start_token_id=151652, vision_end_token_id=151653)


def find_bundle(root: Path) -> dict[str, Path] | None:
    """Ścieżki czterech plików modelu albo None, gdy folder nie ma układu transformer/koder/mmproj/vae."""
    out: dict[str, Path] = {}
    for key, sub in SUBDIRS.items():
        d = root / sub
        if not d.is_dir():
            return None
        files = sorted(d.glob("*.safetensors" if key == "vae" else "*.gguf"), key=lambda p: p.stat().st_size, reverse=True)
        if not files:
            return None
        out[key] = files[0]
    return out


def bundle_label(paths: dict[str, Path]) -> str:
    m = re.search(r"(Q\d_[A-Z0-9_]+|BF16|F16)", paths["transformer"].stem, re.I)
    return m.group(1).upper() if m else "GGUF"


def open_gguf(path: Path):
    """GGUFReader z ponowieniem: biblioteka gguf rzuca czasem przypadkowy TypeError przy parsowaniu nagłówka (ten sam plik za drugim razem się wczytuje)."""
    from gguf import GGUFReader
    last: Exception | None = None
    for _ in range(4):
        try:
            return GGUFReader(str(path))
        except TypeError as ex:
            last = ex
            time.sleep(0.3)
    raise RuntimeError(f"Nie udało się odczytać nagłówka GGUF ({path.name}): {last}")


def _gguf_meta(path: Path) -> dict:
    r = open_gguf(path)
    out = {}
    for k, f in r.fields.items():
        if k.startswith("GGUF."):
            continue
        try:
            out[k] = f.contents()
        except Exception:
            pass
    return out


# ───────────────────────── transformer ─────────────────────────

def load_transformer(path: Path, cache_dir: Path, compute_dtype: torch.dtype = torch.float32):
    """Transformer z GGUF: wagi zostają skwantyzowane (Q4/Q5/Q8), a mnożenia liczone w `compute_dtype`.
    Qwen Image 2.1 jest trenowany w bf16 i przepełnia fp16, więc domyślnie fp32 (na RDNA2 szybsze od bf16)."""
    from diffusers import GGUFQuantizationConfig, QwenImage21Transformer2DModel
    cfg = cache_dir / "qwen21_transformer"
    if not (cfg / "config.json").exists():                 # lokalna konfiguracja (bez pobierania z Hugging Face)
        cfg.mkdir(parents=True, exist_ok=True)
        with torch.device("meta"):
            QwenImage21Transformer2DModel().save_config(str(cfg))
    model = QwenImage21Transformer2DModel.from_single_file(
        str(path), config=str(cfg), quantization_config=GGUFQuantizationConfig(compute_dtype=compute_dtype), torch_dtype=compute_dtype)
    _dequantize_non_linear(model, compute_dtype)
    return model


def _dequantize_non_linear(model: torch.nn.Module, dtype: torch.dtype) -> None:
    """Diffusers zostawia w GGUF-ie tensory bf16 spoza warstw liniowych (np. waga normy tekstu) jako surowe bajty: zamień je na zwykłe tensory."""
    from diffusers.quantizers.gguf.utils import GGUFLinear, GGUFParameter, dequantize_gguf_tensor
    for m in model.modules():
        if isinstance(m, GGUFLinear):
            continue
        for name, p in list(m.named_parameters(recurse=False)):
            if isinstance(p, GGUFParameter):
                setattr(m, name, torch.nn.Parameter(dequantize_gguf_tensor(p).to(dtype), requires_grad=False))


def load_vae(path: Path, cache_dir: Path, dtype: torch.dtype = torch.float32):
    from diffusers import AutoencoderKLQwenImage21
    from safetensors.torch import load_file
    with torch.device("meta"):
        probe = AutoencoderKLQwenImage21()
    vae = AutoencoderKLQwenImage21()
    sd = load_file(str(path))
    missing = set(probe.state_dict()) - set(sd)
    if missing:
        raise RuntimeError(f"VAE: brakuje {len(missing)} tensorów (np. {sorted(missing)[:2]})")
    vae.load_state_dict(sd, strict=True)
    return vae.to(dtype).eval()


# ───────────────────────── koder tekstu Qwen3-VL ─────────────────────────

def _lm_names(n: str) -> str | None:
    """Nazwa llama.cpp → nazwa Hugging Face dla części językowej."""
    fixed = {"token_embd.weight": "model.language_model.embed_tokens.weight", "output_norm.weight": "model.language_model.norm.weight"}
    if n in fixed:
        return fixed[n]
    m = re.fullmatch(r"blk\.(\d+)\.(.+)", n)
    if not m:
        return None
    i, rest = m.groups()
    table = {"attn_norm.weight": "input_layernorm.weight", "ffn_norm.weight": "post_attention_layernorm.weight",
             "attn_q.weight": "self_attn.q_proj.weight", "attn_k.weight": "self_attn.k_proj.weight",
             "attn_v.weight": "self_attn.v_proj.weight", "attn_output.weight": "self_attn.o_proj.weight",
             "attn_q_norm.weight": "self_attn.q_norm.weight", "attn_k_norm.weight": "self_attn.k_norm.weight",
             "ffn_gate.weight": "mlp.gate_proj.weight", "ffn_up.weight": "mlp.up_proj.weight", "ffn_down.weight": "mlp.down_proj.weight"}
    return f"model.language_model.layers.{i}.{table[rest]}" if rest in table else None


def _vision_names(n: str) -> str | None:
    """Nazwa mmproj (llama.cpp) → nazwa Hugging Face dla wieży wizji i projektora."""
    fixed = {"v.position_embd.weight": "model.visual.pos_embed.weight", "v.patch_embd.bias": "model.visual.patch_embed.proj.bias",
             "v.post_ln.weight": "model.visual.merger.norm.weight", "v.post_ln.bias": "model.visual.merger.norm.bias",
             "mm.0.weight": "model.visual.merger.linear_fc1.weight", "mm.0.bias": "model.visual.merger.linear_fc1.bias",
             "mm.2.weight": "model.visual.merger.linear_fc2.weight", "mm.2.bias": "model.visual.merger.linear_fc2.bias"}
    if n in fixed:
        return fixed[n]
    m = re.fullmatch(r"v\.blk\.(\d+)\.(.+)", n)
    if m:
        i, rest = m.groups()
        table = {"ln1": "norm1", "ln2": "norm2", "attn_qkv": "attn.qkv", "attn_out": "attn.proj", "ffn_up": "mlp.linear_fc1", "ffn_down": "mlp.linear_fc2"}
        base, kind = rest.rsplit(".", 1)
        return f"model.visual.blocks.{i}.{table[base]}.{kind}" if base in table else None
    m = re.fullmatch(r"v\.deepstack\.(\d+)\.(norm|fc1|fc2)\.(weight|bias)", n)
    if m:
        layer, part, kind = m.groups()
        idx = VISION["deepstack_visual_indexes"].index(int(layer))
        return f"model.visual.deepstack_merger_list.{idx}.{ {'norm': 'norm', 'fc1': 'linear_fc1', 'fc2': 'linear_fc2'}[part] }.{kind}"
    return None


def text_encoder_config(meta: dict):
    from transformers import Qwen3VLConfig
    a = "qwen3vl"
    sections = [int(x) for x in meta[f"{a}.rope.dimension_sections"]][:3]
    text = dict(
        vocab_size=151936, hidden_size=int(meta[f"{a}.embedding_length"]), intermediate_size=int(meta[f"{a}.feed_forward_length"]),
        num_hidden_layers=int(meta[f"{a}.block_count"]), num_attention_heads=int(meta[f"{a}.attention.head_count"]),
        num_key_value_heads=int(meta[f"{a}.attention.head_count_kv"]), head_dim=int(meta[f"{a}.attention.key_length"]),
        hidden_act="silu", max_position_embeddings=int(meta[f"{a}.context_length"]), rms_norm_eps=float(meta[f"{a}.attention.layer_norm_rms_epsilon"]),
        rope_parameters={"rope_type": "default", "rope_theta": float(meta[f"{a}.rope.freq_base"]), "mrope_section": sections, "mrope_interleaved": True},
        tie_word_embeddings=False)
    return Qwen3VLConfig(text_config=text, vision_config=VISION, tie_word_embeddings=False, **TOKENS)


def load_text_encoder(lm_path: Path, mmproj_path: Path, compute_dtype: torch.dtype = torch.bfloat16):
    """Qwen3VLForConditionalGeneration: warstwy liniowe części językowej jako `GGUFLinear`, reszta zdekwantyzowana do `compute_dtype`.
    Zwraca model na CPU (gotowy do przeniesienia na GPU na czas kodowania promptu)."""
    from accelerate import init_empty_weights
    from accelerate.utils import set_module_tensor_to_device
    from diffusers.models.model_loading_utils import load_gguf_checkpoint
    from diffusers.quantizers.gguf.utils import GGUFLinear, GGUFParameter, dequantize_gguf_tensor
    from transformers import Qwen3VLForConditionalGeneration

    cfg = text_encoder_config(_gguf_meta(lm_path))
    with init_empty_weights(include_buffers=False):
        model = Qwen3VLForConditionalGeneration(cfg)
    model.eval()
    expected = set(model.state_dict())

    def plain(t):
        t = dequantize_gguf_tensor(t) if isinstance(t, GGUFParameter) else t
        return t.to(compute_dtype)

    loaded: set[str] = set()

    def put(name: str, tensor) -> None:
        mod_name, _, leaf = name.rpartition(".")
        mod = model.get_submodule(mod_name)
        if isinstance(tensor, GGUFParameter) and isinstance(mod, torch.nn.Linear) and leaf == "weight":
            with init_empty_weights(include_buffers=False):
                lin = GGUFLinear(mod.in_features, mod.out_features, mod.bias is not None, compute_dtype=compute_dtype)
            parent_name, _, child = mod_name.rpartition(".")
            lin.weight = tensor
            if mod.bias is not None:
                lin.bias = torch.nn.Parameter(torch.zeros(mod.out_features, dtype=compute_dtype), requires_grad=False)
            setattr(model.get_submodule(parent_name) if parent_name else model, child, lin)
        else:
            set_module_tensor_to_device(model, name, "cpu", value=plain(tensor), dtype=compute_dtype)
        loaded.add(name)

    lm = load_gguf_checkpoint(str(lm_path), return_tensors=True)
    for n, t in lm.items():
        hf = _lm_names(n)
        if hf is not None:
            put(hf, t)
    del lm

    vis = load_gguf_checkpoint(str(mmproj_path), return_tensors=True)
    patch = [vis.pop("v.patch_embd.weight"), vis.pop("v.patch_embd.weight.1")]
    # llama.cpp trzyma jądro Conv3d jako dwa jądra 2D (po jednym na klatkę czasową)
    w = torch.stack([plain(p).reshape(VISION["hidden_size"], VISION["in_channels"], VISION["patch_size"], VISION["patch_size"]) for p in patch], dim=2)
    set_module_tensor_to_device(model, "model.visual.patch_embed.proj.weight", "cpu", value=w, dtype=compute_dtype)
    loaded.add("model.visual.patch_embed.proj.weight")
    for n, t in vis.items():
        hf = _vision_names(n)
        if hf is not None:
            if isinstance(t, GGUFParameter):
                t = dequantize_gguf_tensor(t)
            set_module_tensor_to_device(model, hf, "cpu", value=t.to(compute_dtype), dtype=compute_dtype)
            loaded.add(hf)
    del vis

    # lm_head nie jest potrzebny (pipeline czyta tylko stany ukryte): zamiennik oszczędza ok. 0,6 GB
    model.lm_head = torch.nn.Identity()
    expected.discard("lm_head.weight")
    missing = sorted(expected - loaded)
    if missing:
        raise RuntimeError(f"Koder tekstu: nie wczytano {len(missing)} tensorów (np. {missing[:3]})")
    for _, p in model.named_parameters():
        p.requires_grad_(False)
    return model


def load_processor(lm_path: Path):
    """Procesor Qwen3-VL zbudowany z tokenizera zapisanego w GGUF (bez pobierania czegokolwiek)."""
    from transformers import Qwen2TokenizerFast, Qwen3VLProcessor
    from transformers.models.qwen2_vl.image_processing_qwen2_vl import Qwen2VLImageProcessor
    from transformers.models.qwen3_vl.video_processing_qwen3_vl import Qwen3VLVideoProcessor
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers, normalizers

    r = open_gguf(lm_path)
    f = r.fields
    tokens = [bytes(f["tokenizer.ggml.tokens"].parts[i]).decode("utf-8") for i in f["tokenizer.ggml.tokens"].data]
    merges = [bytes(f["tokenizer.ggml.merges"].parts[i]).decode("utf-8") for i in f["tokenizer.ggml.merges"].data]
    ttypes = [int(f["tokenizer.ggml.token_type"].parts[i][0]) for i in f["tokenizer.ggml.token_type"].data]
    template = bytes(f["tokenizer.chat_template"].parts[f["tokenizer.chat_template"].data[0]]).decode("utf-8")

    vocab = {t: i for i, t in enumerate(tokens)}
    tok = Tokenizer(models.BPE(vocab=vocab, merges=[tuple(m.split(" ", 1)) for m in merges], byte_fallback=False, fuse_unk=False))
    tok.normalizer = normalizers.NFC()
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+", "isolated", False),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)])
    tok.decoder = decoders.ByteLevel()
    special = [t for t, tt in zip(tokens, ttypes) if tt == 3]          # CONTROL
    tok.add_special_tokens(special)
    fast = Qwen2TokenizerFast(tokenizer_object=tok, eos_token="<|im_end|>", pad_token="<|endoftext|>", bos_token=None, unk_token=None,
                              additional_special_tokens=[t for t in special if t not in ("<|im_end|>", "<|endoftext|>")], clean_up_tokenization_spaces=False)
    fast.chat_template = template
    image_proc = Qwen2VLImageProcessor(patch_size=VISION["patch_size"], temporal_patch_size=VISION["temporal_patch_size"], merge_size=VISION["spatial_merge_size"],
                                       image_mean=[0.5, 0.5, 0.5], image_std=[0.5, 0.5, 0.5], min_pixels=65536, max_pixels=16777216)
    proc = Qwen3VLProcessor(image_processor=image_proc, tokenizer=fast, video_processor=Qwen3VLVideoProcessor(), chat_template=template)
    return proc


def build_pipeline(paths: dict[str, Path], cache_dir: Path, compute_dtype: torch.dtype = torch.float32):
    from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline
    transformer = load_transformer(paths["transformer"], cache_dir, compute_dtype)
    vae = load_vae(paths["vae"], cache_dir, compute_dtype)
    te = load_text_encoder(paths["text_encoder"], paths["mmproj"])
    proc = load_processor(paths["text_encoder"])
    return QwenImage21Pipeline(scheduler=FlowMatchEulerDiscreteScheduler.from_config(SCHEDULER_CONFIG), vae=vae, text_encoder=te,
                               processor=proc, transformer=transformer, sample_sigmas=None)


def tune_vae(vae) -> None:
    """Kafle VAE: kodowanie obrazów wejściowych domyślnymi kaflami 256 px (krok 192), dekodowanie większymi (512 px, krok 384).
    Sprawdzone na edycji 768×1024: kodowanie bez kafli albo kaflami 512 px dawało wyniki ignorujące prompt i pełne artefaktów
    (a do tego VRAM pod korek i kroki 4–10× wolniejsze), kafle 256 px dają poprawną edycję. Dekodowanie nie zmienia obrazu
    (te same latenty, kafle 256/384/512 i bez kafli wyglądają tak samo), a większe kafle dają mniej szwów."""
    vae.enable_tiling()
    enc, dec = vae.encode, vae.decode

    def tiles(size: int, stride: int) -> None:
        vae.tile_sample_min_height = vae.tile_sample_min_width = size
        vae.tile_sample_stride_height = vae.tile_sample_stride_width = stride

    def encode(x, *a, **k):
        tiles(256, 192)
        vae.use_tiling = True
        return enc(x, *a, **k)

    def decode(z, *a, **k):
        tiles(512, 384)
        vae.use_tiling = True
        return dec(z, *a, **k)

    vae.encode, vae.decode = encode, decode


def attach_text_swap(pipe, device, out_dtype: torch.dtype = torch.float32, on_time=None) -> None:
    """Koder tekstu (ok. 6,6 GB) trafia na GPU tylko na czas kodowania promptu, a potem wraca do RAM, żeby transformer miał VRAM na aktywacje."""
    te = pipe.text_encoder
    orig = pipe.encode_prompt

    def encode_prompt(*a, **k):
        t0 = time.perf_counter()
        te.to(device)
        try:
            emb, mask, pad = orig(*a, **k)
            return emb.to(out_dtype), mask, pad          # latenty dziedziczą dtype embeddingów, a transformer liczy w fp32
        finally:
            te.to("cpu")
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
            if on_time:
                on_time(time.perf_counter() - t0)

    pipe.encode_prompt = encode_prompt


def convert_lora(path: str) -> dict:
    """LoRA do Qwen Image 2.1: ComfyUI skleja bramkę i gałąź SwiGLU w `img_mlp.gate_up`, a diffusers ma je osobno (`gate_layer`, `proj`).
    Macierz A jest wspólna, macierz B dzieli się na pół (bramka pierwsza), tak samo jak wagi bazowe."""
    from safetensors.torch import load_file
    sd = load_file(path)
    out = {}
    for k, v in sd.items():
        if ".img_mlp.gate_up." in k and k.endswith("lora_B.weight") or ".img_mlp.gate_up." in k and k.endswith("lora_B.default.weight"):
            gate, up = v.chunk(2, dim=0)
            out[k.replace(".gate_up.", ".gate_layer.")] = gate.contiguous()
            out[k.replace(".gate_up.", ".proj.")] = up.contiguous()
        elif ".img_mlp.gate_up." in k:
            out[k.replace(".gate_up.", ".gate_layer.")] = v
            out[k.replace(".gate_up.", ".proj.")] = v.clone()
        else:
            out[k] = v
    return out
