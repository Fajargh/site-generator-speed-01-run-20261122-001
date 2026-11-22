# site-generator-speed-01-run-20261122-001

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Fajargh/site-generator-speed-01-run-20261122-001/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Fajargh/site-generator-speed-01-run-20261122-001/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` returns exactly what
makefun-site's `build` returns for every generated site — every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file, byte for byte — but with hand-rolled scanners instead of regex passes,
a single-pass Markdown renderer, memoized slugs, and templates compiled to
plain JavaScript functions once per case (templates that read only `site`,
`tags` and `recent` are rendered once per case and reused for every page).

## How it works

- **Front matter**: scanned with `indexOf`, no line splitting or per-line
  regexes; every refusal reason and error string matches the reference.
- **Markdown**: one pass over the lines, dispatched on the first character,
  with a regex scanner that jumps straight to the next inline construct
  (code span, strong, emphasis, link, escape, HTML special) instead of
  walking every character. The `****` edge case (a `**` with no closer is
  consumed as two literal stars) is handled exactly as the reference does.
- **Slugs**: pure-ASCII text skips Unicode normalisation entirely; results
  are memoized per case (titles and tags repeat a lot).
- **Templates**: each template is parsed once per case and compiled to a
  JavaScript function (via `new Function`, dependency-free); scopes are
  prototype-chained objects, `for` loops reuse one child scope, and one
  output array is reused per case.
- **Words**: `reading_minutes` counts words with a 64 KiB whitespace table
  instead of a regex.

## Verification

`grade-local` on the practice instance passes 3 of 3 cases, and the entry
was also checked against the house baseline on 12 freshly drawn cases from
the kit's own generator (4 new seeds), all identical. Steady-state CPU on
the practice set is about half the house baseline's.

## Layout

- `solve.js` — the entry: `run(input)` returns the output tree.
- `main.ts` — the driver (the house baseline's own): reads
  `/input/cases.json`, answers each case with `run`, writes
  `/output/answers.json`.
