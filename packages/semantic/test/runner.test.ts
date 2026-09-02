/**
 * greplost:semantic default prompt runner (leaf 1.6, semantic spec "Contract").
 *
 * The default runner is the one piece of this package that leaves the process,
 * so it is tested against a real child process rather than a mock: a shell
 * script standing in for `claude` that echoes its argument list and its stdin.
 * That proves the two things the contract actually promises — the prompt goes
 * over stdin rather than through a shell, and the flags are the ones the tech
 * spec names — and it proves them without a token of spend.
 *
 * The failure paths matter as much as the success one. A caller who is about to
 * be told "the model did not answer with JSON" is owed the real reason when the
 * real reason is that the binary is not installed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RUNNER_COMMAND, defaultRunner } from "../src/runner.ts";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** An executable shell script standing in for the model binary. */
function stubCommand(label: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `greplost-runner-${label}-`));
  temporaries.push(dir);
  const file = path.join(dir, "stub.sh");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("prompt runner", () => {
  test("the binary and flags are the ones the tech spec names", () => {
    expect(RUNNER_COMMAND).toBe("claude");
  });

  test("sends the prompt over stdin and answers with stdout verbatim", async () => {
    const command = stubCommand("echo", 'echo "args: $*"\ncat');
    const answer = await defaultRunner({ command })("summarise `these`; $(and) 'those'", { model: "test-model" });

    expect(answer).toContain("args: -p --model test-model --output-format text");
    // The prompt is data all the way down: shell metacharacters arrive intact
    // because nothing ever built a command string out of them.
    expect(answer).toContain("summarise `these`; $(and) 'those'");
  });

  test("the child runs outside the repository, so no project config can steer it", async () => {
    const command = stubCommand("cwd", "pwd -P");
    const neutral = await defaultRunner({ command })("hello", { model: "m" });
    expect(neutral.trim()).not.toBe(realpathSync(process.cwd()));
    expect(neutral.trim()).toBe(realpathSync(tmpdir()));

    // Overridable, for a repository that genuinely wants its own settings.
    const here = await defaultRunner({ command, cwd: process.cwd() })("hello", { model: "m" });
    expect(here.trim()).toBe(realpathSync(process.cwd()));
  });

  test("a missing binary says so, rather than failing as bad output", async () => {
    const run = defaultRunner({ command: "greplost-no-such-binary-9f2c" })("hello", { model: "m" });
    await expect(run).rejects.toThrow(/cannot run `greplost-no-such-binary-9f2c`: not found on PATH/);
  });

  test("a non-zero exit reports the status and the first line of stderr", async () => {
    const command = stubCommand("fail", 'echo "rate limited, try later" >&2\nexit 3');
    await expect(defaultRunner({ command })("hello", { model: "m" })).rejects.toThrow(
      /exited 3: rate limited, try later/,
    );
  });

  test("an empty answer is a failure, not an empty summary set", async () => {
    const command = stubCommand("silent", "exit 0");
    await expect(defaultRunner({ command })("hello", { model: "m" })).rejects.toThrow(/answered with nothing/);
  });

  test("a call that overruns its timeout says so, and names the limit", async () => {
    const command = stubCommand("slow", "sleep 5");
    // `spawnSync` reports a timeout as an `ETIMEDOUT` error rather than as a
    // signal, which is exactly the case a generic "cannot run" would misfile as
    // a missing install.
    await expect(defaultRunner({ command, timeoutMs: 150 })("hello", { model: "m" })).rejects.toThrow(
      /`.*stub\.sh` timed out after 150ms/,
    );
  });
});
