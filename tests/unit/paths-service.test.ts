import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("PathsService", () => {
  const wfPaths = new PathsService(normalizeNamespace("workflow"), "/home/u", "/cwd");

  it("resolves user-level dirs for namespace 'workflow'", () => {
    expect(wfPaths.userRoot()).toBe("/home/u/.workflow");
    expect(wfPaths.userDevDir()).toBe("/home/u/.workflow/dev");
    expect(wfPaths.userDsnFile()).toBe("/home/u/.workflow/dev/dsn.env");
    expect(wfPaths.userLogsDir()).toBe("/home/u/.workflow/logs");
    expect(wfPaths.userLibConfigDir()).toBe("/home/u/.workflow/lib/config");
    expect(wfPaths.userRuntimeJson()).toBe("/home/u/.workflow/agent-workflow/runtime.json");
    expect(wfPaths.userConfigMd()).toBe("/home/u/.workflow/user-config.md");
  });

  it("userDailyLogFile: global user-level daily log, literal 'agent-workflow' prefix + YYYY-MM-DD", () => {
    // Local calendar date (not UTC) so it matches the user's "today".
    const d = new Date(2026, 6, 1, 15, 30, 0); // 2026-07-01 local
    expect(wfPaths.userDailyLogFile(d)).toBe(
      "/home/u/.workflow/logs/agent-workflow-2026-07-01.log",
    );
    const d2 = new Date(2026, 0, 9, 0, 5, 0); // zero-padded month/day
    expect(wfPaths.userDailyLogFile(d2)).toBe(
      "/home/u/.workflow/logs/agent-workflow-2026-01-09.log",
    );
  });

  it("resolves cwd-level dirs for namespace 'workflow'", () => {
    expect(wfPaths.cwdRoot()).toBe("/cwd/.workflow");
    expect(wfPaths.cwdSessionsDir()).toBe("/cwd/.workflow/sessions");
    expect(wfPaths.cwdHistoryFile()).toBe("/cwd/.workflow/HISTORY.md");
    expect(wfPaths.cwdLogsDir()).toBe("/cwd/.workflow/logs");
    expect(wfPaths.cwdLogFile()).toBe("/cwd/.workflow/logs/agent-workflow.log");
  });

  it("uses different namespace correctly", () => {
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
    expect(ps.userRoot()).toBe("/home/u/.agent-workflow");
    expect(ps.cwdSessionsDir()).toBe("/cwd/.agent-workflow/sessions");
  });

  it("blockMarkers returns parametric markers", () => {
    expect(wfPaths.blockMarkers()).toEqual({
      start: "<!-- WORKFLOW-PROJECT-START -->",
      end: "<!-- WORKFLOW-PROJECT-END -->",
    });
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/h", "/c");
    expect(ps.blockMarkers()).toEqual({
      start: "<!-- AGENT-WORKFLOW-PROJECT-START -->",
      end: "<!-- AGENT-WORKFLOW-PROJECT-END -->",
    });
  });

  it("namespace getter returns the underlying value", () => {
    expect(wfPaths.namespace).toBe("workflow");
  });

  it("resolves user plugin version file per flow", () => {
    expect(wfPaths.userPluginVersionFile("dev")).toBe("/home/u/.workflow/dev/.plugin-version");
    expect(wfPaths.userPluginVersionFile("design")).toBe(
      "/home/u/.workflow/design/.plugin-version",
    );
  });

  it("resolves user core-lib version marker", () => {
    expect(wfPaths.userCoreLibMarker()).toBe("/home/u/.workflow/lib/.workflow-core-version");
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
    expect(ps.userCoreLibMarker()).toBe("/home/u/.agent-workflow/lib/.agent-workflow-core-version");
  });
});
