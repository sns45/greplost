/**
 * greplost:semantic prompts and answer parsing (leaf 1.6, semantic spec
 * "Rules").
 *
 * Two things are being defended here. The prompt carries the module's shape and
 * never its source — that is the difference between a refresh whose cost scales
 * with the repository and one whose cost scales with its largest file — and the
 * parsers never guess: a model that answers with prose, with a path nobody
 * asked about, or with the wrong number of flows is a failed call, because the
 * alternative is committing nonsense to a repository.
 */

import { describe, expect, test } from "bun:test";

import {
  ENTRY_PREFIX,
  FILE_PREFIX,
  FLOWS_TASK,
  HEAD_LINES,
  SUMMARY_TASK,
  buildFlowsPrompt,
  buildSummaryPrompt,
  parseFlowsResponse,
  parseSummaryResponse,
} from "../src/prompts.ts";
import type { SummaryRequest } from "../src/prompts.ts";

const RETRY: SummaryRequest = {
  path: "packages/core/src/retry.ts",
  exports: ["DEFAULT_ATTEMPTS", "retry"],
  symbols: ["export async function retry<T>(fn: () => Promise<T>): Promise<T>", "export const DEFAULT_ATTEMPTS = 3"],
};

const SCRIPT: SummaryRequest = {
  path: "apps/worker/src/boot.ts",
  exports: [],
  symbols: [],
  head: "import './register.ts';\nconsole.log('up');",
};

function flow(title: string, mermaid = "sequenceDiagram\n  A->>B: go"): unknown {
  return { title, steps: [{ file: "apps/worker/src/main.ts", symbol: "main", note: "starts" }], mermaid };
}

