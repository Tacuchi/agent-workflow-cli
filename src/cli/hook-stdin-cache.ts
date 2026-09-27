// The thin entry reads the advisor's payload before loading the full CLI.
// Hand the same bytes to its normal hook command without reading fd 0 twice.
let pending: string | undefined;

export function cacheHookStdin(value: string | undefined): void {
  pending = value;
}

export function takeHookStdin(): string | undefined {
  const value = pending;
  pending = undefined;
  return value;
}
