import { describe, expect, it } from "vitest";
import {
  SessionsCsvError,
  parseSessionsCsv,
  validateSessionsExist,
} from "../../src/application/parsers/sessions-csv.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

describe("parseSessionsCsv", () => {
  it("returns single code padded to 3 digits", () => {
    expect(parseSessionsCsv("55")).toEqual(["055"]);
  });

  it("returns multiple codes preserving order", () => {
    expect(parseSessionsCsv("055,057,061")).toEqual(["055", "057", "061"]);
  });

  it("normalizes mixed padding", () => {
    expect(parseSessionsCsv("55,57,061")).toEqual(["055", "057", "061"]);
  });

  it("trims whitespace around tokens", () => {
    expect(parseSessionsCsv("  055 , 057 ")).toEqual(["055", "057"]);
  });

  it("throws INVALID_INPUT on empty input", () => {
    expect(() => parseSessionsCsv("")).toThrow(SessionsCsvError);
    expect(() => parseSessionsCsv("   ")).toThrow(/--sessions vacío/);
  });

  it("throws INVALID_INPUT on non-numeric token", () => {
    try {
      parseSessionsCsv("055,abc");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionsCsvError);
      expect((e as SessionsCsvError).code).toBe("INVALID_INPUT");
      expect((e as SessionsCsvError).message).toContain("abc");
    }
  });

  it("throws INVALID_INPUT on >3 digit token", () => {
    expect(() => parseSessionsCsv("0055")).toThrow(/inválido/);
  });

  it("throws INVALID_INPUT on duplicates (post-normalization)", () => {
    try {
      parseSessionsCsv("055,55");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as SessionsCsvError).code).toBe("INVALID_INPUT");
      expect((e as SessionsCsvError).message).toContain("055");
    }
  });

  it("ignores empty tokens between commas", () => {
    expect(parseSessionsCsv("055,,057")).toEqual(["055", "057"]);
  });
});

describe("validateSessionsExist", () => {
  const DIR = "/cwd/.workflow/sessions";

  it("passes when all codes have matching session folders", async () => {
    const fs = new FakeFs()
      .dir(`${DIR}/session055-dev-foo`)
      .dir(`${DIR}/session057-analyze-bar`)
      .dir(`${DIR}/session061-dev-baz`);
    await expect(validateSessionsExist(fs, DIR, ["055", "057"])).resolves.toBeUndefined();
  });

  it("throws UNKNOWN_SESSION listing missing codes", async () => {
    const fs = new FakeFs().dir(`${DIR}/session055-dev-foo`);
    try {
      await validateSessionsExist(fs, DIR, ["055", "999"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SessionsCsvError);
      expect((e as SessionsCsvError).code).toBe("UNKNOWN_SESSION");
      expect((e as SessionsCsvError).message).toContain("999");
      expect((e as SessionsCsvError).message).not.toContain("055");
    }
  });

  it("throws UNKNOWN_SESSION when sessions dir is empty", async () => {
    const fs = new FakeFs().dir(DIR);
    await expect(validateSessionsExist(fs, DIR, ["055"])).rejects.toThrow(/no encontrados.*055/);
  });

  it("ignores folders that don't match the sessionNNN- pattern", async () => {
    const fs = new FakeFs()
      .dir(`${DIR}/session055-dev-foo`)
      .dir(`${DIR}/scratch-folder`)
      .dir(`${DIR}/session_legacy`);
    await expect(validateSessionsExist(fs, DIR, ["055"])).resolves.toBeUndefined();
  });
});
