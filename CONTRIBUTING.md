# Contributing

Thanks for helping improve kemory-panel. By taking part you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- Open an issue before a large change so we can agree on the approach.
- A display must never cost the prompt or the tool call it watches. Every hook
  that wraps `next(e)` ends with `.catch(($, e, next) => next(e))`.
- Every call to the kemory plugin's server goes through `callKemory`, which
  reports a failure instead of throwing.
- Approve only read-only tools, by exact name, in `scripts/recall-approve.sh`.
  Never deny a call there.
- Anything that sends data anywhere must be opt-in, or listed in
  [PRIVACY.md](PRIVACY.md).

## Before opening a PR

```bash
./scripts/check.sh
```

It validates the manifests and the module (`claude plugin validate .`), runs
the module tests (`claude plugin test .`, Claude Code 2.1.267 or later) and
the approval hook tests (`python3 tests/test_recall_approve.py`), and checks
`scripts/lib.sh` against the kemory plugin's copy on `main`. CI runs the same
script.

## Releasing

Bump `version` in both `.claude-plugin/plugin.json` and
`.grok-plugin/plugin.json`, and add a `## [X.Y.Z]` section to `CHANGELOG.md`.
Merging to `main` tags and publishes the release.
