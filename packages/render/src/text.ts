/**
 * Plain-text output helpers, shared by every human-readable command.
 *
 * `greplost query` in a single repo and `greplost query` at a workspace root
 * answer the same question about the same kind of thing, so a person reading
 * one and then the other should not have to notice which they are looking at.
 * They used to: the CLI and the workspace layer each carried their own `table`,
 * `fields` and `summarise`, and the copies had drifted, one wrote `key value`
 * and the other `key: value`, one said `(+3 more)` and the other `… and 3
 * more`. One implementation, one look.
 *
 * They live in `@greplost/render` because it is the package both depend on and
 * because turning structure into something a person reads is exactly what this
 * package is for. Nothing here is part of the artifact layer: no output of
 * these functions is ever written to `.greplost/`, so none of it is under the
 * byte-stability contract.
 */

/**
 * Column-aligned rows, two spaces between columns, no trailing whitespace.
 *
 * A short table is easier to scan than a paragraph and costs an agent nothing,
 * because an agent asks for `--json`. The last cell of a row is never padded,
 * so a line never ends in spaces that a diff or a terminal would show.
 */
export function table(headers: readonly string[] | undefined, rows: readonly (readonly string[])[]): string[] {
  const all = headers === undefined ? rows : [headers, ...rows];
  if (all.length === 0) return [];

  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return all.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .replace(/\s+$/, ""),
  );
}

/**
 * An indented `key   value` block, aligned on the key.
 *
 * A pair with an empty value is dropped rather than printed blank: "this file
 * has no card" is not a fact worth a line, and the reader is looking for the
 * ones that are there.
 */
export function fields(pairs: readonly (readonly [string, string])[]): string[] {
  const present = pairs.filter(([, value]) => value !== "");
  const width = present.reduce((max, [key]) => Math.max(max, key.length), 0);
  return present.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`.replace(/\s+$/, ""));
}

/** A comma-joined list, capped at `cap`, with a count of what was left out. */
export function summarise(items: readonly string[], cap = 5): string {
  if (items.length === 0) return "none";
  if (items.length <= cap) return items.join(", ");
  return `${items.slice(0, cap).join(", ")} (+${items.length - cap} more)`;
}
