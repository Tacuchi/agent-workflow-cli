import { type LocalProposal, sealProposal } from "../../domain/proposal.js";
import type { ByteIdentity } from "../../ports/archive.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { type CompactionDeps, type HubInventory, inventoryHub } from "./inventory.js";
import { compactionError, inside, operationRelative, safeRelative } from "./paths.js";

export const VIEW_PATH = "docs/context/hub.md";
export const CLAIM_KINDS = [
  "fact",
  "decision",
  "hypothesis",
  "contradiction",
  "pending-validation",
  "pending-work",
] as const;
export interface KnowledgeClaim {
  topic: string;
  kind: (typeof CLAIM_KINDS)[number];
  text: string;
  references: string[];
}
export interface CompactionInput {
  version: 1;
  inventory_fingerprint: string;
  claims: KnowledgeClaim[];
  selection: string[];
}
export interface SelectedOriginal extends ByteIdentity {
  path: string;
  archive: string;
}
export interface CompactionProposal {
  version: 1;
  id: string;
  request: CompactionInput;
  inventory: HubInventory;
  originals: SelectedOriginal[];
  local: LocalProposal;
  view: string;
  catalog: string;
  policy: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw compactionError("INPUT", "Se esperaba un objeto JSON");
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw compactionError("INPUT", "El JSON incluye campos fuera del contrato");
  }
}
function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 32_768) {
    throw compactionError("INPUT", "Texto ausente o mayor al límite de 32768 caracteres");
  }
  return value;
}
function stringSet(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw compactionError("INPUT", "Se esperaba una lista acotada");
  const paths = value.map((path) => safeRelative(nonempty(path)));
  if (new Set(paths).size !== paths.length) throw compactionError("INPUT", "Hay rutas repetidas");
  return paths.sort();
}

function claim(value: unknown): KnowledgeClaim {
  const raw = object(value);
  keys(raw, ["topic", "kind", "text", "references"]);
  const kind = nonempty(raw.kind);
  if (!(CLAIM_KINDS as readonly string[]).includes(kind))
    throw compactionError("INPUT", `Tipo de afirmación desconocido: ${kind}`);
  const references = stringSet(raw.references);
  if (references.length === 0 || (kind === "contradiction" && references.length < 2)) {
    throw compactionError(
      "REFERENCES",
      "Cada afirmación requiere fuentes; una contradicción requiere ambas referencias",
    );
  }
  return {
    topic: nonempty(raw.topic),
    kind: kind as KnowledgeClaim["kind"],
    text: nonempty(raw.text),
    references,
  };
}

export function parseCompactionInput(value: unknown): CompactionInput {
  const raw = object(value);
  keys(raw, ["version", "inventory_fingerprint", "claims", "selection"]);
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.claims) ||
    raw.claims.length === 0 ||
    raw.claims.length > 1000
  ) {
    throw compactionError(
      "INPUT",
      "Se requiere version 1 y entre 1 y 1000 afirmaciones referenciadas",
    );
  }
  const fingerprint = nonempty(raw.inventory_fingerprint);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint))
    throw compactionError("INPUT", "Huella de inventario inválida");
  return {
    version: 1,
    inventory_fingerprint: fingerprint,
    claims: raw.claims
      .map(claim)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    selection: stringSet(raw.selection),
  };
}

export function compactionId(request: CompactionInput): string {
  return semanticDigest(request);
}

function renderView(request: CompactionInput, inventory: HubInventory): string {
  const lines = [
    "# Conocimiento del hub",
    "",
    "Síntesis aportada por el host y revisada por la persona; sus referencias no prueban por sí solas una afirmación.",
    "",
    `Inventario: ${inventory.fingerprint}`,
    "",
  ];
  for (const kind of CLAIM_KINDS) {
    const claims = request.claims.filter((item) => item.kind === kind);
    if (claims.length === 0) continue;
    lines.push(`## ${kind}`, "");
    for (const item of claims) {
      lines.push(
        `### ${item.topic}`,
        "",
        item.text,
        "",
        ...item.references.map((path) => {
          const original = inventory.entries.find((e) => e.path === path);
          return `- [${path}](../../${path}) · sha256:${original?.sha256} · original: aw hub-compact inspect ${compactionId(request)} --path ${JSON.stringify(path)}`;
        }),
        "",
      );
    }
  }
  lines.push("## Límites", "", ...inventory.coverage.limitations.map((limit) => `- ${limit}`), "");
  return lines.join("\n");
}

function selectOriginals(
  request: CompactionInput,
  inventory: HubInventory,
  catalog: string,
): SelectedOriginal[] {
  return request.selection.map((path, index) => {
    const entry = inventory.entries.find((e) => e.path === path);
    if (
      !entry ||
      entry.disposition !== "eligible" ||
      entry.bytes === null ||
      entry.sha256 === null
    ) {
      throw compactionError("PROTECTED", `Original ausente o protegido: ${path}`);
    }
    return {
      path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      archive: `${catalog}/originals/${index}.gz`,
    };
  });
}

export async function prepareCompaction(
  deps: CompactionDeps,
  value: unknown,
): Promise<CompactionProposal> {
  const request = parseCompactionInput(value);
  const inventory = await inventoryHub(deps);
  if (request.inventory_fingerprint !== inventory.fingerprint)
    throw compactionError("STALE", "Cambió el inventario; prepará y revisá otra propuesta");
  for (const item of request.claims)
    for (const path of item.references) {
      if (
        path === VIEW_PATH ||
        !inventory.entries.some((e) => e.path === path && e.sha256 !== null)
      ) {
        throw compactionError(
          "REFERENCES",
          `Referencia ausente, excluida o síntesis anterior: ${path}`,
        );
      }
    }
  const id = compactionId(request);
  const catalog = operationRelative(deps.paths, id);
  await inside(deps.fs, deps.paths.hubDir(), catalog);
  await inside(deps.fs, deps.paths.hubDir(), VIEW_PATH);
  const originals = selectOriginals(request, inventory, catalog);
  const view = renderView(request, inventory);
  const policy =
    "Verificar gzip antes de retirar; conservar originales cuyo archivo no ahorre bytes; restaurar exclusivamente sin sobrescribir";
  const metadata = JSON.stringify({ version: 1, id, request, originals, policy });
  const local = sealProposal({
    operation: "hub-compact.apply",
    artifacts: [
      {
        path: VIEW_PATH,
        content: view,
        overwrite: inventory.entries.some((e) => e.path === VIEW_PATH),
      },
      { path: `${catalog}/proposal.json`, content: metadata, overwrite: false },
    ],
    bases: [{ path: ".", digest: inventory.fingerprint }],
    scope: { hub_root: inventory.root },
    effects: ["local_additive", "mutate_overwrite"],
    requiresApproval: ["mutate_overwrite"],
  });
  return { version: 1, id, request, inventory, originals, local, view, catalog, policy };
}
