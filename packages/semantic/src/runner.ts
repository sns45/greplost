/**
 * greplost:semantic prompt runner (tech spec 6; semantic spec "Contract").
 *
 * The whole semantic layer talks to exactly one thing: a function that takes a
 * prompt and gives back text. Everything above it (batching, parsing, the
 * cache, the flows document) is pure logic over that seam, which is what makes
 * the package testable without spending a token and what lets a caller swap in
 * a different model host without touching greplost.
 *
 * The default implementation is headless Claude Code: `claude -p --model <m>
 * --output-format text`, with the prompt on stdin. Two rules govern it and
 * neither is negotiable. The prompt never reaches a shell: `spawnSync` is given
 * an argument array and the prompt as `input`, so a repository path containing
 * a quote or a backtick is data, not syntax. And a failure is reported as what
 * it is: a missing binary, a non-zero exit and an empty answer are three
 * different problems with three different fixes, and a caller who is about to
 * be told "invalid JSON" deserves the real one.
 */

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Ask a model for text. `prompt` is the whole request; the answer is returned
 * verbatim, and it is the caller's job to make sense of it.
 */
export type PromptRunner = (prompt: string, opts: { model: string }) => Promise<string>;

/** The binary the default runner drives, and the flags it drives it with. */
export const RUNNER_COMMAND = "claude";

/** Output cap for one answer: a batch of twelve paragraphs is kilobytes, not megabytes. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface DefaultRunnerOptions {
  /** Binary to run. Overridable so a test can point at something inert. */
  command?: string;
  /** Milliseconds before the call is abandoned. */
  timeoutMs?: number;
  /**
   * Working directory for the child. Defaults to the system temp directory,
   * deliberately: see `NEUTRAL_CWD`.
   */
  cwd?: string;
}

/**
 * Why the child does not run in the repository it is describing.
 *
 * A coding agent invoked inside a project inherits that project's `CLAUDE.md`,
 * its hooks, its permissions and its MCP servers — all of which exist to steer
 * an agent doing work in that repository, and none of which have any business
 * steering a one-shot request for a paragraph of prose. Inheriting the caller's
 * directory is an accident of how processes are spawned, not a decision; this
 * is the decision. It also keeps the summarising call from having file access
 * to the tree by default, and it keeps summaries reproducible: the same
 * checkout should not get different prose because of where greplost was run
 * from or what a colleague put in their project settings.
 *
 * The prompt is self-contained — path, exports and signatures are in it — so
 * the child has nothing to look up. Override `cwd` when a repository genuinely
 * wants its own agent configuration applied.
 */
const NEUTRAL_CWD = tmpdir();

/**
 * The runner used when a caller does not inject one.
 *
 * Synchronous underneath (`spawnSync`) on purpose: refresh batches are issued
 * one at a time so a repository cannot accidentally fan out into a dozen
 * concurrent model calls, and the sequential shape is what keeps the reported
 * `calls` count meaningful and the cost predictable.
 */
export function defaultRunner(opts: DefaultRunnerOptions = {}): PromptRunner {
  const command = opts.command ?? RUNNER_COMMAND;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const cwd = opts.cwd ?? NEUTRAL_CWD;

  return (prompt, { model }) => {
    const run = spawnSync(command, ["-p", "--model", model, "--output-format", "text"], {
      input: prompt,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout,
      cwd,
    });

    if (run.error !== undefined) {
      // A timeout arrives here rather than as a signal, and "cannot run" would
      // send the reader looking for a missing install instead of a slow call.
      const code = (run.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        return Promise.reject(new Error(`greplost: \`${command}\` timed out after ${timeout}ms`));
      }
      const reason = code === "ENOENT" ? "not found on PATH" : run.error.message;
      return Promise.reject(new Error(`greplost: cannot run \`${command}\`: ${reason}`));
    }
    if (run.signal !== null) {
      return Promise.reject(new Error(`greplost: \`${command}\` was killed by ${run.signal}`));
    }
    if (run.status !== 0) {
      const stderr = (run.stderr ?? "").trim();
      const detail = stderr === "" ? "" : `: ${firstLine(stderr)}`;
      return Promise.reject(new Error(`greplost: \`${command}\` exited ${String(run.status)}${detail}`));
    }

    const stdout = run.stdout ?? "";
    if (stdout.trim() === "") {
      return Promise.reject(new Error(`greplost: \`${command}\` answered with nothing`));
    }
    return Promise.resolve(stdout);
  };
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
