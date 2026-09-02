/**
 * greplost:render ASCII tree (render spec "ascii.ts").
 *
 * Pure. Builds a box-drawing tree from a flat list of posix-style paths,
 * with no filesystem access: a path is a directory exactly when some other
 * path in the input extends it with a further `/segment`.
 */

import { compareStrings } from "@greplost/core/schema";

export interface RenderTreeOptions {
  /**
   * Called with the full path (from the tree root) of every node, directory
   * or file. A falsy/empty return value adds no annotation; otherwise the
   * text is appended to the node's line after two spaces.
   */
  annotate?: (path: string) => string;
}

interface TreeNode {
  children: Map<string, TreeNode>;
}

/**
 * Renders `paths` as a box-drawing tree (`├── `, `└── `, `│   `, `    `).
 * At each level, directories sort before files, and both groups sort in
 * code-unit order. Returns "" for an empty input, with no trailing newline.
 */
export function renderTree(paths: string[], opts?: RenderTreeOptions): string {
  const root: TreeNode = { children: new Map() };
  for (const path of paths) {
    if (path === "") continue;
    let node = root;
    for (const segment of path.split("/")) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
  }

  const lines: string[] = [];
  renderChildren(root, "", "", lines, opts?.annotate);
  return lines.join("\n");
}

function sortedEntries(node: TreeNode): Array<[string, TreeNode]> {
  const entries = [...node.children.entries()];
  const dirs = entries.filter(([, child]) => child.children.size > 0);
  const files = entries.filter(([, child]) => child.children.size === 0);
  const byName = (a: [string, TreeNode], b: [string, TreeNode]): number => compareStrings(a[0], b[0]);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

function renderChildren(
  node: TreeNode,
  prefix: string,
  pathPrefix: string,
  lines: string[],
  annotate: ((path: string) => string) | undefined,
): void {
  const entries = sortedEntries(node);
  entries.forEach(([name, child], index) => {
    const isLast = index === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const fullPath = pathPrefix === "" ? name : `${pathPrefix}/${name}`;

    let line = `${prefix}${connector}${name}`;
    const annotation = annotate?.(fullPath);
    if (annotation) line += `  ${annotation}`;
    lines.push(line);

    if (child.children.size > 0) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      renderChildren(child, childPrefix, fullPath, lines, annotate);
    }
  });
}
