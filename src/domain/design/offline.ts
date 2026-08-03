import type { DesignFailure } from "./validation.js";

/**
 * The offline guarantee of a portable export, checked as a REJECTION.
 *
 * AC-REN-07 is not "prefer local assets": an offline preview that loads a font,
 * a script, an image or a datum from a URL shows something different the day the
 * network, the CDN or the account is gone — and it fails silently, looking like a
 * rendering quirk. So a remote resource here is a validation error, never a
 * warning: the whole value of a local snapshot is that what you see is what the
 * package contains.
 *
 * Two deliberate calls.
 *
 * **It scans text instead of parsing.** A parser would tell a reference apart
 * from prose, at the cost of a dependency, and would still have to decide what a
 * URL inside a `style` attribute is. Scanning over-detects at worst, and in this
 * direction over-detection is the safe failure: the author moves the URL out of
 * the export and the export stays self-sufficient.
 *
 * **A hyperlink counts too.** `<a href="https://figma.com/…">` loads nothing
 * until somebody clicks it, so a stricter reading would let it through. It is
 * still reported, because the package already has the right place for that
 * pointer — `provider.locator` in `rendition.json`, where a locator is recorded
 * as a locator and cannot be mistaken for the evidence. Keeping the export free
 * of every absolute URL is also what makes this check a scan rather than a parse.
 *
 * What is allowed is what travels inside the file or beside it: `data:` URIs,
 * fragments, and paths relative to the rendition's own directory.
 */

/** A remote reference: any scheme-qualified or protocol-relative URL. */
const REMOTE_URL = /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?<![a-z0-9+.:/])\/\/)[^\s"'`)<>]+/gi;

/** Schemes that carry their content inline, so they are not remote at all. */
const INLINE_SCHEMES = /^(?:data|blob|about|cid):/i;

/**
 * `xmlns`/`xmlns:prefix` attributes, blanked before scanning.
 *
 * A namespace URI is an IDENTIFIER, not a fetch: nothing resolves
 * `http://www.w3.org/2000/svg` over the network. And every inline SVG carries
 * one, so treating it as a remote resource would reject exactly the format the
 * static-preview requirement recommends.
 */
const NAMESPACE_ATTRIBUTE = /\bxmlns(?::[A-Za-z][\w.-]*)?\s*=\s*(?:"[^"]*"|'[^']*')/gi;

/** Runtime calls that fetch at display time, whatever the URL looks like. */
const NETWORK_CALLS: ReadonlyArray<[RegExp, string]> = [
  [/\bfetch\s*\(/i, "fetch()"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bnew\s+WebSocket\b/, "WebSocket"],
  [/\bnew\s+EventSource\b/, "EventSource"],
  [/\bimportScripts\s*\(/i, "importScripts()"],
  [/\bnavigator\s*\.\s*sendBeacon\b/, "navigator.sendBeacon()"],
];

/**
 * Judge an HTML export's self-sufficiency.
 *
 * Every finding quotes the offending text so the author can search for it: in a
 * 400-line export, "there is a remote resource somewhere" is a dead end, and
 * this is the one check whose fix always starts by finding that string.
 */
export function checkOfflineHtml(html: string, artifact: string): DesignFailure[] {
  const scannable = html.replace(NAMESPACE_ATTRIBUTE, "");
  const failures: DesignFailure[] = [];

  for (const url of remoteUrls(scannable)) {
    failures.push({
      code: "DESIGN_REMOTE_RESOURCE",
      artifact,
      message: `el export referencia '${url}', que vive fuera del package`,
      action:
        "un export portable es autosuficiente: incrustá el recurso (inline o como data: URI), usá una ruta relativa a la carpeta de la rendition, o registrá el locator del proveedor en 'provider.locator'",
    });
  }
  for (const [pattern, what] of NETWORK_CALLS) {
    if (!pattern.test(scannable)) continue;
    failures.push({
      code: "DESIGN_REMOTE_RESOURCE",
      artifact,
      message: `el export usa ${what}: pide datos en tiempo de visualización`,
      action:
        "incrustá en el propio HTML los datos que la preview necesita: sin red tiene que verse igual",
    });
  }
  return failures;
}

/** Every distinct remote URL in the text, in order of appearance. */
function remoteUrls(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(REMOTE_URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (INLINE_SCHEMES.test(url) || out.includes(url)) continue;
    out.push(url);
  }
  return out;
}
