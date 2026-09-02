import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { homeRelative } from "../../src/application/display-path.js";

describe("homeRelative", () => {
  const home = join(sep, "Users", "x");

  it("shortens a path under home to ~ and leaves every other path alone", () => {
    expect(homeRelative(join(home, ".claude", "settings.json"), home)).toBe(
      `~${sep}.claude${sep}settings.json`,
    );
    expect(homeRelative(home, home)).toBe("~");
    // A sibling that merely shares the prefix is not inside home.
    expect(homeRelative(join(sep, "Users", "xy", ".claude.json"), home)).toBe(
      join(sep, "Users", "xy", ".claude.json"),
    );
    expect(homeRelative(join(sep, "etc", "hosts"), home)).toBe(join(sep, "etc", "hosts"));
  });

  it("tolerates a home that ends in a separator, as $HOME sometimes does", () => {
    expect(homeRelative(join(home, ".codex", "config.toml"), `${home}${sep}`)).toBe(
      `~${sep}.codex${sep}config.toml`,
    );
  });
});
