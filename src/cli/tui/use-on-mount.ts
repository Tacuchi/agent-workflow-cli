import { useEffect, useRef } from "react";

/**
 * Run `fn` exactly once on first mount. Ref-guarded so later identity changes
 * of `fn` never re-fire it (first-mount captures, matching the started-ref
 * pattern it replaces).
 */
export function useOnMount(fn: () => void): void {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fn();
  }, [fn]);
}
