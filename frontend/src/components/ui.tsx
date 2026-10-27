import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";
import { useT } from "../i18n";

/** Techniczne nazwy angielskie parametrów (nie tłumaczone). */
export const TECH: Record<string, string> = {
  model: "Model", mode: "Mode", prompt: "Prompt", negative: "Negative prompt", source: "Source image", refs: "Reference images",
  presets: "Presets", ratio: "Aspect ratio", resolution: "Resolution", size: "Width × Height", steps: "Steps", cfg: "CFG / Guidance scale",
  seed: "Seed", batch: "Batch size", sampler: "Sampler", scheduler: "Scheduler", denoise: "Denoise / Strength",
  lora: "LoRA", loraStrength: "LoRA strength", mask: "Inpainting mask", offload: "Offload", precision: "Precision",
};

interface HelpProps { k: string; def?: string }

/** Ikona pomocy z tooltipem: nazwa PL (tech EN) + opis + wartość domyślna dla bieżącego modelu. */
export function Help({ k, def }: HelpProps) {
  const t = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ x: r.right + 8, y: r.top - 6 });
  };
  const hide = () => setPos(null);

  useLayoutEffect(() => {
    if (!pos || !tip.current) return;
    const w = tip.current.offsetWidth;
    const h = tip.current.offsetHeight;
    const x = Math.max(8, Math.min(pos.x, window.innerWidth - w - 8));
    const y = Math.max(8, Math.min(pos.y, window.innerHeight - h - 8));
    tip.current.style.left = x + "px";
    tip.current.style.top = y + "px";
    tip.current.style.visibility = "visible";
  }, [pos]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="help"
        aria-label={t("help")}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); pos ? hide() : show(); }}
      >
        ?
      </button>
      {pos &&
        createPortal(
          <div ref={tip} className="tooltip" role="tooltip" style={{ visibility: "hidden" }}>
            <div className="tip-title">
              {t(`p.${k}.name`)} <span>({TECH[k] ?? k})</span>
            </div>
            <div>{t(`p.${k}.desc`)}</div>
            {def && (
              <div className="tip-default">
                <b>{t("default")}:</b> {def}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Label({ k, text, def }: { k: string; text?: string; def?: string }) {
  const t = useT();
  return (
    <span className="label">
      {text ?? t(`p.${k}.name`)} <Help k={k} def={def} />
    </span>
  );
}

export function Section({ title, helpKey, right, children, className }: {
  title: ReactNode; helpKey?: string; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={"section " + (className ?? "")}>
      <div className="section-head">
        <strong>
          {title} {helpKey && <Help k={helpKey} />}
        </strong>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Collapse({ title, open, onToggle, children, badge }: {
  title: string; open: boolean; onToggle: () => void; children: ReactNode; badge?: ReactNode;
}) {
  return (
    <section className="section">
      <button className="collapse" onClick={onToggle} aria-expanded={open}>
        <span>{title} {badge}</span>
        <span className={"chev " + (open ? "open" : "")}>›</span>
      </button>
      {open && <div className="fold">{children}</div>}
    </section>
  );
}

/** Przełącznik on/off z opisem (np. „Ustawienia zaawansowane"). */
export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={"switch-row " + (checked ? "on" : "")} onClick={() => onChange(!checked)}>
      <span className="switch-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <span className="switch-track"><i /></span>
    </button>
  );
}

export function Range({ k, value, min, max, step, onChange, format, def, label }: {
  k: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
  format?: (v: number) => string; def?: string; label?: string;
}) {
  return (
    <div className="range-field">
      <div className="range-top">
        <Label k={k} text={label} def={def} />
        <output>{format ? format(value) : value}</output>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} style={{ "--p": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/** Znak Image Studio: iskra w gradientowym kwadracie. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 40 40" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ff8a3d" /><stop offset=".5" stopColor="#ff3d81" /><stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#lg)" />
      <path d="M20 8.5c.7 5.6 2.9 8.8 11.5 11.5-8.6 2.7-10.8 5.9-11.5 11.5-.7-5.6-2.9-8.8-11.5-11.5C17.1 17.3 19.3 14.1 20 8.5Z" fill="#000" fillOpacity=".86" />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden />;
}

export function Empty({ icon, title, hint, children }: { icon?: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <strong>{title}</strong>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}

export const HelpIcon = HelpCircle;
