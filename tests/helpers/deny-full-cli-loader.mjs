/** A runtime fixture: the thin entry must fail the SQL guard closed when the full CLI cannot load. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("/dist/cli/full-cli.js")) {
    throw new Error(`FULL_CLI_IMPORT_FORBIDDEN: ${resolved.url}`);
  }
  return resolved;
}