describe("prompts", () => {
  test("a summary prompt carries the module's shape and never its source", () => {
    const prompt = buildSummaryPrompt([RETRY]);

    expect(prompt.startsWith(SUMMARY_TASK)).toBe(true);
    expect(prompt).toContain(`${FILE_PREFIX}packages/core/src/retry.ts`);
    expect(prompt).toContain("Exports: DEFAULT_ATTEMPTS, retry");
    expect(prompt).toContain("export const DEFAULT_ATTEMPTS = 3");
    expect(prompt).toContain("Never restate signatures");
    expect(prompt).not.toContain("Source (first");
  });

  test("a module with nothing exported sends its head instead", () => {
    const prompt = buildSummaryPrompt([SCRIPT]);
    expect(prompt).toContain(`Source (first ${HEAD_LINES} lines):`);
    expect(prompt).toContain("console.log('up');");
    // Indented, so a source line can never masquerade as the file marker.
    expect(prompt).not.toContain(`\n${FILE_PREFIX}apps/worker/src/boot.ts\nimport`);
  });

  test("every file in a batch appears exactly once", () => {
    const prompt = buildSummaryPrompt([RETRY, SCRIPT]);
    const markers = prompt.split("\n").filter((line) => line.startsWith(FILE_PREFIX));
    expect(markers).toEqual([`${FILE_PREFIX}${RETRY.path}`, `${FILE_PREFIX}${SCRIPT.path}`]);
    expect(prompt).toContain("Modules (2):");
  });

  test("a plain JSON object is read as written, with whitespace collapsed", () => {
    const answer = JSON.stringify({ [RETRY.path]: "  Retries a\n  flaky call.  " });
    expect(parseSummaryResponse(answer, [RETRY.path])).toEqual(new Map([[RETRY.path, "Retries a flaky call."]]));
  });

  test("a fenced or prefaced answer is still read", () => {
    const body = JSON.stringify({ [RETRY.path]: "Retries." });
    expect(parseSummaryResponse("```json\n" + body + "\n```", [RETRY.path]).get(RETRY.path)).toBe("Retries.");
    expect(parseSummaryResponse(`Sure, here you go:\n${body}\n`, [RETRY.path]).get(RETRY.path)).toBe("Retries.");
  });

  test("a path nobody asked about is dropped rather than written", () => {
    const answer = JSON.stringify({ [RETRY.path]: "Retries.", "made/up.ts": "Invented." });
    const parsed = parseSummaryResponse(answer, [RETRY.path]);
    expect([...parsed.keys()]).toEqual([RETRY.path]);
  });

  test("prose, a non-object, an empty value and a miss are all refused", () => {
    expect(() => parseSummaryResponse("Sure! Here is a summary.", [RETRY.path])).toThrow(/did not answer with JSON/);
    expect(() => parseSummaryResponse("[1, 2]", [RETRY.path])).toThrow(/not a JSON object of summaries/);
    expect(() => parseSummaryResponse(JSON.stringify({ [RETRY.path]: "   " }), [RETRY.path])).toThrow(
      /no usable summary/,
    );
    expect(() => parseSummaryResponse(JSON.stringify({ "other.ts": "x" }), [RETRY.path])).toThrow(/named none of the 1/);
  });

  test("a flows prompt carries each entry point, what it reaches and the calls between", () => {
    const prompt = buildFlowsPrompt("worker", [
      {
        file: "apps/worker/src/main.ts",
        reaches: ["apps/worker/src/config.ts", "packages/core/src/registry.ts"],
        calls: ["apps/worker/src/main.ts#main -> packages/core/src/registry.ts#createRegistry (high)"],
      },
    ]);

    expect(prompt.startsWith(FLOWS_TASK)).toBe(true);
    expect(prompt).toContain(`${ENTRY_PREFIX}apps/worker/src/main.ts`);
    expect(prompt).toContain("  packages/core/src/registry.ts");
    expect(prompt).toContain("#createRegistry (high)");
    expect(prompt).toContain("between 2 and 5 flows");
  });

  test("flows come back as steps and a fence-free diagram", () => {
    const parsed = parseFlowsResponse(JSON.stringify([flow("One"), flow("Two")]));
    expect(parsed.map((f) => f.title)).toEqual(["One", "Two"]);
    expect(parsed[0]?.steps[0]).toEqual({ file: "apps/worker/src/main.ts", symbol: "main", note: "starts" });
    expect(parsed[0]?.mermaid).toBe("sequenceDiagram\n  A->>B: go");
  });

  test("a fenced or headerless diagram is repaired rather than refused", () => {
    const fenced = parseFlowsResponse(
      JSON.stringify([flow("One", "```mermaid\nsequenceDiagram\n  A->>B: go\n```"), flow("Two")]),
    );
    expect(fenced[0]?.mermaid).toBe("sequenceDiagram\n  A->>B: go");

    const headerless = parseFlowsResponse(JSON.stringify([flow("One", "  A->>B: go"), flow("Two")]));
    expect(headerless[0]?.mermaid).toBe("sequenceDiagram\nA->>B: go");
  });

  test("a step with no symbol is allowed; one with no file or note is not", () => {
    const bare = parseFlowsResponse(
      JSON.stringify([
        { title: "One", steps: [{ file: "a.ts", note: "does a thing" }], mermaid: "sequenceDiagram\n A->>B: go" },
        flow("Two"),
      ]),
    );
    expect(bare[0]?.steps[0]?.symbol).toBeUndefined();

    expect(() =>
      parseFlowsResponse(
        JSON.stringify([{ title: "One", steps: [{ file: "a.ts" }], mermaid: "sequenceDiagram" }, flow("Two")]),
      ),
    ).toThrow(/step 1 in the model's JSON has no note/);
  });

  test("fewer than two flows or more than five is refused", () => {
    expect(() => parseFlowsResponse(JSON.stringify([flow("One")]))).toThrow(/returned 1 flows; FLOWS.md carries 2 to 5/);
    const six = [1, 2, 3, 4, 5, 6].map((n) => flow(`Flow ${String(n)}`));
    expect(() => parseFlowsResponse(JSON.stringify(six))).toThrow(/returned 6 flows; FLOWS.md carries 2 to 5/);
  });

  test("a flows answer that is not an array, or is missing a field, is refused", () => {
    expect(() => parseFlowsResponse("{}")).toThrow(/not a JSON array of flows/);
    expect(() => parseFlowsResponse("no thanks")).toThrow(/did not answer with JSON/);
    expect(() => parseFlowsResponse(JSON.stringify([{ steps: [], mermaid: "x" }, flow("Two")]))).toThrow(
      /flow 1 in the model's JSON has no title/,
    );
    expect(() => parseFlowsResponse(JSON.stringify([{ title: "One", steps: [] }, flow("Two")]))).toThrow(
      /flow 1 in the model's JSON has no steps/,
    );
    expect(() =>
      parseFlowsResponse(JSON.stringify([{ title: "One", steps: [{ file: "a", note: "b" }] }, flow("Two")])),
    ).toThrow(/flow 1 in the model's JSON has no sequence diagram/);
  });
});
