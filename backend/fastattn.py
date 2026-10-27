"""Zamiennik torch SDPA dla PyTorch ROCm na gfx1030 (RDNA2).

Ten build PyTorch nie ma kerneli flash/mem-efficient dla gfx1030, więc SDPA schodzi na ścieżkę `math`:
  • jest ok. 2,5× wolniejsza niż zwykłe matmul+softmax (17,5 ms vs 6,8 ms przy 2816 tokenach),
  • ma klif wydajności: przy 4608 tokenach (FLUX.2 1024×1024) pojedyncze wywołanie skacze z 41 ms do 706 ms,
    co dawało 35 s na krok zamiast ~2 s.
Poniższa wersja liczy softmax(QKᵀ/√d)V wprost, porcjując głowice tak, by macierz wyników nie przekraczała ~640 MB.
Włączana wyłącznie na ROCm; wywołania z maską / causal / dropout / GQA przechodzą do oryginalnej implementacji.
"""
from __future__ import annotations

import torch
import torch.nn.functional as F

_orig = F.scaled_dot_product_attention
_installed = False
MAX_SCORE_BYTES = 640 * 2**20


def fast_sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, enable_gqa=False):
    if (attn_mask is not None or is_causal or dropout_p or enable_gqa or query.dim() != 4 or not query.is_cuda
            or query.dtype not in (torch.float16, torch.bfloat16, torch.float32) or query.shape[-2] < 256):
        return _orig(query, key, value, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal, scale=scale,
                     enable_gqa=enable_gqa)
    b, h, sq, d = query.shape
    sk = key.shape[-2]
    s = scale if scale is not None else d ** -0.5
    per_head = b * sq * sk * query.element_size()
    hc = max(1, min(h, MAX_SCORE_BYTES // max(per_head, 1)))
    q = query * s                                         # skala na q (jak w SD), mniejsze ryzyko przepełnień fp16
    if hc >= h:
        return torch.softmax(q @ key.transpose(-1, -2), dim=-1) @ value
    out = torch.empty_like(query)
    for i in range(0, h, hc):
        out[:, i:i + hc] = torch.softmax(q[:, i:i + hc] @ key[:, i:i + hc].transpose(-1, -2), dim=-1) @ value[:, i:i + hc]
    return out


def install() -> bool:
    """Podmień SDPA (tylko ROCm). Zwraca True, jeśli zainstalowano."""
    global _installed
    if _installed or not torch.version.hip or not torch.cuda.is_available():
        return _installed
    F.scaled_dot_product_attention = fast_sdpa
    torch.nn.functional.scaled_dot_product_attention = fast_sdpa
    _installed = True
    return True
