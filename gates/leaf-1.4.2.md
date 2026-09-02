# Gates: 1.4.2 plugin

Scope: Claude Code plugin: manifest, hooks, skill, commands, navigator agent (spec: plugin-cli, Plugin)

- [ ] G1: plugin.json and hooks.json are valid JSON
  CHECK: node -e "JSON.parse(require('fs').readFileSync('greplost-plugin/.claude-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('greplost-plugin/hooks/hooks.json','utf8')); console.log('json ok')"
  EXPECT: json ok
  EVIDENCE: pending

- [ ] G2: hooks.json declares SessionStart, PreToolUse, PostToolUse and Stop
  CHECK: node -e "const h=JSON.parse(require('fs').readFileSync('greplost-plugin/hooks/hooks.json','utf8')); console.log(Object.keys(h.hooks||h).sort().join(','))"
  EXPECT: PostToolUse,PreToolUse,SessionStart,Stop
  EVIDENCE: pending

- [ ] G3: skill has frontmatter name greplost and documents the --json shapes
  CHECK: grep -c -E '^name: greplost|"radius"' greplost-plugin/skills/greplost/SKILL.md
  EXPECT: 2
  EVIDENCE: pending

- [ ] G4: six slash commands exist
  CHECK: ls greplost-plugin/commands | sort | tr '\n' ' '
  EXPECT: impact.md init.md query.md refresh.md update.md verify.md
  EVIDENCE: pending

- [ ] G5: navigator agent exists with frontmatter
  CHECK: grep -c '^name: greplost-navigator' greplost-plugin/agents/greplost-navigator.md
  EXPECT: 1
  EVIDENCE: pending

- [ ] G6: hook transport end to end: session-start injects the pointer on an initialised repo
  CHECK: d=$(mktemp -d) && cp -R fixtures/tiny-ts/. "$d" && bun packages/cli/src/main.ts init --no-hooks --root "$d" >/dev/null && printf '{"hook_event_name":"SessionStart","cwd":"%s"}' "$d" | bun packages/cli/src/main.ts hook session-start
  EXPECT: additionalContext
  EVIDENCE: pending

- [ ] G7: plugin loads in Claude Code (claude --plugin-dir ./greplost-plugin) and SessionStart, PreToolUse and Stop hooks fire in a debug run on an initialised fixture copy; evidence = the exact commands and the deciding log lines
  EVIDENCE: pending

