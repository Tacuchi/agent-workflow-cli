/** TUI and direct Git tools must not import the flow engine or sessions service. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    ["/dist/application/flow/", "/dist/domain/flow/", "/dist/application/sessions-service.js"].some(
      (segment) => resolved.url.includes(segment),
    )
  ) {
    throw new Error(`FLOW_IMPORT_FORBIDDEN: ${resolved.url}`);
  }
  return resolved;
}
