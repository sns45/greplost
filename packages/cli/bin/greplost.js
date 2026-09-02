#!/usr/bin/env node
// Published entry point. In the repo, `bun packages/cli/src/main.ts` runs the source directly.
import("../dist/main.js").then((m) => (m.main ? m.main(process.argv.slice(2)) : undefined)).then(
  (code) => { if (typeof code === "number") process.exitCode = code; },
  (err) => { console.error(err?.stack ?? String(err)); process.exitCode = 1; },
);
