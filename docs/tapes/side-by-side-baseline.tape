# Capture 5, left half (tech spec 11): the baseline session — a stock Claude Code
# run with Grep, Glob and Read and no map — answering a blast-radius question.
#
# Section 11 asks for two tapes composed into one image; this is the first.
# `bench screenshots` runs both and composes them into docs/assets/side-by-side.png.
#
#   vhs docs/tapes/side-by-side-baseline.tape
#   bun bench/src/cli.ts screenshots --only side-by-side --paid
#
# THIS TAPE SPENDS MODEL TOKENS. The harness skips it unless `--paid` is passed,
# because a screenshot regeneration must not quietly bill the person running it.
#
# The question, the model and the tool list are the `base` condition of Eval 4
# (tech spec 10.6) verbatim, so the two halves of the image are the same
# comparison the agent benchmark scores.

Output docs/assets/side-by-side-baseline.gif

# Both halves share this geometry, so the composed image lines up.
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

Type "# baseline: no map, Grep and Glob only"
Enter
Sleep 1s

Type "claude -p 'Which files would break if the signature of createContext changed? Answer with a JSON block {\"files\": [...]}.' --allowedTools Grep Glob Read --output-format json"
Enter
Sleep 180s

# The final frame as one file. `Output <name>.png` would make vhs write a
# directory of one PNG per frame at that path instead (see docs/tapes/init.tape).
Screenshot docs/assets/side-by-side-baseline.png
