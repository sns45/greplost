// Driver-owned suite dispatcher. Each suite module exports `run(args: string[]): Promise<number>`
// (process exit code). Suites are imported lazily so a missing suite never breaks the others.
const SUITES = [
  "structural", "mapquality", "replay", "perf", "agent", "headtohead", "report", "corpus", "adapters", "screenshots",
] as const;
type SuiteName = (typeof SUITES)[number];
interface SuiteModule { run: (args: string[]) => Promise<number>; }

function loadSuite(name: SuiteName): Promise<SuiteModule> {
  // Specifier is built at runtime on purpose: suites land in separate waves and the
  // dispatcher must typecheck before all of them exist.
  const file = name === "adapters" ? "./adapters/index.ts" : `./${name}.ts`;
  return import(file) as Promise<SuiteModule>;
}
const suites: Record<string, () => Promise<SuiteModule>> = Object.fromEntries(SUITES.map((n) => [n, () => loadSuite(n)]));

const ALL_ORDER = ["structural", "mapquality", "replay", "perf", "headtohead", "report"] as const;

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") {
    console.log(`usage: bun bench/src/cli.ts <${Object.keys(suites).join("|")}|all> [--gate] [--tier S|M|L|XL] [--dry-run] [...]`);
    return name ? 0 : 2;
  }
  if (name === "all") {
    let worst = 0;
    for (const suite of ALL_ORDER) {
      const code = await (await suites[suite]!()).run(rest);
      worst = Math.max(worst, code);
    }
    return worst;
  }
  const loader = suites[name];
  if (!loader) {
    console.error(`unknown suite: ${name}`);
    return 2;
  }
  let mod: SuiteModule;
  try {
    mod = await loader();
  } catch (err) {
    console.error(`suite "${name}" is not implemented yet: ${(err as Error).message}`);
    return 1;
  }
  return mod.run(rest);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
