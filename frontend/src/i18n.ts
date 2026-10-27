// Minimalny i18n: słownik angielski jest bazą, pozostałe języki nadpisują klucze (brak => EN).
import { useSyncExternalStore } from "react";
import { locales } from "./locales";

export type Lang = "pl" | "en" | "de" | "fr" | "es";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "pl", label: "Polski" },
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
];

const KEY = "is.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS.some((l) => l.id === saved)) return saved as Lang;
  } catch { /* brak localStorage */ }
  const cands = [...(navigator.languages ?? []), navigator.language];
  for (const c of cands) {
    const code = (c || "").slice(0, 2).toLowerCase();
    if (LANGS.some((l) => l.id === code)) return code as Lang;
  }
  return "en";
}

let current: Lang = detect();
const listeners = new Set<() => void>();

export function getLang(): Lang { return current; }

export function setLang(l: Lang) {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* ignoruj */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}

export function tr(key: string, vars?: Record<string, string | number>): string {
  let s = locales[current]?.[key] ?? locales.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export type TFn = typeof tr;

/** Hook: odświeża komponent po zmianie języka. */
export function useT(): TFn {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => current,
  );
  return tr;
}

if (typeof document !== "undefined") document.documentElement.lang = current;
