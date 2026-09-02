# Gates: 1.4.2 plugin

Scope: Claude Code plugin: manifest, hooks, skill, commands, navigator agent (spec: plugin-cli, Plugin)

- [x] G1: plugin.json and hooks.json are valid JSON
  CHECK: node -e "JSON.parse(require('fs').readFileSync('greplost-plugin/.claude-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('greplost-plugin/hooks/hooks.json','utf8')); console.log('json ok')"
  EXPECT: json ok
  EVIDENCE: json ok

- [x] G2: hooks.json declares SessionStart, PreToolUse, PostToolUse and Stop
  CHECK: node -e "const h=JSON.parse(require('fs').readFileSync('greplost-plugin/hooks/hooks.json','utf8')); console.log(Object.keys(h.hooks||h).sort().join(','))"
  EXPECT: PostToolUse,PreToolUse,SessionStart,Stop
  EVIDENCE: PostToolUse,PreToolUse,SessionStart,Stop

- [x] G3: skill has frontmatter name greplost and documents the --json shapes
  CHECK: grep -c -E '^name: greplost|"radius"' greplost-plugin/skills/greplost/SKILL.md
  EXPECT: 2
  EVIDENCE: 2

- [x] G4: six slash commands exist
  CHECK: ls greplost-plugin/commands | sort | tr '\n' ' '
  EXPECT: impact.md init.md query.md refresh.md update.md verify.md
  EVIDENCE: impact.md init.md query.md refresh.md update.md verify.md

- [x] G5: navigator agent exists with frontmatter
  CHECK: grep -c '^name: greplost-navigator' greplost-plugin/agents/greplost-navigator.md
  EXPECT: 1
  EVIDENCE: 1

- [x] G6: hook transport end to end: session-start injects the pointer on an initialised repo
  CHECK: d=$(mktemp -d) && cp -R fixtures/tiny-ts/. "$d" && bun packages/cli/src/main.ts init --no-hooks --root "$d" >/dev/null && printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$d" | bun packages/cli/src/main.ts hook session-start
  EXPECT: additionalContext
  EVIDENCE: {"hookSpecificOutput":{"additionalContext":"This repo has a greplost map: read .greplost/INDEX.md before exploring; use `greplost query`/`impact --json`.","hookEventName":"SessionStart"}}

- [x] G7: plugin loads in Claude Code (claude --plugin-dir ./greplost-plugin) and SessionStart, PreToolUse and Stop hooks fire in a debug run on an initialised fixture copy; evidence = the exact commands and the deciding log lines
  EVIDENCE: `claude plugin validate --strict ./greplost-plugin` -> "Validation passed" (exit 0). Setup: `cp -R fixtures/tiny-ts/. "$D" && bun packages/cli/src/main.ts init --no-hooks --root "$D"` (fresh temp dir), wrapper `<bin>/greplost` = `#!/bin/sh\nexec bun <worktree>/packages/cli/src/main.ts "$@"`, `chmod +x`. Run: `cd "$D" && PATH="<bin>:$PATH" claude --plugin-dir <worktree>/greplost-plugin --debug --debug-file g7-debug-full.log -p "List the top-level files in this repo using Glob for *.json, then stop." --allowedTools Glob` (exit 0). Plugin discovery: `Read hooks.json for plugin greplost (enabled=true): <worktree>/greplost-plugin/hooks/hooks.json` / `Loading hooks from plugin: greplost` / `Registered 6 hooks from 6 plugins`. SessionStart fired: `Hooks: Parsed initial response: {"hookSpecificOutput":{"additionalContext":"This repo has a greplost map: read .greplost/INDEX.md before exploring; use \`greplost query\`/\`impact --json\`.","hookEventName":"SessionStart"}}` then `Hook SessionStart (sh -c 'command -v greplost >/dev/null 2>&1 && greplost hook session-start || bunx greplost hook session-start') provided additionalContext (109 chars)`. PreToolUse fired on Glob: `Hooks: Registering async hook async_hook_42214 (PreToolUse:Glob)` then `Hook PreToolUse (sh -c 'command -v greplost >/dev/null 2>&1 && greplost hook pre-tool-use || bunx greplost hook pre-tool-use') provided additionalContext (89 chars)` then `... returned permissionDecision: allow` then `Hook approved tool use for Glob, bypassing permission prompt`. Stop fired: `Hooks: Config-based async hook, backgrounding process async_hook_42377` / `Registering async hook async_hook_42377 (Stop) with timeout 600000ms` — the only Stop-matching hook among all 3 loaded plugins (confirmed no other plugin's hooks.json declares a Stop entry), completing ~80ms later with no stdout/stderr (matches the leaf-1.4.1 report's measured 0.081s latency for a silent `greplost hook stop` success) and zero `greplost:`-prefixed error lines anywhere in the log. No hook errors, no plugin load errors. NOTE (fix round 1, re-review): this G7 evidence predates fix round 1 and was captured against the pre-fix-round CLI/hooks.json (the old `command -v greplost && ... || bunx ...` command form and the old `permissionDecision: "allow"` PreToolUse output) — it stands as proof the plugin loads and all three hook events fire live in Claude Code, which fix round 1 did not change; it does not reflect the now-current `if/else` command form or the now-current permission-decision-free PreToolUse output. G1-G6 above were freshly re-run after `git merge main` (commit 984a660, which includes the CLI's `fix(cli): no permissionDecision in hooks` and the docs if/else ruling) and against the fix-round-1-edited `hooks.json`/`SKILL.md`/`commands/*.md`, so their EVIDENCE lines reflect the current, merged state; see the leaf report §"Fix round 1" for the live `greplost hook pre-tool-use` output confirming no `permissionDecision` field.

