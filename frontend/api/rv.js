// Rejestr adresów silników („rendezvous"): silnik w domu zapisuje tu swój bieżący adres tunelu, a interfejs web go odczytuje,
// dzięki czemu link do wersji web jest stały mimo zmiennego adresu tunelu quick.
//   POST /api/rv {reg, url}   zapis; id = SHA-256(reg), więc zapisać może tylko właściciel klucza `reg`
//   GET  /api/rv?id=<id>      odczyt bieżącego adresu
// Dane trzyma Vercel Blob (BLOB_READ_WRITE_TOKEN ustawia integracja). Całą wersję web chroni logowanie Vercel (Deployment Protection).
import { createHash } from "node:crypto";
import { head, put } from "@vercel/blob";

const idOf = (reg) => createHash("sha256").update(reg).digest("hex").slice(0, 32);
const key = (id) => `rv/${id}.json`;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const id = String(req.query.id || "");
      if (!/^[0-9a-f]{32}$/.test(id)) return res.status(400).json({ detail: "Niepoprawny identyfikator." });
      let meta;
      try { meta = await head(key(id)); } catch { return res.status(404).json({ detail: "Silnik nie jest zarejestrowany." }); }
      const r = await fetch(`${meta.url}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return res.status(404).json({ detail: "Silnik nie jest zarejestrowany." });
      return res.status(200).json(await r.json());
    }
    if (req.method === "POST") {
      const { reg, url } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      if (typeof reg !== "string" || reg.length < 32 || reg.length > 200) return res.status(400).json({ detail: "Niepoprawny klucz." });
      let u;
      try { u = new URL(url); } catch { return res.status(400).json({ detail: "Niepoprawny adres." }); }
      if (u.protocol !== "https:" || String(url).length > 300) return res.status(400).json({ detail: "Adres musi być HTTPS." });
      await put(key(idOf(reg)), JSON.stringify({ url: u.origin, t: Date.now() }), {
        access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60,
      });
      return res.status(200).json({ ok: true, id: idOf(reg) });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ detail: "Metoda niedozwolona." });
  } catch (e) {
    return res.status(500).json({ detail: "Błąd rejestru: " + (e && e.message ? e.message : "nieznany") });
  }
}
