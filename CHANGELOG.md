# Changelog

kemory-plus moved here from the `plus/` folder of
[kemory-plugin](https://github.com/SeKondBrainAILabs/kemory-plugin), whose
changelog holds its history up to 0.12.0. It is still installed from the
kemory marketplace: `/plugin install kemory-plus@kemory`.

## [0.13.0]

### Changed
- Memory suggestions no longer run on their own when a session goes quiet.
  Each run is a model call over the session, so it is now opt-in:
  set `KEMORY_AUTO_SUGGEST=1`, or run `/kemory-plus:learned` when you want
  suggestions.
- The plugin has its own repository and release cycle, separate from the
  `kemory` plugin.

### Added
- Module tests (`tests/module.test.ts`, run with `claude plugin test .`):
  recalled memories in the band and on the status line, a save drawn as a card
  with a toast, and the connector check that moves the plugin's duplicate tools
  behind tool search.
- `scripts/check.sh` and CI: manifests, the approval hook tests, the module
  tests, and a check that `scripts/lib.sh` still matches the kemory plugin's.
