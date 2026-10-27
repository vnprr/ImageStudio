"""Image Studio backend. Zmienne środowiskowe muszą być ustawione przed zaimportowaniem torch."""
import os

# MIOpen: tryb FAST używa gotowej bazy heurystyk zamiast długiego strojenia kerneli dla każdego nowego kształtu
# (bez tego pierwszy dekod VAE w nowej rozdzielczości trwał minutę+).
os.environ.setdefault("MIOPEN_FIND_MODE", "FAST")
os.environ.setdefault("MIOPEN_LOG_LEVEL", "1")
