import { useEffect, useRef, useState } from "react";
import { PlugZap } from "lucide-react";
import { IS_WEB, getConn, normalizeBase, pendingLink, probe, setConn } from "../connection";
import { useT } from "../i18n";
import { Logo, Spinner } from "./ui";

/** Ekran łączenia z silnikiem (wersja web albo silnik za tunelem): adres + token, albo link parowania z ustawień aplikacji. */
export function Connect() {
  const t = useT();
  const [url, setUrl] = useState(pendingLink?.u ?? getConn()?.base ?? (IS_WEB ? "" : location.origin));
  const [token, setToken] = useState(pendingLink?.t ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const auto = useRef(!!pendingLink);

  const go = async (u = url, tk = token) => {
    const base = normalizeBase(u);
    if (!base || !tk.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setConn(await probe(base, tk.trim()));
      location.reload();                              // czysty start: nowe SSE i dane z wybranego silnika
    } catch (e) {
      const code = (e as { code?: number }).code;
      setErr(t(code === 401 ? "connect.err401" : code === 403 ? "connect.err403" : code === -1 ? "connect.errNotEngine" : "connect.errNet"));
      setBusy(false);
    }
  };

  useEffect(() => { if (auto.current && pendingLink) { auto.current = false; void go(pendingLink.u, pendingLink.t); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const mixed = location.protocol === "https:" && /^http:\/\//i.test(normalizeBase(url)) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(normalizeBase(url));
  return (
    <div className="offline">
      <form className="offline-card connect-card" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Logo size={56} />
        <h1>{t("connect.title")}</h1>
        <p>{t("connect.text")}</p>
        <label className="connect-field">
          <span className="label">{t("connect.url")}</span>
          <input type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={url} placeholder="https://….trycloudflare.com" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="connect-field">
          <span className="label">{t("connect.token")}</span>
          <input type="password" autoComplete="off" value={token} placeholder="••••••••" onChange={(e) => setToken(e.target.value)} />
        </label>
        {mixed && <div className="warn small">{t("connect.mixed")}</div>}
        {err && <div className="error-inline" role="alert">{err}</div>}
        <button className="btn amber wide" type="submit" disabled={busy || !url.trim() || !token.trim()}>
          {busy ? <Spinner /> : <PlugZap size={15} />} {t("connect.button")}
        </button>
        <p className="muted small connect-help">{t("connect.help")}</p>
      </form>
    </div>
  );
}
