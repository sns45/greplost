/**
 * Copies generated sections of bench/RESULTS.md into README.md between marker comments.
 *
 *   bun scripts/sync-readme.ts [--root <dir>] [--check]
 *
 * README markers: `<!-- <key>:start ... -->` and `<!-- <key>:end -->`. Each key maps to a
 * `## <Heading>` section of RESULTS.md (SECTIONS below). The section body (heading excluded,
 * up to the next `## ` heading) replaces whatever sits between the markers. Pure image lines
 * are dropped (the README carries its own hero chart) and links relative to bench/ are
 * rewritten to be relative to the repo root. `--check` exits 1 when README.md would change.
 * Nothing in the measured tables is ever typed by hand: this script is the only writer.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SECTIONS: Readonly<Record<string, string>> = {
  headtohead: "Head-to-head",
  singletool: "Single-tool",
};

export function extractSection(results: string, heading: string): string | undefined {
  const lines = results.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) { end = i; break; }
  }
  const body = lines
    .slice(start + 1, end)
    .filter((l) => !/^\s*!\[/.test(l))
    .map((l) => l.replace(/\]\((?!https?:|\/|#|\.\.\/)/g, "](bench/").replace(/\]\(\.\.\//g, "]("));
  return body.join("\n").trim();
}

export function splice(readme: string, key: string, body: string): string {
  const startRe = new RegExp(`^<!-- ${key}:start[^\\n]*-->$`, "m");
  const endRe = new RegExp(`^<!-- ${key}:end[^\\n]*-->$`, "m");
  const s = readme.match(startRe);
  const e = readme.match(endRe);
  if (!s || !e || s.index === undefined || e.index === undefined || e.index < s.index) return readme;
  const head = readme.slice(0, s.index + s[0].length);
  const tail = readme.slice(e.index);
  return `${head}\n${body}\n${tail}`;
}

export function syncReadme(readme: string, results: string): { text: string; missing: string[] } {
  const missing: string[] = [];
  let text = readme;
  for (const [key, heading] of Object.entries(SECTIONS)) {
    const body = extractSection(results, heading);
    if (body === undefined || body === "") { missing.push(heading); continue; }
    text = splice(text, key, body);
  }
  return { text, missing };
}

export function main(argv: string[]): number {
  let root = process.cwd();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) root = argv[++i]!;
    else if (argv[i] === "--check") check = true;
    else { console.error(`sync-readme: unknown argument ${argv[i]}`); return 2; }
  }
  const readmePath = join(root, "README.md");
  const resultsPath = join(root, "bench", "RESULTS.md");
  if (!existsSync(resultsPath)) { console.error("sync-readme: bench/RESULTS.md not found; run bun run bench:report first"); return 1; }
  const readme = readFileSync(readmePath, "utf8");
  const { text, missing } = syncReadme(readme, readFileSync(resultsPath, "utf8"));
  for (const m of missing) console.error(`sync-readme: RESULTS.md has no "## ${m}" section; README block left as is`);
  if (text === readme) { console.log("sync-readme: README.md up to date"); return 0; }
  if (check) { console.error("sync-readme: README.md is out of date; run bun run readme:sync"); return 1; }
  writeFileSync(readmePath, text);
  console.log("sync-readme: README.md updated");
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
