import { describe, expect, it } from "vitest";
import { parseFuentesSpecs } from "../../src/cli/parsers/fuentes.js";

function ok(spec: string) {
  const r = parseFuentesSpecs([spec]);
  if ("error" in r) throw new Error(`unexpected error: ${r.error}`);
  return r.fuentes[0];
}

describe("parseFuentesSpecs", () => {
  it("separa alias:path en posix", () => {
    expect(ok("cli:/Users/me/Git/cli")).toEqual({
      alias: "cli",
      path: "/Users/me/Git/cli",
    });
  });

  it("acepta el 3er campo opcional alias:path:rama", () => {
    expect(ok("cli:/Users/me/Git/cli:main")).toEqual({
      alias: "cli",
      path: "/Users/me/Git/cli",
      mainBranch: "main",
    });
  });

  // Regresión: el colon de unidad de Windows colapsaba el path a "C".
  it("preserva rutas Windows con colon de unidad (sin rama)", () => {
    expect(ok("front:C:\\Source\\msextranet_front_angular")).toEqual({
      alias: "front",
      path: "C:\\Source\\msextranet_front_angular",
    });
  });

  it("separa la rama en rutas Windows cuando se da el 3er campo", () => {
    expect(ok("front:C:\\Source\\app:certificacion")).toEqual({
      alias: "front",
      path: "C:\\Source\\app",
      mainBranch: "certificacion",
    });
  });

  it("acepta forward-slash en rutas Windows (C:/...)", () => {
    expect(ok("front:C:/Source/app")).toEqual({
      alias: "front",
      path: "C:/Source/app",
    });
  });

  it("preserva rutas extended-length (\\\\?\\C:\\...)", () => {
    expect(ok("front:\\\\?\\C:\\Source\\app")).toEqual({
      alias: "front",
      path: "\\\\?\\C:\\Source\\app",
    });
  });

  it("rechaza formato sin colon", () => {
    const r = parseFuentesSpecs(["solopath"]);
    expect("error" in r).toBe(true);
  });
});
