import { describe, expect, it } from "vitest";
import {
  compareCorrelatives,
  isCorrelative,
  leadingCorrelative,
  maxCorrelative,
  nextCorrelative,
  normalizeCorrelativeInput,
  prefixedCorrelativeInput,
} from "../../src/domain/correlative.js";

describe("Workline correlatives", () => {
  it("uses three digits as a floor, not a ceiling", () => {
    expect(isCorrelative("099")).toBe(true);
    expect(isCorrelative("999")).toBe(true);
    expect(isCorrelative("1000")).toBe(true);
    expect(isCorrelative("99")).toBe(false);
  });

  it("advances 999 to 1000", () => {
    expect(nextCorrelative("999")).toBe("1000");
  });

  it("compares by numeric identity rather than lexical width", () => {
    expect(compareCorrelatives("999", "1000")).toBeLessThan(0);
    expect(maxCorrelative(["1000", "999", "010"])).toBe("1000");
  });

  it("reads the complete leading number instead of slicing three characters", () => {
    expect(leadingCorrelative("1000-plan-corte.md")).toBe("1000");
    expect(leadingCorrelative("1000plan-corte.md")).toBeNull();
  });

  it("normalizes legacy input without accepting short persisted identities", () => {
    expect(normalizeCorrelativeInput("7")).toBe("007");
    expect(normalizeCorrelativeInput("1000")).toBe("1000");
    expect(prefixedCorrelativeInput("session24", "session")).toBe("024");
    expect(isCorrelative("7")).toBe(false);
  });
});
