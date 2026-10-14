# Privacy

kemory-panel adds no telemetry and no analytics. Apart from your Kemory
instance, its only request is a version check against a public file on
GitHub, which sends nothing of yours. It reads and writes your memories only through the
[kemory plugin](https://github.com/SeKondBrainAILabs/kemory-plugin), whose
[privacy policy](https://github.com/SeKondBrainAILabs/kemory-plugin/blob/main/PRIVACY.md)
covers what that plugin sends.

## What this plugin sends

| When | What | Where |
|------|------|-------|
| Session start, then every 10 minutes | A request with your credential, to check that Kemory answers | Your Kemory instance (`/api/v1/namespaces`) |
| Session start, then every 10 minutes | A `kemory_whoami` call, to show which organisation you write to | Your Kemory instance, through the kemory plugin |
| Session start, then every 10 minutes | A request for the latest version numbers of the kemory plugin and this one, to tell you about updates | `raw.githubusercontent.com` (a public file; nothing of yours is sent) |
| Session start | A search for what Kemory knows about the folder you opened, using its name | Your Kemory instance, through the kemory plugin |
| Session start and the first three prompts, while the claude.ai Kemory connector is connected | A `kemory_whoami` call through that connector, to check it is live before hiding this plugin's duplicate tools | Your Kemory instance, through the connector |
| You press Update or Install | Runs the `claude` command on your machine to refresh the kemory marketplace and update the plugin, which downloads it from GitHub | GitHub, through Claude Code's own plugin update |
| You press Save, Helpful, Outdated or Delete, or run `/kemory-panel:remember` | That memory, rating or deletion | Your Kemory instance, through the kemory plugin |
| You press Suggest memories, or run `/kemory-panel:learned` | Nothing new: Claude reads the session it is already in and proposes facts. Nothing is saved until you press Save | Your own Claude Code session |

With `KEMORY_AUTO_SUGGEST=1`, suggestions also run on their own after a
session has been quiet for five minutes. That is off by default.

## Local files

It reads `~/.claude/plugins/installed_plugins.json` to find which version is
installed. It writes no files.
