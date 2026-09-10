/**
 * The released version of greplost, as the map records it (leaf 2.15).
 *
 * The render layer has no filesystem and no environment, so the version cannot
 * be read from `packages/cli/package.json` where it is declared; it is written
 * here once and pinned to that file by `test/provenance.test.ts`, which fails
 * the build if the two ever disagree.
 *
 * It reaches an artifact in exactly one place, `INDEX.md`'s provenance line, so
 * a release rewrites one line of one file per repository, and the first
 * `greplost update` after an upgrade brings the map back in step.
 */
export const GREPLOST_VERSION = "0.1.1";
