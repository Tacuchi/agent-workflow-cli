import { deepStrictEqual } from "node:assert";
import { TomlDate, parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { parseToml } from "../../src/application/parsers/toml.js";

describe("parseToml", () => {
  it("normaliza tablas de prototipo nulo sin perder valores TOML ni claves propias", () => {
    const text = `
created = 2026-09-27T08:00:00Z
ratio = nan
limit = inf
rules = [{ enabled = true, labels = ["alpha"] }]

[mcp_servers.alpha]
command = "aw"
args = ["mcp", "serve-db"]
[mcp_servers.alpha.env]
DEMO = "value"
__proto__ = { polluted = true }
constructor = "preserved"
`;
    expect(Object.getPrototypeOf(parse(text))).toBeNull();

    // Node's strict comparison also checks nested prototypes, unlike toEqual.
    deepStrictEqual(parseToml(text), {
      created: new TomlDate("2026-09-27T08:00:00Z"),
      ratio: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
      rules: [{ enabled: true, labels: ["alpha"] }],
      mcp_servers: {
        alpha: {
          command: "aw",
          args: ["mcp", "serve-db"],
          env: {
            DEMO: "value",
            ["__proto__"]: { polluted: true },
            constructor: "preserved",
          },
        },
      },
    });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
