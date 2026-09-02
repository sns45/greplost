// Leaf 1.5.3 (bench corpus): machine profile recorded alongside every bench
// result (results-io.ts payloads carry `machine`) and in RESULTS.md, so
// performance numbers can be compared across runs on the same hardware.
//
// Deliberately excludes anything that identifies the machine or its user
// (hostname, username, home directory): profiles are committed to the repo.

import { arch, cpus, release, totalmem, type as osType } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { corpusRoot } from "./corpus.ts";

export interface MachineProfile {
  cpu: string;
  cores: number;
  memoryGB: number;
  os: string;
  arch: string;
  bun: string;
  node: string;
  go: string;
  greplostVersion: string;
  greplostSha: string;
}

function runCommand(cmd: string, args: string[], cwd?: string): string | undefined {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.trim();
}

function readGreplostVersion(root: string): string {
  try {
    const pkgPath = join(root, "packages", "cli", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function machineProfile(): MachineProfile {
  const info = cpus();
  const cpu = info[0]?.model.trim() ?? "unknown";
  const cores = info.length;
  const memoryGB = Math.round((totalmem() / 1024 ** 3) * 100) / 100;
  const root = corpusRoot();

  return {
    cpu,
    cores,
    memoryGB,
    os: `${osType()} ${release()}`,
    arch: arch(),
    bun: runCommand("bun", ["--version"]) ?? "absent",
    node: process.versions.node,
    go: runCommand("go", ["version"]) ?? "absent",
    greplostVersion: readGreplostVersion(root),
    greplostSha: runCommand("git", ["rev-parse", "--short=7", "HEAD"], root) ?? "unknown",
  };
}
