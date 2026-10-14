# Release planning — 2.4.0

Attendees: Priya (eng lead), Marco (design), Ana (support), Jordan (product)

## Discussion

Jordan opened by reviewing feedback from the last release. Users like the new
Viewer but want to see check results without opening it. Priya said the CLI
already stores every check result, so printing them as each run finishes is a
small change. Marco worried that long lists would bury failures and suggested
keeping passing checks short and showing a reason only when a check fails.

Ana raised three support tickets about stray spinner lines in narrow terminals.
Priya confirmed it is a wrapping bug, not a rendering choice, and that the fix
is to keep the live line within the terminal width.

The group debated whether to ship both changes together. Jordan preferred one
release so the notes tell a single story. Nobody objected.

## Decisions

- Ship check results in the CLI and the spinner fix together in 2.4.0.
- Show reasons only for checks that did not pass.

## Action items

- Priya: land the CLI check output and the spinner fix by Friday.
- Marco: review the terminal colors in light and dark themes.
- Ana: reply to the three support tickets once 2.4.0 is out.
