import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Check, Copy, Eye, EyeOff, Globe, KeyRound, LogOut, Power, RefreshCw, X } from "lucide-react";
import { api } from "../api";
import { getConn, isRemote, setConn } from "../connection";
import { useT } from "../i18n";
import { useStore } from "../store";
import type { RemoteStatus } from "../types";
import { Spinner } from "./ui";

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

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  }, [text]);
  return <div className="qr" role="img" aria-label="QR" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Step({ state, label, detail }: { state: "wait" | "run" | "ok" | "err"; label: string; detail?: string }) {
  return (
    <div className={"rstep " + state}>
      <span className="rstep-ico">{state === "ok" ? <Check size={13} /> : state === "run" ? <Spinner size={13} /> : state === "err" ? <X size={13} /> : <i />}</span>
      <span className="rstep-label">{label}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

/** Karta „Zdalny dostęp" na komputerze z silnikiem: jeden przycisk włącza wszystko (instalacja tunelu, tunel, rejestracja adresu). */
function EngineCard() {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pub, setPub] = useState<string | null>(null);
  const [web, setWeb] = useState<string | null>(null);
  const [byp, setByp] = useState<string | null>(null);

  const refresh = useCallback(() => api.remoteStatus().then(setSt).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 1500);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!st) return <div className="card"><Spinner /> {t("loading")}</div>;
  const act = async (p: Promise<RemoteStatus>) => { setBusy(true); try { setSt(await p); } catch (e) { toast("error", (e as Error).message); } setBusy(false); };
  const inst = st.install, tun = st.tunnel, reg = st.registry;
  const online = st.enabled && !!st.effective_url;
  const waiting = st.enabled && (st.tunnel_mode === "auto" || !!st.public_url);
  const needReg = reg.configured && !st.public_url;
  const installing = inst.state === "downloading" || inst.state === "verifying";
  const pct = Math.round(inst.progress * 100);

  return (
    <div className={"card remote-card " + (online ? "online" : "")}>
      <div className="remote-head">
        <span className="remote-globe"><Globe size={20} /></span>
        <div>
          <h3>{t("remote.title")}</h3>
          <p className="note small">{t("remote.hint")}</p>
        </div>
        <span className={"tpill " + (online ? "up" : waiting ? "starting" : "off")}>{online ? t("remote.state.online") : waiting ? t("remote.state.starting") : t("remote.state.off")}</span>
      </div>

      {!st.enabled || (st.tunnel_mode !== "auto" && !st.public_url) ? (
        <>
          <button className="btn amber big" disabled={busy} onClick={() => void act(api.remoteEnable(true))}><Power size={17} /> {t("remote.turnOn")}</button>
          <ul className="remote-bullets">
            <li>{t("remote.b1")}</li><li>{t("remote.b2")}</li><li>{t("remote.b3")}</li>
          </ul>
        </>
      ) : (
        <>
          <div className="rsteps">
            <Step state={tun.installed ? "ok" : inst.state === "error" ? "err" : "run"} label={t("remote.step.install")}
              detail={installing ? `${inst.state === "verifying" ? t("remote.step.verifying") : pct + "%"}` : tun.installed ? undefined : inst.error || undefined} />
            <Step state={tun.state === "up" ? "ok" : tun.state === "error" ? "err" : tun.installed ? "run" : "wait"} label={t("remote.step.tunnel")} detail={tun.state === "error" ? tun.error : undefined} />
            {needReg && <Step state={reg.state === "ok" ? "ok" : reg.state === "error" ? "err" : tun.state === "up" ? "run" : "wait"} label={t("remote.step.register")} detail={reg.state === "error" ? reg.error : undefined} />}
          </div>
          {installing && <div className="loadingtrack wide"><div style={{ width: `${pct}%` }} /></div>}
          {(inst.state === "error" || tun.state === "error") && (
            <button className="btn small" onClick={() => void act(api.remoteTunnel("start"))}><RefreshCw size={13} /> {t("retry")}</button>
          )}

          {online && st.link && (
            <div className="remote-online">
              <Qr text={st.link} />
              <div className="remote-online-side">
                <b>{t("remote.ready")}</b>
                <p className="note small">{st.link_stable ? t("remote.stable") : st.web_ui_url ? t("remote.unstable") : t("remote.viaEngine")}</p>
                <div className="row-gap">
                  <CopyBtn text={st.link} label={t("remote.copyLink")} />
                  <button className="btn small ghost" onClick={() => void act(api.remoteEnable(false))}><Power size={13} /> {t("remote.turnOff")}</button>
                </div>
                <small className="muted trunc">{st.effective_url}</small>
              </div>
            </div>
          )}
          {!online && (
            <div className="row-gap">
              <button className="btn small ghost" onClick={() => void act(api.remoteEnable(false))}><Power size={13} /> {t("remote.turnOff")}</button>
            </div>
          )}
        </>
      )}

      <details className="remote-adv">
        <summary>{t("remote.advanced")}</summary>
        <div className="remote-row">
          <span className="label"><KeyRound size={13} /> {t("remote.token")}</span>
          <code className="trunc">{show ? st.token : "•".repeat(24)}</code>
          <button className="icon-btn" aria-label={show ? t("remote.hide") : t("remote.show")} onClick={() => setShow(!show)}>{show ? <EyeOff size={13} /> : <Eye size={13} />}</button>
          <CopyBtn text={st.token} />
          <button className="btn small danger" title={t("remote.rotateHint")} onClick={() => { if (window.confirm(t("remote.rotateConfirm"))) void act(api.remoteRotate()); }}><RefreshCw size={12} /> {t("remote.rotate")}</button>
        </div>
        <div className="pair spaced">
          <div>
            <span className="label">{t("remote.webUrl")}</span>
            <input type="text" spellCheck={false} placeholder="https://moje-studio.vercel.app" value={web ?? st.web_ui_url} onChange={(e) => setWeb(e.target.value)} onBlur={() => web !== null && void act(api.remoteUpdate({ web_ui_url: web })).then(() => setWeb(null))} />
            <p className="note small">{t("remote.webUrlHint")}</p>
          </div>
          <div>
            <span className="label">{t("remote.bypass")}</span>
            <input type="password" autoComplete="off" spellCheck={false} placeholder="••••••••" value={byp ?? (reg.protected ? "••••••••••••" : "")} onFocus={() => byp === null && setByp("")} onChange={(e) => setByp(e.target.value)} onBlur={() => byp && void act(api.remoteUpdate({ rv_bypass: byp })).then(() => setByp(null))} />
            <p className="note small">{t("remote.bypassHint")}</p>
          </div>
        </div>
        <div>
          <span className="label">{t("remote.publicUrl")}</span>
          <input type="text" spellCheck={false} placeholder="https://…" value={pub ?? st.public_url} onChange={(e) => setPub(e.target.value)} onBlur={() => pub !== null && void act(api.remoteUpdate({ public_url: pub })).then(() => setPub(null))} />
          <p className="note small">{t("remote.publicUrlHint")}</p>
        </div>
        <div className="warn small">{t("remote.security")}</div>
      </details>
    </div>
  );
}

export function RemoteAccess() {
  return isRemote() ? <ClientCard /> : <EngineCard />;
}
