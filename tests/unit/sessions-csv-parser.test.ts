import { describe, expect, it } from "vitest";
import {
  SessionsCsvError,
  validateSessionsExist,
} from "../../src/application/parsers/sessions-csv.js";
import { MemFs as FakeFs } from "../helpers/mem-fs.js";

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
