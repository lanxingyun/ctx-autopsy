# Changelog

## 0.3.1 — 2026-11-20

- Package the changelog that README links to: `CHANGELOG.md` is now in `files`; the npm tarball
  contains it instead of a dead link.

## 0.3.0 — 2026-11-20

- CLI options are command-scoped: `--latest` is valid only for `session`, `--prescribe` only for `request`.
  Out-of-scope combinations exit 2 with usage instead of being silently ignored.
- CLI contract matrix grows to 10 cases (help / fits / overflow / invalid window / unknown flag /
  extra positional / latest+file / latest-on-request / latest-without-file / prescribe-on-session).
- Published tarball includes `test/`, so `npm test` works from an installed package (29 unit + 10 CLI).

## 0.2.9 — 2026-11-20

- Add `test/cli.js`: 7-case CLI contract matrix.
- Include `test/` in the published `files`; `npm test` now works after `npm install` (29 + 7).

## 0.2.8 — 2026-11-20

- Extra positional arguments are reported as `unexpected argument(s)` instead of being dropped.
- `file --latest` is reported as a conflict instead of silently ignoring `--latest`.

## 0.2.7 — 2026-11-20

- Invalid or unknown options (`--window abc`, missing value, `--window 0`, `--bogus`) now exit 2
  with usage instead of silently falling back to the default window.

## 0.2.6 — 2026-11-20

- Fix a 0.2.5 regression: `session --latest` stopped looking for the newest log because `parseArgs`
  returned `null` for a missing target while `cmdSession` still checked `undefined`.

## 0.2.5 — 2026-11-20

- Parse options by position, not by `args[1]`: `request --prescribe file` and
  `session --window 100 --latest` no longer treat an option as the file path.
- `--prescribe` is listed in usage.

## 0.2.4 — 2026-11-20

- `prescribe` now flags **every** oversized message, not just the largest one; folding skips all of
  them and the `unsplittable` list is complete.

## 0.2.3 — 2026-11-19

- Documentation-only release: README install section now explains `npm link` and the
  `node src/cli.js` fallback.

## 0.2.2 — 2026-11-19

- Add the MIT `LICENSE` file and include it in the published package.
- README install section fixed for users who run examples without linking the binary.

## 0.2.1 — 2026-11-19

- Rank the largest messages by estimated **tokens**, not bytes. A 3.5 KiB CJK message can carry more
  tokens than a 4 KiB ASCII message; the previous byte sort could pick the wrong "unsplittable" item
  and claim a fold would fit.
- Add a regression test: `finds the oversized message by tokens, not bytes`.

## 0.2.0 — 2026-11-19

- Add prescription mode: `cap-field` (safe), `drop-tool` (medium), `fold-history` (medium/high),
  and an explicit `unsplittable` verdict when folding would truncate a single message.

## 0.1.1 — 2026-11-19

- Rename to `ctx-autopsy`; README starts with the three existing tools (`context-lens`, `ccusage`,
  `dabit3/ctxlens`) and when to use them instead.

## 0.1.0 — 2026-11-18

- Initial `request` / `session` modes: decompose top-level request fields and group session events
  by turn, surfacing the last `turn/end` error verbatim.
