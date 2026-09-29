/** A runtime fixture: flow and status must keep working if TUI modules cannot load. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.includes("/dist/cli/tui/")) {
    throw new Error(`TUI_IMPORT_FORBIDDEN: ${resolved.url}`);
  }
  return resolved;
}
