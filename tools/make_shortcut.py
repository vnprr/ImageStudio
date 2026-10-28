"""Generuje ikonę (assets/icon.ico) i skrót 'Image Studio.lnk' uruchamiający launcher bez konsoli.  python tools/make_shortcut.py"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024


def logo() -> Image.Image:
    g = Image.new("RGB", (S, S))
    px = g.load()
    stops = [(0.0, (255, 138, 61)), (0.52, (255, 61, 129)), (1.0, (139, 92, 246))]
    for y in range(S):
        for x in range(S):
            t = (x * 0.35 + y * 0.65) / S               # ukośny gradient żaru
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if t <= t1:
                    k = (t - t0) / (t1 - t0)
                    px[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * k) for i in range(3))
                    break
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.3), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(g, (0, 0), mask)
    # czteroramienna iskra (ta sama krzywa co w UI), czarna
    d = ImageDraw.Draw(img)
    s = S / 40
    pts = []
    import math
    # polilinia zbliżona do wklęsłej gwiazdy: 4 wierzchołki + wklęsłe łuki
    cx = cy = 20 * s
    R, r = 12 * s, 3.2 * s
    for i in range(8):
        ang = math.pi / 4 * i - math.pi / 2
        rad = R if i % 2 == 0 else r
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    d.polygon(pts, fill=(0, 0, 0, 225))
    return img


def make_lnk(lnk: Path, pyw: Path, app: Path, ico: Path, args: str, desc: str) -> None:
    ps = (f"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{lnk}');"
          f"$s.TargetPath='{pyw}';$s.Arguments='\"{app / 'launcher.pyw'}\"{args}';$s.WorkingDirectory='{app}';"
          f"$s.IconLocation='{ico}';$s.Description='{desc}';$s.Save()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)


def main() -> None:
    """python tools/make_shortcut.py [FOLDER_APLIKACJI]: ikona + skróty „Image Studio” i „Image Studio Engine” (tryb silnika)."""
    app = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT
    (ROOT / "assets").mkdir(exist_ok=True)
    ico = ROOT / "assets" / "icon.ico"
    logo().save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    py = Path(sys.executable)
    pyw = py.with_name("pythonw.exe") if py.with_name("pythonw.exe").exists() else py
    ico_app = app / "assets" / "icon.ico" if (app / "assets" / "icon.ico").exists() else ico
    make_lnk(app / "Image Studio.lnk", pyw, app, ico_app, "", "Image Studio")
    make_lnk(app / "Image Studio Engine.lnk", pyw, app, ico_app, " --engine", "Image Studio: tryb silnika (zdalny dostęp)")
    print("OK:", ico_app, app / "Image Studio.lnk", app / "Image Studio Engine.lnk")


if __name__ == "__main__":
    main()
