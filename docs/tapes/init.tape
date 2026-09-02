# Capture 1 (tech spec 11): `greplost init` on the hono corpus checkout, with timing.
#
# Run from the repository root:
#
#   vhs docs/tapes/init.tape
#
# or through the harness, which checks that hono is checked out first:
#
#   bun bench/src/cli.ts screenshots --only init
#
# Two outputs: the GIF the README embeds, and the final frame as a PNG for
# places a GIF cannot go. Both land in docs/assets/, which is where every
# section 11 capture goes.

Output docs/assets/init.gif
Output docs/assets/init.png

# Fixed geometry and font size so a re-record diffs cleanly against the last one.
Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "cd bench/.corpus/hono && clear"
Enter
Sleep 1s
Show

Type "time bun ../../../packages/cli/src/main.ts init --no-hooks"
Enter
# hono is tier M; a full build plus the artifact write is seconds, not minutes,
# and the point of the capture is that number being visible on screen.
Sleep 45s

Type "ls .greplost"
Enter
Sleep 2s

Type "wc -l .greplost/INDEX.md"
Enter
Sleep 4s
