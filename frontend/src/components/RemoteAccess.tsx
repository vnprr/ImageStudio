import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, Globe, KeyRound, LogOut, Play, RefreshCw, Square } from "lucide-react";
import { api } from "../api";
import { encodeLink, getConn, isRemote, setConn } from "../connection";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { RemoteStatus } from "../types";
import { Spinner, Switch } from "./ui";

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button className="btn small" disabled={!text} title={label ?? t("copy")} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1600); }); }}>
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? t("copied") : label ?? t("copy")}
    </button>
  );
}

/** Karta „Połączenie" w wersji web / za tunelem: z jakim silnikiem gadamy i jak się rozłączyć. */
function ClientCard() {
  const t = useT();
  const system = useStore((s) => s.system);
  const online = useStore((s) => s.online);
  const c = getConn();
  return (
    <div className="card">
      <h3><Globe size={15} /> {t("remote.client.title")}</h3>
      <div className="sys-grid">
        <div><span>{t("remote.client.engine")}</span><strong className="trunc" title={c?.base}>{c?.base}</strong></div>
        <div><span>{t("remote.client.status")}</span><strong className={online ? "" : "bad"}>{online ? t("remote.client.online") : t("remote.client.offline")}</strong></div>
        {system && <div><span>GPU</span><strong>{system.gpu.name}</strong></div>}
      </div>
      <div className="row-gap">
        <button className="btn danger" onClick={() => { setConn(null); location.reload(); }}><LogOut size={14} /> {t("remote.client.disconnect")}</button>
      </div>
    </div>
  );
}

/** Karta „Zdalny dostęp" na komputerze z silnikiem: włącznik, tunel, token i link parowania. */
function EngineCard() {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [show, setShow] = useState(false);
  const [pub, setPub] = useState<string | null>(null);
  const [web, setWeb] = useState<string | null>(null);

  const refresh = useCallback(() => api.remoteStatus().then(setSt).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!st) return <div className="card"><Spinner /> {t("loading")}</div>;
  const act = async (p: Promise<RemoteStatus>) => { try { setSt(await p); } catch (e) { toast("error", (e as Error).message); } };
  const base = st.effective_url;
  const link = base ? `${(st.web_ui_url || base)}/#connect=${encodeLink(base, st.token)}` : "";
  const ts = st.tunnel.state;

  return (
    <div className="card">
      <h3><Globe size={15} /> {t("remote.title")}</h3>
      <p className="note small">{t("remote.hint")}</p>
      <Switch checked={st.enabled} onChange={(v) => void act(api.remoteUpdate({ enabled: v, ...(v ? { tunnel: "auto" as const } : {}) }))} label={t("remote.enable")} hint={st.engine_env ? t("remote.engineEnv") : t("remote.enableHint")} />

      {st.enabled && (
        <>
          <div className="remote-row">
            <span className="label">{t("remote.tunnel")}</span>
            <span className={"tpill " + ts}>{t(`remote.tunnel.${ts}`)}</span>
            {ts === "up" || ts === "starting"
              ? <button className="btn small" onClick={() => void act(api.remoteTunnel("stop"))}><Square size={12} /> {t("remote.stop")}</button>
              : <button className="btn small" disabled={!st.tunnel.installed} onClick={() => void act(api.remoteTunnel("start"))}><Play size={12} /> {t("remote.start")}</button>}
          </div>
          {!st.tunnel.installed && (
            <div className="warn small">
              {t("remote.install")} <code>winget install Cloudflare.cloudflared</code> <CopyBtn text="winget install Cloudflare.cloudflared" />
            </div>
          )}
          {ts === "error" && <div className="warn small">{st.tunnel.error}</div>}
          {st.tunnel.url && <div className="remote-row"><code className="trunc">{st.tunnel.url}</code><CopyBtn text={st.tunnel.url} /></div>}

          <div className="pair spaced">
            <div>
              <span className="label">{t("remote.publicUrl")}</span>
              <input type="text" spellCheck={false} placeholder="https://…" value={pub ?? st.public_url} onChange={(e) => setPub(e.target.value)} onBlur={() => pub !== null && void act(api.remoteUpdate({ public_url: pub })).then(() => setPub(null))} />
              <p className="note small">{t("remote.publicUrlHint")}</p>
            </div>
            <div>
              <span className="label">{t("remote.webUrl")}</span>
              <input type="text" spellCheck={false} placeholder="https://moje-studio.vercel.app" value={web ?? st.web_ui_url} onChange={(e) => setWeb(e.target.value)} onBlur={() => web !== null && void act(api.remoteUpdate({ web_ui_url: web })).then(() => setWeb(null))} />
              <p className="note small">{t("remote.webUrlHint")}</p>
            </div>
          </div>

          <div className="remote-row spaced">
            <span className="label"><KeyRound size={13} /> {t("remote.token")}</span>
            <code className="trunc">{show ? st.token : "•".repeat(24)}</code>
            <button className="icon-btn" aria-label={show ? t("remote.hide") : t("remote.show")} onClick={() => setShow(!show)}>{show ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <CopyBtn text={st.token} />
            <button className="btn small danger" title={t("remote.rotateHint")} onClick={() => { if (window.confirm(t("remote.rotateConfirm"))) void act(api.remoteRotate()); }}><RefreshCw size={12} /> {t("remote.rotate")}</button>
          </div>

          <div className="remote-row spaced">
            <span className="label">{t("remote.link")}</span>
            {link ? <><code className="trunc">{link.replace(/#connect=.*/, "#connect=…")}</code><CopyBtn text={link} label={t("remote.copyLink")} /></> : <span className="muted small">{t("remote.noLink")}</span>}
          </div>
          <div className="warn small">{t("remote.security")}</div>
        </>
      )}
    </div>
  );
}

export function RemoteAccess() {
  return isRemote() ? <ClientCard /> : <EngineCard />;
}
