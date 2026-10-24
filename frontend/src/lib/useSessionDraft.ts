import { useRef, useState } from "react";

// A newer hook instance can save the same old text after a failed write.
const latestDraftWrite = new Map<string, symbol>();

// Drafts are tab-scoped. Model credentials must never use this hook.
export function useSessionDraft(key: string) {
  const [values, setValues] = useState<Record<string, string>>({});
  const failedWrites = useRef(
    new Map<
      string,
      { value: string; observed: string | null | undefined; generation: symbol }
    >(),
  );
  let saved = "";
  try {
    saved = sessionStorage.getItem(key) || "";
  } catch {
    // A full/disabled browser store must not prevent writing a message.
  }
  const value = values[key] ?? saved;
  function write(next: string, targetKey = key) {
    const generation = Symbol();
    latestDraftWrite.set(targetKey, generation);
    let observed: string | null | undefined;
    try {
      observed = sessionStorage.getItem(targetKey);
    } catch {
      // Reading and writing can fail independently.
    }
    try {
      if (next) sessionStorage.setItem(targetKey, next);
      else sessionStorage.removeItem(targetKey);
      failedWrites.current.delete(targetKey);
    } catch {
      // Keep the active draft in memory when browser persistence is unavailable.
      failedWrites.current.set(targetKey, {
        value: next,
        observed,
        generation,
      });
    }
    setValues((previous) => ({ ...previous, [targetKey]: next }));
  }
  function clear(targetKey = key, expectedValue?: string) {
    if (expectedValue === undefined) {
      write("", targetKey);
      return;
    }
    let preserveStored = false;
    try {
      const stored = sessionStorage.getItem(targetKey);
      const failed = failedWrites.current.get(targetKey);
      if (
        (stored || "") === expectedValue ||
        (failed?.value === expectedValue &&
          failed.observed !== undefined &&
          latestDraftWrite.get(targetKey) === failed.generation &&
          stored === failed.observed)
      ) {
        sessionStorage.removeItem(targetKey);
      } else {
        preserveStored = true;
      }
    } catch {
      // When storage is unavailable, preserve a newer in-memory value too.
    }
    if (failedWrites.current.get(targetKey)?.value === expectedValue)
      failedWrites.current.delete(targetKey);
    setValues((previous) => {
      if (
        previous[targetKey] !== undefined &&
        previous[targetKey] !== expectedValue
      )
        return previous;
      if (preserveStored) {
        const next = { ...previous };
        delete next[targetKey];
        return next;
      }
      return { ...previous, [targetKey]: "" };
    });
  }
  return [value, (next: string) => write(next), clear] as const;
}
