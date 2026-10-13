# kemory-panel

Kemory's interface in Claude Code. See what Kemory recalled and saved while you
work, and rate, save or delete a memory without leaving the session.

It is an add-on to the [kemory plugin](https://github.com/SeKondBrainAILabs/kemory-plugin),
which provides the memory itself: the MCP server, prompt recall and session
capture. kemory-panel uses that plugin's server and credential.

## What you get

| Where | What |
|-------|------|
| Status line | `✓ SeKondBrain · 3 recalled · 1 saved`: the organisation you write to and this session's counts. Otherwise what is wrong (no credential, token expired, API unreachable), `⚠ connector on <name>` when the claude.ai connector writes to a different organisation, and `↑ kemory 0.15.3` when an update is out |
| Above the prompt | The memories the last prompt put in context, each with its namespace. Before the first prompt, what Kemory already knows about the folder you opened |
| Transcript (terminal) | A card for each save and recall, which opens to the full memory. Elsewhere the Kemory server's own cards show these; see [Memory cards and this panel](#memory-cards-and-this-panel) |
| `/kemory-panel:memories` | A panel with this session's memories. Rate one Helpful or Outdated, delete it, or open it in Kemory. **Suggest memories** proposes facts from the session worth keeping, and **Save last reply** keeps Claude's last answer |
| Permission prompts | Read-only Kemory tools (recall, search, list) run without asking. Every write still asks |
| Duplicate tools | When the claude.ai Kemory connector is also connected, this plugin's copies of the same tools move behind tool search, so each request carries one set |

## Memory cards and this panel

Two different things show Kemory in Claude, and only one of them needs this
plugin.

| | Memory cards | kemory-panel |
|---|---|---|
| What you see | A card after each save or recall: the memory, its namespace, and Undo, Forget or a rating | The status line, the memories in context above the prompt, the session panel, and cards in the terminal |
| Where it comes from | The Kemory server, over MCP. It attaches a card (`ui://kemory/memory-saved`, `ui://kemory/recall-results`) to its save and recall tools, and the app shows it beside the result | This plugin, a module Claude Code loads and runs |
| What you need | A connection to Kemory: the claude.ai connector or the kemory plugin. No plugin is required | Claude Code 2.1.267 or later with this plugin and the kemory plugin |
| Where it shows | Apps that support MCP Apps, such as Claude desktop, claude.ai and ChatGPT | Claude Code, terminal and desktop |

So one save shows one card: the server's card where the app can show it, and
this plugin's card in the Claude Code terminal, which cannot.

## Requirements

- Claude Code 2.1.267 or later. Older builds and Grok Build ignore the
  interface and run only the read-only auto-approval.
- The kemory plugin, installed and signed in (`/kemory:login`).

## Install

In a Claude Code terminal:

```
/plugin marketplace add SeKondBrainAILabs/kemory-plugin
/plugin install kemory@kemory
/plugin install kemory-panel@kemory
/reload-plugins
```

The desktop app has no `/plugin` command. Run the installs from a terminal
instead, then start a new session in the app:

```bash
claude plugin marketplace add SeKondBrainAILabs/kemory-plugin
```

```bash
claude plugin install kemory@kemory
```

```bash
claude plugin install kemory-panel@kemory
```

## Commands

| Command | What it does |
|---------|--------------|
| `/kemory-panel:memories` | Opens the panel |
| `/kemory-panel:remember [text]` | Saves the text to Kemory, or Claude's last reply when you give none |
| `/kemory-panel:learned` | Opens the panel and suggests memories from this session |

## Settings

Set these as environment variables before Claude Code starts.

| Variable | Default | What it does |
|----------|---------|--------------|
| `KEMORY_AUTO_SUGGEST=1` | off | Also suggests memories on its own after a session has been quiet for five minutes. Each run is a model call over the session |
| `KEMORY_ALLOW_DUPLICATE=1` | off | Keeps this plugin's Kemory tools in front even while the claude.ai connector is connected |

## Why a separate plugin

The Claude plugin directory holds back plugins that ship an interface module
or a hook that approves tool calls. Keeping both here lets the kemory plugin
be listed on its own, and this one install from the kemory marketplace.

## Privacy and security

kemory-panel adds no telemetry or analytics. Apart from your Kemory instance,
its one request goes to a public file on GitHub, to check for updates.
[PRIVACY.md](PRIVACY.md) lists every request it makes, and
[SECURITY.md](SECURITY.md) covers the auto-approval and how to report a
vulnerability.

## Development

```bash
./scripts/check.sh
```

It validates the manifests and the module, runs the module tests
(`claude plugin test .`) and the approval hook tests, and checks
`scripts/lib.sh` against the kemory plugin's copy on `main`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

| Path | What it is |
|------|------------|
| `hooks/register.tsx` | The interface: status line, band, cards, panel and commands |
| `scripts/recall-approve.sh` | Approves read-only Kemory tools by exact name |
| `scripts/lib.sh` | A copy of the kemory plugin's credential resolution, for the status check |
| `tests/` | Module tests and approval hook tests |

## License

Apache-2.0. See [LICENSE](LICENSE).
