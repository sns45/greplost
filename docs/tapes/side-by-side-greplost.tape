# Capture 5, right half (tech spec 11): the same question against a repo with a
# committed `.greplost/` map, answered through `greplost impact --json`.
#
#   vhs docs/tapes/side-by-side-greplost.tape
#   bun bench/src/cli.ts screenshots --only side-by-side --paid
#
# THIS TAPE SPENDS MODEL TOKENS. The harness skips it unless `--paid` is passed.
#
# Same question, same model, same repo as side-by-side-baseline.tape; the only
# difference is the map and the tools, which is the `gl` condition of Eval 4
# (tech spec 10.6). The first command is shown on purpose: the point of the
# capture is that one deterministic call answers what the left half greps for.

Output docs/assets/side-by-side-greplost.gif
Output docs/assets/side-by-side-greplost.png

Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 760
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "cd bench/.corpus/hono && clear"
Enter
Sleep 1s
Show

Type "# greplost: the map is committed, one call answers it"
Enter
Sleep 1s

Type "bun ../../../packages/cli/src/main.ts impact src/context.ts --json | head -20"
Enter
Sleep 6s

Type "claude -p 'Which files would break if the signature of createContext changed? Answer with a JSON block {\"files\": [...]}.' --allowedTools Bash Read --output-format json"
Enter
Sleep 120s
