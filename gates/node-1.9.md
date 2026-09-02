# Gates: 1.9 results (driver integration)

Scope: measured numbers, head-to-head results, README, dogfood, CI parity

- [x] R1: corpus tiers S and M are set up
  CHECK: bun bench/src/cli.ts corpus setup --tier S && bun bench/src/cli.ts corpus setup --tier M
  EXPECT: /hono: ready at [0-9a-f]{40}/
  EVIDENCE: hono: ready at e2740d5a1bd0b4254e517e3af8b60789284bc7bd | bubbletea: ready at 73b6d91ac1c3854dd4af046ab5f9e51d3b3b4290

- [ ] R2: structural gate on tier M (hono)
  CHECK: bun run bench:structural --repo hono --gate
  EXPECT: structural: GATE PASS
  EVIDENCE: pending

- [x] R3: map quality gate on hono's generated map
  CHECK: d=$(mktemp -d) && cp -R bench/.corpus/hono/. "$d" && bun packages/cli/src/main.ts init --no-hooks --root "$d" >/dev/null && bun run bench:mapquality --dir "$d/.greplost" --gate
  EXPECT: mapquality: GATE PASS
  EVIDENCE: mapquality: GATE PASS | $ bun bench/src/cli.ts mapquality --dir "/var/folders/dz/22spknj561x295jgnbx3x7s80000gn/T/tmp.lOLwOvZt3i/.greplost" --gate

- [ ] R4: head-to-head X1, X4, X5, X6 measured on tier S with results written
  CHECK: bun run bench:headtohead --tier S --metrics X1,X4,X5,X6
  EXPECT: /headtohead: wrote bench\/results\/headtohead-/
  EVIDENCE: pending

- [ ] R5: X2 and X3 measured on a 100-commit hono replay per tool
  CHECK: bun run bench:headtohead --repo hono --metrics X2,X3 --commits 100
  EXPECT: /headtohead: wrote bench\/results\/headtohead-/
  EVIDENCE: pending

- [ ] R6: RESULTS.md regenerated with measured values on the S1, S3, F1, F2, P1, P2, M1, X4, X5 rows
  CHECK: bun run bench:report >/dev/null && bun -e "const t=require('fs').readFileSync('bench/RESULTS.md','utf8'); const miss=['S1','S3','F1','F2','P1','P2','M1','X4','X5'].filter(id=>{const m=t.match(new RegExp('^\\\\| '+id+' \\\\|([^|]*)\\\\|([^|]*)\\\\|','m')); return !m||!m[2].trim()||/not run/.test(m[2])}); console.log(miss.length?'missing: '+miss.join(','):'measured ok')"
  EXPECT: measured ok
  EVIDENCE: pending

- [ ] R7: hero chart exists and the README links it and the head-to-head table
  CHECK: test -s docs/assets/x2-staleness.png && grep -c -E 'docs/assets/x2-staleness.png|## Head-to-head' README.md
  EXPECT: 2
  EVIDENCE: pending

- [ ] R8: greplost's own map is committed and verifies
  CHECK: bun packages/cli/src/main.ts verify --diff >/dev/null && git ls-files .greplost/INDEX.md
  EXPECT: .greplost/INDEX.md
  EVIDENCE: pending

- [x] R9: whole repo typechecks
  CHECK: bun run typecheck
  EVIDENCE: == bench | $ for p in packages/core packages/render packages/sync packages/cli packages/semantic packages/workspace bench; do echo "== $p"; bunx tsc -p $p/tsconfig.json --noEmit || exit 1; done

- [x] R10: whole test suite green
  CHECK: bun test
  EXPECT: / [1-9]\d* pass\n 0 fail/
  EVIDENCE: 12397 expect() calls | Ran 992 tests across 28 files. [25.97s]

- [ ] R11: CI workflow steps run locally in order
  CHECK: bun install --frozen-lockfile >/dev/null && bun run typecheck >/dev/null && bun test >/dev/null 2>&1 && bun packages/cli/src/main.ts verify --diff >/dev/null && bun run bench:structural --tier S --gate | tail -1 && bun run bench:mapquality --gate | tail -1
  EXPECT: mapquality: GATE PASS
  EVIDENCE: pending

- [ ] R12: every loss in the head-to-head table carries a one-line reason (quote the rows)
  EVIDENCE: pending

- [ ] R13: user notified through TicketTok with the results summary and asked whether to create github.com/sns45/greplost and publish 0.0.1 (quote the notification and the answer, or note that no answer arrived)
  EVIDENCE: pending

