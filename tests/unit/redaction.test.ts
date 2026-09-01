import { describe, expect, it } from "vitest";
import {
  containsSensitiveData,
  redactSensitiveText,
  redactSensitiveValue,
} from "../../src/domain/redaction.js";

describe("redaction", () => {
  it("oculta valores opacos bajo claves sensibles en estructuras anidadas", () => {
    const value = {
      databaseUrl: "opaque-connection-value",
      nested: { accessToken: "opaque-token" },
      items: [{ password: "opaque-password" }],
      safe: "visible",
    };

    expect(redactSensitiveValue(value)).toEqual({
      databaseUrl: "***",
      nested: { accessToken: "***" },
      items: [{ password: "***" }],
      safe: "visible",
    });
    expect(containsSensitiveData(value)).toBe(true);
  });

  it("detecta autorizaciones textuales y deja datos no sensibles intactos", () => {
    expect(redactSensitiveText("Authorization: opaque-value")).toBe("Authorization: ***");
    expect(redactSensitiveValue({ label: "visible", nested: { count: 1 } })).toEqual({
      label: "visible",
      nested: { count: 1 },
    });
    expect(containsSensitiveData({ label: "visible", nested: { count: 1 } })).toBe(false);
  });
});
