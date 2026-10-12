# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@sekondbrain.ai** rather
than opening a public issue. We aim to acknowledge within 3 business days.

## Scope notes for this plugin

**Read-only tools are approved without a prompt.** `scripts/recall-approve.sh`
runs before every Kemory tool call. It approves a call only when the tool is
on a fixed list of read-only tools (`recall_memory`, `get_context`, `ask`,
`list_namespaces` and others in the script's `READ_ONLY` set). It never
denies a call, and every write (`store_memory`, `delete_memory`,
`rate_memory`, the `memory` alias and the rest) still asks, every time. The
list is exact names, not a pattern, so a new tool asks until it is added.

**Credentials.** The status check sources `scripts/lib.sh`, a copy of the
kemory plugin's credential resolution, and sends the credential only to the
Kemory instance it names (`KEMORY_URL`, hosted Kemory by default). The panel's
own actions go through the kemory plugin's MCP server and its credential.
This plugin stores no credential of its own.

**What leaves your machine** is listed in [PRIVACY.md](PRIVACY.md).
