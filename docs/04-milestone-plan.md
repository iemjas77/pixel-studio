# 04 – Milestone Plan with Acceptance Criteria

A milestone is **done** only when every criterion is evidenced by a passing command
recorded in `docs/HANDOVER.md`. Milestones stay open otherwise.

| M | Scope | Acceptance (evidence) | Status |
|---|---|---|---|
| M0 | Specs 01–05, repo, toolchain | five docs committed; toolchain verified (node, npm, electron binary, vitest) | done |
| M1 | Document model, ops, command engine, history, tiles, `.pstudio` roundtrip | tests: tile boundaries/sparse alloc; op inverse exactness; transaction rollback; undo/redo exactness, redo invalidation, bounded history; strokes replay-deterministic; native write→read byte-equal pixels; malformed/truncated/bomb/unsupported-version rejected with typed errors; unknown data preserved; atomic write interrupted-save test | done |
| M2 | Electron workspace + foundational tools | `npm run build` OK; Electron launches under Xvfb; E2E scenario 1 & 4 automated; scenario 2 (import→layers→mask→text→export) automated; every visible control wired to a command; screenshot evidence | done (scenarios 1, 2, 4) |
| M3 | GPU composition + colour reference | WebGL2 compositor agrees with CPU reference within documented ΔE/8-bit tolerance for all blend modes incl. masks; context-loss recovery test; linear-light option; ICC design validated | planned |
| M4 | Actions, batch, first interchange | action record/replay (undoable, validated); batch with isolation/cancel/errors; flattened PSD *or* TIFF export validated by an independent tool | planned |
| M5 | Tested preview + handover | all E2E pass; performance/memory table recorded; known-defect list | planned |
| M6 | Native engine, big docs, recovery | Rust engine matches TS reference on golden suite; 16-bit; disk spill; 100 Mpx doc within stated memory budget | planned |
| M7 | Colour + typography | LittleCMS conversions vs reference values; CMYK; soft proof; HarfBuzz shaping tests (Arabic, Indic, CJK, combining marks, bidi) | planned |
| M8 | Layered PSD/PSB | research notes; bounded parser; fixtures + independent validators; feature-level matrix with loss reporting | planned |
| M9 | Advanced editing | per tool tests + history integration | planned |
| M10 | Packaging/a11y/acceptance | Windows build verified on Windows; accessibility audit; designer sign-off | planned |

Order is by dependency: model → commands → UI → composition/colour → automation →
native/scale → formats → advanced tools → packaging.

## Test strategy (cumulative)
Unit/integration under vitest on plain Node (`npm test`); E2E with playwright-core
`_electron` under `xvfb-run` (`npm run test:e2e`); performance micro-benchmarks recorded
in HANDOVER with machine description; no performance claim without a measurement.
