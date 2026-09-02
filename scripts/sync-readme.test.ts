import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSection, main, missingImages, stripFences, syncReadme } from "./sync-readme";

const RESULTS = [
  "# Results", "", "## Machine", "", "| cpu | x |", "|---|---|", "",
  "## Head-to-head", "", "![chart](../docs/assets/x2-staleness.png)", "",
  "| ID | Target | Measured |", "|---|---|---|", "| X1 | ≥ 0.95 | 1.000 |", "",
  "See [raw](results/headtohead-1.json) and [spec](../docs/greplost-tech-spec.md).", "",
  "## Single-tool", "", "| S1 | 0.99 |", "",
  "## Versions", "", "| greplost | 0.0.1 |", "",
].join("\n");

const README = [
  "# greplost", "", "![hero](docs/assets/x2-staleness.png)", "", "## Head-to-head", "",
  "<!-- headtohead:start (generated) -->", "Not yet generated.", "<!-- headtohead:end -->", "",
  "### Single-tool numbers", "", "<!-- singletool:start -->", "old", "<!-- singletool:end -->", "",
].join("\n");

describe("sync-readme", () => {
  test("extracts a section body without its heading, images dropped, links rebased", () => {
    const body = extractSection(RESULTS, "Head-to-head")!;
    expect(body.startsWith("| ID | Target | Measured |")).toBe(true);
    expect(body).not.toContain("![");
    expect(body).toContain("](bench/results/headtohead-1.json)");
    expect(body).toContain("](docs/greplost-tech-spec.md)");
    expect(body).not.toContain("## ");
    expect(extractSection(RESULTS, "Nope")).toBeUndefined();
  });

  test("splices every mapped section between its markers and is idempotent", () => {
    const once = syncReadme(README, RESULTS);
    expect(once.missing).toEqual([]);
    expect(once.text).toContain("<!-- headtohead:start (generated) -->\n| ID | Target | Measured |");
    expect(once.text).toContain("| X1 | ≥ 0.95 | 1.000 |");
    expect(once.text).toContain("<!-- singletool:start -->\n| S1 | 0.99 |\n<!-- singletool:end -->");
    expect(once.text).not.toContain("Not yet generated");
    expect(once.text.match(/^## Head-to-head$/gm)!.length).toBe(1);
    expect(once.text.match(/docs\/assets\/x2-staleness\.png/g)!.length).toBe(1);
    expect(syncReadme(once.text, RESULTS).text).toBe(once.text);
  });

  test("a missing section leaves the README block untouched and is reported", () => {
    const out = syncReadme(README, RESULTS.replace("## Single-tool", "## Other"));
    expect(out.missing).toEqual(["Single-tool"]);
    expect(out.text).toContain("<!-- singletool:start -->\nold\n<!-- singletool:end -->");
  });

  test("main writes, then reports up to date, and --check fails on drift", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-readme-"));
    mkdirSync(join(root, "bench"));
    writeFileSync(join(root, "README.md"), README);
    writeFileSync(join(root, "bench", "RESULTS.md"), RESULTS);
    mkdirSync(join(root, "docs", "assets"), { recursive: true });
    writeFileSync(join(root, "docs", "assets", "x2-staleness.png"), "png");
    expect(main(["--root", root, "--check"])).toBe(1);
    expect(main(["--root", root])).toBe(0);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("| X1 | ≥ 0.95 | 1.000 |");
    expect(main(["--root", root, "--check"])).toBe(0);
    expect(main(["--root", root, "--bogus"])).toBe(2);
  });
});

describe("readme rendering guards", () => {
  test("mermaid fences are dropped from copied sections, other fences survive", () => {
    const lines = ["| a |", "```mermaid", "xychart-beta", "```", "text", "```bash", "echo hi", "```"];
    expect(stripFences(lines, "mermaid")).toEqual(["| a |", "text", "```bash", "echo hi", "```"]);
    const results = RESULTS.replace("## Head-to-head\n", "## Head-to-head\n\n```mermaid\nxychart-beta\n```\n");
    expect(extractSection(results, "Head-to-head")).not.toContain("mermaid");
  });

  test("every referenced image must exist and be tracked", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-readme-img-"));
    mkdirSync(join(root, "docs", "assets"), { recursive: true });
    writeFileSync(join(root, "docs", "assets", "a.png"), "x");
    const readme = "![a](docs/assets/a.png)\n![b](docs/assets/b.png)\n![c](https://example.com/c.png)\n";
    expect(missingImages(readme, root, () => true)).toEqual(["docs/assets/b.png (missing on disk)"]);
    expect(missingImages(readme, root, () => false)).toEqual(["docs/assets/a.png (not tracked by git)", "docs/assets/b.png (missing on disk)"]);
  });
});
