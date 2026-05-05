export type Namespace = string & { readonly __brand: "namespace" };

const NAMESPACE_REGEX = /^[a-z][a-z0-9-]{1,30}$/;

export function isValidNamespace(value: string): boolean {
  return NAMESPACE_REGEX.test(value);
}

export function normalizeNamespace(value: string): Namespace {
  const trimmed = value.trim();
  if (!isValidNamespace(trimmed)) {
    throw new Error(`Invalid namespace '${trimmed}'. Must match ${NAMESPACE_REGEX.source}.`);
  }
  return trimmed as Namespace;
}
