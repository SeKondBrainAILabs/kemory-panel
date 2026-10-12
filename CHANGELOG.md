# Changelog

kemory-plus moved here from the `plus/` folder of
[kemory-plugin](https://github.com/SeKondBrainAILabs/kemory-plugin), whose
changelog holds its history up to 0.12.0. It is still installed from the
kemory marketplace: `/plugin install kemory-plus@kemory`.

## [0.14.1]

### Fixed
- A card's header no longer wraps. The label, the namespace tag and the title
  shared one line, so a long namespace squeezed the label into a column and
  cut the title off. The title now has a line of its own, and the repo brief's
  label is `REPO` instead of `ABOUT THIS REPO`.

### Changed
- The repo brief shows a memory only at 0.65 similarity or above, up from
  0.55. A weak match, such as a note that someone once connected to Kemory,
  no longer appears as something Kemory knows about the repo.

## [0.14.0]

### Fixed
- Saving a suggested memory could stay on "Saving…" for good. A call to the
  kemory plugin's server that failed, or was made before that server had
  connected, threw, and nothing caught it. Every call now goes through one
  path: it tries again once if the server is still connecting, and otherwise
  shows the reason ("Could not save: …") with a Retry button. Rating, deleting
  and `/kemory-plus:remember` report their failures the same way.

### Changed
- The panel, the band above the prompt and the transcript cards follow the
  SeKondBrain brand book (brand.s9n.ai): the SeKondBrain mark in the panel,
  the brand palette, hairline borders, and namespaces as pill tags with a
  coloured dot.
- "What did we learn?" is now "Suggest memories", with a line saying what it
  does: it reads the session and proposes facts worth keeping, and nothing is
  saved until you press Save.

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
