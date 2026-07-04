import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { LaunchDescriptor } from "../../src/application/source-launch-scripts-service.js";
import {
  type LaunchFormValue,
  SourceLaunchForm,
} from "../../src/cli/tui/components/source-launch-form.js";

const ENTER = "\r";
const DOWN = "\x1B[B";
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function descriptor(over: Partial<LaunchDescriptor> = {}): LaunchDescriptor {
  return {
    version: 1,
    source: "app",
    stack: "npm",
    cwd: "/src/app",
    command: "npm",
    args: ["run", "dev"],
    params: [{ name: "PORT", default: "3000", secret: false }],
    profiles: ["dev", "prod"],
    ...over,
  };
}

describe("SourceLaunchForm", () => {
  it("pick a profile then accept the param default → submits {profile, values}", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <SourceLaunchForm descriptor={descriptor()} onSubmit={onSubmit} onCancel={() => {}} />,
    );
    await tick();
    expect(lastFrame() ?? "").toContain("perfil");
    expect(lastFrame() ?? "").toContain("dev");

    stdin.write(DOWN); // "(sin perfil)" option → dev
    await tick();
    stdin.write(ENTER); // confirm profile → param step
    await tick();
    expect(lastFrame() ?? "").toContain("PORT");

    stdin.write(ENTER); // accept default "3000"
    await tick();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const value = onSubmit.mock.calls[0]?.[0] as LaunchFormValue;
    expect(value.profile).toBe("dev");
    expect(value.values.PORT).toBe("3000");
  });

  it("a descriptor with no profiles goes straight to the param step", async () => {
    const onSubmit = vi.fn();
    const { lastFrame } = render(
      <SourceLaunchForm
        descriptor={descriptor({ profiles: [] })}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await tick();
    // No profile picker — straight to the param input.
    expect(lastFrame() ?? "").toContain("PORT");
    expect(lastFrame() ?? "").not.toContain("perfil");
  });

  it("marks a secret param and does not prefill it", async () => {
    const onSubmit = vi.fn();
    const { lastFrame } = render(
      <SourceLaunchForm
        descriptor={descriptor({
          profiles: [],
          params: [{ name: "API_TOKEN", default: "", secret: true }],
        })}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await tick();
    const f = lastFrame() ?? "";
    expect(f).toContain("API_TOKEN");
    expect(f).toContain("secreto");
  });
});
