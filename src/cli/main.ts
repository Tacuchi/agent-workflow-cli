#!/usr/bin/env node
process.stdout.write(
  `${JSON.stringify({
    ok: false,
    error: { code: "NOT_IMPLEMENTED", message: "agent-workflow CLI scaffolding only" },
    exitCode: 1,
  })}\n`,
);
process.exit(1);
