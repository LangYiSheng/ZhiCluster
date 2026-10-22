import { useState } from "react";

// Drafts are tab-scoped. Model credentials must never use this hook.
export function useSessionDraft(key: string) {
  const [values, setValues] = useState<Record<string, string>>({});
  let saved = "";
  try {
    saved = sessionStorage.getItem(key) || "";
  } catch {
    // A full/disabled browser store must not prevent writing a message.
  }
  const value = values[key] ?? saved;
  function write(next: string, targetKey = key) {
    try {
      if (next) sessionStorage.setItem(targetKey, next);
      else sessionStorage.removeItem(targetKey);
    } catch {
      // Keep the active draft in memory when browser persistence is unavailable.
    }
    setValues((previous) => ({ ...previous, [targetKey]: next }));
  }
  return [
    value,
    (next: string) => write(next),
    (targetKey = key) => write("", targetKey),
  ] as const;
}
