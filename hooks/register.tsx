import type { EngineInterface as Engine, McpToolResult, Register } from 'claude-code'
import { LOGOMARK_PNG } from './logomark'

// Kemory inside Claude Code, loaded by 2.1.267 and later through the "modules"
// key in hooks.json. Older Claude Code builds and Grok ignore that key and run
// the command hooks beside it unchanged.
//
// The status line says whether Kemory works: the hooks fail open, so a dead
// credential or a stale install would otherwise look like a working one. It
// sources the plugin's own lib.sh, so the credential it checks, token refresh
// included, is the one the hooks use.
//
// The rest puts memory where a person can act on it: a brief for the repo and
// the memories in context above the prompt, a card on each save and recall in
// the transcript, a panel listing them with Helpful, Outdated and Delete, saving
// a note or the last reply, and suggested memories when the session goes quiet.

// Each plugin is checked against its own repository. They version
// independently, so one's version says nothing about the other's.
const LATEST_URLS = {
  kemory: 'https://raw.githubusercontent.com/SeKondBrainAILabs/kemory-plugin/main/plugin/.claude-plugin/plugin.json',
  'kemory-panel': 'https://raw.githubusercontent.com/SeKondBrainAILabs/kemory-panel/main/.claude-plugin/plugin.json',
} as const
type PluginName = keyof typeof LATEST_URLS
const RECHECK_MS = 10 * 60 * 1000
const RECALL_TOOL = /^mcp__.*__kemory_(recall.*|ask|get_context|find_similar)$/
const STORE_TOOL = /^mcp__.*__kemory_store_(memory|skill)$/
// prompt-recall.sh lists each injected memory as one line,
// "- [<namespace>] <content>", then "  (memory_id: <uuid>)" on the next.
const INJECTED = /^- (?:\[([^\]\n]+)\] )?(.+)\n {2}\(memory_id: ([0-9a-f-]{36})\)$/gm
const BAND_ROWS = 3
const PANE = 'kemory-memories'
// The plugin's own MCP server, which the panel's actions go through.
const SERVER = 'plugin:kemory:kemory'
// How the plugin's own server names its tools to the model.
const OWN_TOOL_PREFIX = 'mcp__plugin_kemory_kemory__'
// Another server offering Kemory's tools: the claude.ai connector, named by
// its display name in a terminal and by its connector id in the desktop app.
const OTHER_KEMORY = /^mcp__(.+)__kemory_whoami$/
// The first prompts look again, since a connector can attach after start.
const CONNECTOR_PROMPT_CHECKS = 3
const NAMESPACE = 'shared'
// The repo brief shows only strong matches: a folder name alone is a weak query,
// and below this a search returns whatever happens to be nearest.
const BRIEF_MIN_SIMILARITY = 0.65
// Automatic session summaries say what a session was about, not what is true.
const BRIEF_SKIP_NAMESPACE = /^user:sessions/
const IDLE_MS = 5 * 60 * 1000
// A call made while the plugin's server is still connecting is tried again
// once after this pause.
const CONNECT_RETRY_MS = 2000
const MIN_TURNS_FOR_SUGGESTIONS = 3

const CHECK = `
. "$1/scripts/lib.sh" 2>/dev/null || { echo nolib; exit 0; }
if ! kemory_resolve_auth; then
  if [ -n "\${KEMORY_CREDS_CORRUPT:-}" ]; then echo corrupt; else echo nocreds; fi
  exit 0
fi
[ "\${KEMORY_TOKEN_EXPIRED:-0}" = 1 ] && { echo expired; exit 0; }
curl -s -o /dev/null -w '%{http_code}' --max-time 6 \\
  -H "$KEMORY_AUTH_HEADER" \${KEMORY_ORG_HEADER:+-H "$KEMORY_ORG_HEADER"} \\
  "$KEMORY_BASE_URL/api/v1/namespaces" 2>/dev/null
`

const PROBLEMS: Record<string, string> = {
  nolib: 'plugin scripts missing',
  corrupt: 'credential file is corrupt',
  nocreds: 'no credential, hooks inert',
  expired: 'token expired',
  '401': 'credential rejected (401)',
  '403': 'credential rejected (403)',
  '000': 'API unreachable',
}

type Kind = 'saved' | 'updated' | 'recalled' | 'brief'
type Entry = {
  key: string
  id?: string
  kind: Kind
  namespace: string
  title: string
  text: string
  rating?: 'up' | 'down'
  isDeleted?: boolean
  isConfirmingDelete?: boolean
}
type Suggestion = {
  key: string
  text: string
  state: 'new' | 'saving' | 'saved' | 'failed' | 'skipped'
  reason?: string
}

// Module state: a hot reload starts it over, and the next check refills it.
let problem: string | undefined
// The tool-name spelling of a Kemory connector that answered a live call in
// this session, or undefined. Only a live answer counts: a connector that is
// installed but switched off, or refuses the call, must leave the plugin's own
// tools in place, or the session ends up with no Kemory tools at all.
let connector: string | undefined
let connectorChecks = 0
// The organisation each Kemory server reads and writes. One account can belong
// to several, and the plugin (local credential, `kemory use`) and the claude.ai
// connector (its own sign-in) can each be on a different one.
let orgName: string | undefined
let orgId: string | undefined
let connectorOrg: string | undefined
let toldOrgMismatch = false
// The organisations the account belongs to, for the workspace picker, and how
// the last pick went.
let orgs: { id: string; name: string }[] = []
let orgState: 'idle' | 'switching' | 'failed' = 'idle'
let orgNote = ''
let stale: string | undefined
// The notice the update toast last carried, so it appears once per session
// per release, not on every recheck.
let toldUpdateFor: string | undefined
// What the last check found to install or update, for the Update button, and
// how pressing it went. The new version loads in the next session.
let pending: { verb: 'install' | 'update'; name: PluginName }[] = []
let pendingNotice = ''
let updateState: 'idle' | 'running' | 'done' | 'failed' = 'idle'
let updateNote = ''
const entries: Entry[] = []
const byCall = new Map<string, string[]>()
const isOpen = new Set<string>()
// What the last prompt's recall put in front of the model, for the band.
let inContext: string[] = []
let isBandHidden = false
let hasPrompted = false
let repoName = ''
let suggestions: Suggestion[] = []
let isSuggesting = false
let turnsSinceSuggestion = 0
let idleTimer: { cancel: () => void } | undefined

async function versionAt($: Engine, url: string): Promise<string | undefined> {
  try {
    const text = url.startsWith('/')
      ? await $.fs.read(url)
      : await $.http.fetch(url).then(r => (r.ok ? r.text : ''))

    return JSON.parse(text).version
  } catch {
    return undefined
  }
}

function isOlder(installed: string, latest: string): boolean {
  const a = installed.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

// Memories are written to open with the question they answer, so the first
// sentence is the best title; a long one is cut.
function titleOf(content: string): string {
  const flat = content.split(/\s+/).join(' ').trim()
  const first = flat.match(/^(.{8,100}?[?.!])(\s|$)/)?.[1] ?? flat

  return first.length > 100 ? `${first.slice(0, 99)}…` : first
}

function find(key: string): Entry | undefined {
  return entries.find(e => e.key === key)
}

function add(entry: Entry): string {
  if (!find(entry.key)) entries.push(entry)

  return entry.key
}

function count(kinds: Kind[]): number {
  return entries.filter(e => kinds.includes(e.kind)).length
}

// The surface already labels the line with the plugin's name, so the text
// leads with the state alone.
// The status line carries only what a person can act on or wants to count:
// a problem, an update, and this session's numbers. Which server answers is
// explained in the panel instead.
function draw($: Engine) {
  const recalled = count(['recalled'])
  const saved = count(['saved', 'updated'])
  const parts = [problem ? `✗ ${problem}, run /kemory:status` : orgName ? `✓ ${orgName}` : '✓']
  const mismatch = orgMismatch()
  if (!problem && mismatch) parts.push(`⚠ connector on ${mismatch}`)
  if (!problem && recalled > 0) parts.push(`${recalled} recalled`)
  if (!problem && saved > 0) parts.push(`${saved} saved`)
  if (stale) parts.push(stale)
  $.ui.status(parts.join(' · '))
}

// The connector's organisation when it differs from the plugin's, else undefined.
function orgMismatch(): string | undefined {
  return connector && orgName && connectorOrg && connectorOrg !== orgName ? connectorOrg : undefined
}

function orgOf(result: McpToolResult, field: 'org_name' | 'org_id' = 'org_name'): string | undefined {
  try {
    const value = JSON.parse(textOf(result))[field]

    return typeof value === 'string' && value ? value : undefined
  } catch {
    return undefined
  }
}

// Says once per session when the two servers write to different
// organisations: what Claude saves goes through the connector, and what this
// panel and the kemory hooks save goes through the plugin.
async function warnOrgMismatch($: Engine) {
  const other = orgMismatch()
  if (!other || toldOrgMismatch) return
  toldOrgMismatch = true
  $.ui.toast(
    `Kemory: the plugin writes to ${orgName} but the claude.ai connector writes to ${other}. ` +
      'Pick one under Workspace in /kemory-panel:memories to use it for both.',
    { timeoutMs: 15000 },
  )
}

async function loadOrgs($: Engine) {
  const run = await $.process
    .run(['bash', `${$.plugin.root}/scripts/org.sh`, 'list'], { timeoutMs: 15000 })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) return
  try {
    const list = JSON.parse(run.stdout)
    if (!Array.isArray(list)) return
    orgs = list
      .filter(o => typeof o?.org_id === 'string')
      .map(o => ({ id: o.org_id as string, name: typeof o.name === 'string' && o.name ? o.name : (o.org_id as string) }))
    redraw($)
  } catch {
    // An unreadable list leaves the picker out.
  }
}

// The workspace picker. A person's pick, never the model's: a switch the model
// could call would let a stored memory redirect where later memories go.
// org.sh moves the connector (the account's stored selection) and the plugin
// (the credential file); both servers are then asked where they now write.
async function switchOrg($: Engine, id: string) {
  if (orgState === 'switching' || id === orgId) return
  orgState = 'switching'
  redraw($)
  const run = await $.process
    .run(['bash', `${$.plugin.root}/scripts/org.sh`, 'use', id], { timeoutMs: 20000 })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) {
    orgState = 'failed'
    orgNote = `Could not switch: ${run?.stdout.trim() || 'the switch did not run'}.`
    redraw($)
    return
  }
  const me = await callKemory($, 'kemory_whoami', {})
  if (!me.isError) {
    orgName = orgOf(me) ?? orgName
    orgId = orgOf(me, 'org_id') ?? orgId
  }
  if (connector) {
    const answer = await $.mcp.call(connector, 'kemory_whoami', {}).catch(() => undefined)
    if (answer && !answer.isError) connectorOrg = orgOf(answer)
  }
  orgState = 'idle'
  toldOrgMismatch = false
  $.ui.toast(`Kemory: now writing to ${orgName}`)
  await warnOrgMismatch($)
  redraw($)
}

function redraw($: Engine) {
  draw($)
  $.ui.invalidate('ui.render')
}

function toggle($: Engine, key: string) {
  if (isOpen.has(key)) isOpen.delete(key)
  else isOpen.add(key)
  redraw($)
}

function textOf(result: { content: unknown[] }): string {
  return (result.content as { type?: string; text?: unknown }[])
    .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
}

// A recall tool's text is JSON with a top-level `memories` list. Other lists in
// it (cross_agent_context, shared_chats) are not what was asked for, so only
// that one counts.
function memoriesIn(text: string | undefined): { namespace: string; content: string; id: string; similarity: number }[] {
  try {
    const memories = JSON.parse(text ?? '').memories
    if (!Array.isArray(memories)) return []

    return memories
      .filter(m => typeof m?.memory_id === 'string' && typeof m?.content === 'string')
      .map(m => ({
        namespace: String(m.namespace ?? ''),
        content: m.content as string,
        id: m.memory_id as string,
        similarity: typeof m.similarity_score === 'number' ? m.similarity_score : 0,
      }))
  } catch {
    return []
  }
}

// The store tools answer "ID: <id>", "Namespace: <ns>" and "Version: <n>"; a
// version past 1 means a near-duplicate was updated in place.
function stored(text: string, content: string, fallbackKey: string, fallbackNamespace: string): Entry {
  const id = text.match(/ID: (\S+)/)?.[1]
  const version = Number(text.match(/Version: (\d+)/)?.[1] ?? 1)

  return {
    key: id ?? fallbackKey,
    id,
    kind: version > 1 ? 'updated' : 'saved',
    namespace: text.match(/Namespace: (\S+)/)?.[1] ?? fallbackNamespace,
    title: titleOf(content || '(no text)'),
    text: content,
  }
}

function saveNotice(e: Entry): string {
  const what = e.kind === 'updated' ? `Updated in ${e.namespace}` : `Saved to ${e.namespace}`

  return `${what}: "${e.title}"`
}

// What the last install or update put on disk, per plugin; a plugin that is
// not installed is absent, and undefined means the list could not be read.
// The running session keeps the version it loaded until a new session starts,
// so the two can differ.
async function versionsOnDisk($: Engine): Promise<Partial<Record<PluginName, string>> | undefined> {
  try {
    const home = await $.env.get('HOME')
    const plugins = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)).plugins ?? {}
    const versions: Partial<Record<PluginName, string>> = {}
    for (const name of Object.keys(LATEST_URLS) as PluginName[]) {
      const key = Object.keys(plugins).find(k => k.startsWith(`${name}@`))
      const installs = key ? plugins[key] : undefined
      const version = Array.isArray(installs) ? installs[0]?.version : undefined
      if (typeof version === 'string') versions[name] = version
    }

    return versions
  } catch {
    return undefined
  }
}

// `/plugin` is a terminal dialog. The desktop app has no such command, so a
// session drawn only there is told to use the CLI.
async function commandHint($: Engine, actions: { verb: 'install' | 'update'; name: PluginName }[]): Promise<string> {
  const surfaces = await $.session.surfaces().catch(() => [] as string[])
  const isTerminal = surfaces.includes('terminal')
  const commands = actions.map(a => (isTerminal ? `/plugin ${a.verb} ${a.name}@kemory` : `'claude plugin ${a.verb} ${a.name}@kemory'`))

  return isTerminal
    ? `Run ${commands.join(' and ')}, then restart.`
    : `Run ${commands.join(' and ')} in a terminal, then open a new session.`
}

async function check($: Engine) {
  const root = $.plugin.root
  const [run, running, latestKemory, latestPanel, onDisk, me] = await Promise.all([
    $.process
      .run(['bash', '-c', CHECK, 'kemory-status', root], { timeoutMs: 20000 })
      .catch(() => undefined),
    versionAt($, `${root}/.claude-plugin/plugin.json`),
    versionAt($, LATEST_URLS.kemory),
    versionAt($, LATEST_URLS['kemory-panel']),
    versionsOnDisk($),
    callKemory($, 'kemory_whoami', {}),
  ])
  if (!me.isError) {
    orgName = orgOf(me) ?? orgName
    orgId = orgOf(me, 'org_id') ?? orgId
  }
  if (orgs.length === 0) void loadOrgs($)
  const code = run?.stdout.trim() || '000'
  const was = problem
  problem = code === '200' ? undefined : (PROBLEMS[code] ?? `API returned HTTP ${code}`)

  // The status line is narrow and cannot be clicked, so it carries only the
  // facts; the commands, which do not fit there, go in a toast.
  const facts: string[] = []
  const notices: string[] = []
  const actions: { verb: 'install' | 'update'; name: PluginName }[] = []
  if (running && latestPanel && isOlder(running, latestPanel)) {
    const disk = onDisk?.['kemory-panel']
    if (disk && !isOlder(disk, latestPanel)) {
      facts.push(`kemory-panel ${disk} installed, new session to apply`)
    } else {
      facts.push(`↑ kemory-panel ${latestPanel}`)
      notices.push(`kemory-panel ${latestPanel} is out (you have ${running})`)
      actions.push({ verb: 'update', name: 'kemory-panel' })
    }
  }
  // This module cannot see which kemory version the session loaded, only what
  // is on disk; after an update the kemory plugin's own hooks say a new
  // session is needed.
  const kemory = onDisk?.kemory
  if (onDisk && !kemory) {
    facts.push('kemory plugin not installed')
    notices.push('the kemory plugin, which this panel needs, is not installed')
    actions.push({ verb: 'install', name: 'kemory' })
  } else if (kemory && latestKemory && isOlder(kemory, latestKemory)) {
    facts.push(`↑ kemory ${latestKemory}`)
    notices.push(`kemory ${latestKemory} is out (you have ${kemory})`)
    actions.push({ verb: 'update', name: 'kemory' })
  }
  stale = facts.length > 0 ? facts.join(' · ') : undefined
  const notice = notices.join('; ')
  pending = actions
  pendingNotice = notice
  if (actions.length > 0 && toldUpdateFor !== notice) {
    toldUpdateFor = notice
    $.ui.toast(`Kemory: ${notice}. ${await commandHint($, actions)}`, { timeoutMs: 12000 })
  }

  if (problem && problem !== was) $.ui.toast(`Kemory: ${problem}`)
  await warnOrgMismatch($)
  draw($)
}

// Finds the claude CLI and runs it with the given arguments, or exits 127.
// The session's PATH may lack it (a desktop app, a PATH set only in .zshrc),
// so the usual install locations come next, then the person's own shell.
const RUN_CLAUDE = `
c=$(command -v claude 2>/dev/null)
for p in "$c" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  [ -n "$p" ] && [ -x "$p" ] && exec "$p" "$@"
done
c=$("\${SHELL:-/bin/zsh}" -lic 'command -v claude' 2>/dev/null | tail -1)
[ -n "$c" ] && [ -x "$c" ] && exec "$c" "$@"
exit 127
`

// The Update button. Runs what a person would run in a terminal: refresh the
// kemory marketplace, then install or update each plugin the check named.
async function runUpdate($: Engine) {
  if (updateState === 'running' || pending.length === 0) return
  updateState = 'running'
  redraw($)
  const steps = [
    ['plugin', 'marketplace', 'update', 'kemory'],
    ...pending.map(a => ['plugin', a.verb, `${a.name}@kemory`]),
  ]
  for (const args of steps) {
    const run = await $.process
      .run(['bash', '-c', RUN_CLAUDE, 'claude', ...args], { timeoutMs: 180000 })
      .catch(() => undefined)
    if (!run || run.exitCode !== 0) {
      updateState = 'failed'
      const manual = pending.map(a => `claude plugin ${a.verb} ${a.name}@kemory`).join(' && ')
      updateNote =
        run?.exitCode === 127
          ? `Could not find the claude command. Run ${manual} in a terminal.`
          : `Update failed (claude ${args.join(' ')}). Run ${manual} in a terminal.`
      redraw($)
      return
    }
  }
  updateState = 'done'
  pending = []
  stale = undefined
  redraw($)
}

// One row saying an update is out, with the button, or how pressing it went.
// biome-ignore lint/suspicious/noExplicitAny: the element table differs per surface
function updateRow($: Engine, els: Record<string, any>, at: string) {
  const { Box, Button, Text } = els
  if (updateState === 'idle' && pending.length === 0) return null
  const text = {
    idle: `${pendingNotice.charAt(0).toUpperCase()}${pendingNotice.slice(1)}.`,
    running: 'Updating…',
    done: 'Updated. Open a new session to use it.',
    failed: updateNote,
  }[updateState]

  return (
    <Box key={`update-${at}`} gap={1}>
      <Text color={updateState === 'failed' ? BRAND.danger : BRAND.yellow}>●</Text>
      <Text>{text}</Text>
      {(updateState === 'idle' || updateState === 'failed') && pending.length > 0 && (
        <Button
          key={`update-run-${at}`}
          label={pending.some(a => a.verb === 'install') ? 'Install' : 'Update'}
          variant="primary"
          onPress={() => void runUpdate($)}
        />
      )}
    </Box>
  )
}

// The workspace picker, where the surface draws a Select and the account has
// more than one organisation.
// biome-ignore lint/suspicious/noExplicitAny: the element table differs per surface
function orgRow($: Engine, els: Record<string, any>) {
  const { Box, Select, Text } = els
  if (!Select || orgs.length < 2) return null

  return (
    <Box key="org" flexDirection="column">
      <Select
        key="pane-org"
        label="Workspace"
        options={orgs.map(o => ({ value: o.id, label: o.name }))}
        value={orgId}
        onSelect={(id: string) => void switchOrg($, id)}
      />
      {orgState === 'switching' && <Text color={BRAND.grey}>Switching…</Text>}
      {orgState === 'failed' && <Text color={BRAND.danger}>{orgNote}</Text>}
      <Text color={BRAND.grey}>
        Moves this panel, the kemory hooks and every Kemory connector on your account (claude.ai included) to the
        workspace you pick.
      </Text>
    </Box>
  )
}

// One Kemory server is enough. When the claude.ai connector is live in this
// session, the plugin's own copies of the same 25 tools move behind tool
// search and point at the connector's, so requests stop carrying both.
// The plugin's server keeps running: a module cannot stop it, and the panel's
// actions still use it. KEMORY_ALLOW_DUPLICATE=1 keeps both in front.
async function findConnector($: Engine) {
  if (connector) return
  connectorChecks += 1
  if ((await $.env.get('KEMORY_ALLOW_DUPLICATE')) === '1') return
  const tools = await $.tool.list()
  const servers = tools
    .map(t => t.name.match(OTHER_KEMORY)?.[1])
    .filter((s): s is string => !!s && !`mcp__${s}__`.startsWith(OWN_TOOL_PREFIX))
  for (const server of new Set(servers)) {
    const answer = await $.mcp.call(server, 'kemory_whoami', {}).catch(() => undefined)
    if (answer && !answer.isError) {
      connector = server
      connectorOrg = orgOf(answer)
      $.ui.invalidate('tool.describe')
      await warnOrgMismatch($)
      draw($)
      return
    }
  }
}

// Every call to the plugin's server goes through here. A call made before the
// server has connected throws at once instead of waiting, so that one is tried
// again after a pause; any other failure comes back as an errored result whose
// text says why, so no action is left waiting on a call that threw.
async function callKemory($: Engine, tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await $.mcp.call(SERVER, tool, args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (attempt === 0 && /no connected MCP tool/.test(message)) {
        await $.clock.sleep(CONNECT_RETRY_MS)
        continue
      }
      const text = /no connected MCP tool/.test(message)
        ? "the kemory plugin's server is not connected. Check that the kemory plugin is installed and enabled"
        : message

      return { content: [{ type: 'text', text }], isError: true }
    }
  }
}

// Why a call failed, short enough for a toast.
function failureOf(result: McpToolResult): string {
  const text = textOf(result).split(/\s+/).join(' ').trim()

  return text.length > 140 ? `${text.slice(0, 139)}…` : text || 'no reason given'
}

// A person's verdict on a memory, sent through the plugin's server.
async function rate($: Engine, key: string, rating: 'up' | 'down') {
  const e = find(key)
  if (!e?.id) return
  const reason = rating === 'up' ? 'correct' : 'outdated'
  const result = await callKemory($, 'kemory_rate_memory', { target_id: e.id, rating, reason })
  if (result.isError) {
    $.ui.toast(`Kemory: rating failed: ${failureOf(result)}`)
    return
  }
  e.rating = rating
  $.ui.toast(rating === 'up' ? 'Kemory: marked helpful' : 'Kemory: marked outdated')
  redraw($)
}

// Delete takes two presses, the second labelled "Confirm delete".
async function remove($: Engine, key: string) {
  const e = find(key)
  if (!e?.id) return
  if (!e.isConfirmingDelete) {
    e.isConfirmingDelete = true
    redraw($)
    return
  }
  const result = await callKemory($, 'kemory_delete_memory', { memory_id: e.id })
  e.isConfirmingDelete = false
  if (result.isError) {
    $.ui.toast(`Kemory: delete failed: ${failureOf(result)}`)
  } else {
    e.isDeleted = true
    $.ui.toast(`Kemory: deleted "${e.title}"`)
  }
  redraw($)
}

// A save a person asked for: /remember, "Save last reply", or a suggestion.
// Resolves to why it failed, or undefined once saved.
async function save($: Engine, content: string): Promise<string | undefined> {
  const result = await callKemory($, 'kemory_store_memory', {
    content,
    namespace: NAMESPACE,
    content_type: 'fact',
  })
  if (result.isError) {
    const reason = failureOf(result)
    $.ui.toast(`Kemory: save failed: ${reason}`, { timeoutMs: 8000 })
    return reason
  }
  const entry = stored(textOf(result), content, `save-${entries.length}`, NAMESPACE)
  add(entry)
  $.ui.toast(saveNotice(entry), { timeoutMs: 6000 })
  redraw($)
  return undefined
}

async function lastReply($: Engine): Promise<string | undefined> {
  const messages = await $.session.messages()
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())

  return last?.text.trim().slice(0, 4000)
}

async function saveLastReply($: Engine) {
  const text = await lastReply($)
  if (text) await save($, text)
}

// The model reads the session it is in (a fork, served from the prompt cache)
// and proposes memories. Nothing is stored until a person saves one.
async function suggest($: Engine, isAsked: boolean) {
  if (isSuggesting) return
  isSuggesting = true
  redraw($)
  const r = await $.model.fork({
    prompt:
      'From this conversation, pick at most 3 durable facts worth keeping in long-term memory: decisions, preferences, ' +
      'non-obvious gotchas with their fix. Skip anything transient or already saved. Write each so it opens with the ' +
      'question someone would later ask, in plain words, then the answer with exact identifiers. ' +
      'Reply with only a JSON array of strings, [] if nothing qualifies.',
  })
  isSuggesting = false
  turnsSinceSuggestion = 0
  if (!r.isAnswered) {
    if (isAsked) $.ui.toast(`Kemory: no suggestions (${r.reason})`)
    redraw($)
    return
  }
  let list: unknown = []
  try {
    list = JSON.parse(r.text.match(/\[[\s\S]*\]/)?.[0] ?? '[]')
  } catch {
    list = []
  }
  const fresh = (Array.isArray(list) ? list : []).filter((s): s is string => typeof s === 'string' && s.trim().length > 20)
  suggestions = [
    ...suggestions,
    ...fresh.map((text, i) => ({ key: `s-${suggestions.length + i}`, text: text.trim(), state: 'new' as const })),
  ]
  if (fresh.length > 0) {
    const noun = fresh.length === 1 ? 'memory' : 'memories'
    $.ui.toast(`Kemory: ${fresh.length} suggested ${noun}, see /kemory-panel:memories`, { timeoutMs: 8000 })
  } else if (isAsked) {
    $.ui.toast('Kemory: nothing new worth saving')
  }
  redraw($)
}

async function saveSuggestion($: Engine, key: string) {
  const s = suggestions.find(x => x.key === key)
  if (!s || (s.state !== 'new' && s.state !== 'failed')) return
  s.state = 'saving'
  s.reason = undefined
  redraw($)
  const reason = await save($, s.text)
  s.state = reason ? 'failed' : 'saved'
  s.reason = reason
  redraw($)
}

function skipSuggestion($: Engine, key: string) {
  const s = suggestions.find(x => x.key === key)
  if (s) s.state = 'skipped'
  redraw($)
}

// What Kemory already knows about the repo this session runs in.
async function brief($: Engine) {
  const root = await $.session.root()
  repoName = root.split('/').filter(Boolean).pop() ?? ''
  if (!repoName) return
  const result = await callKemory($, 'kemory_recall_memory', {
    query: `${repoName} repository: how it is set up, decisions and gotchas`,
    limit: 8,
  })
  if (result.isError) return
  const strong = memoriesIn(textOf(result))
    .filter(m => m.similarity >= BRIEF_MIN_SIMILARITY && !BRIEF_SKIP_NAMESPACE.test(m.namespace))
    .slice(0, 3)
  for (const m of strong) {
    add({ key: m.id, id: m.id, kind: 'brief', namespace: m.namespace, title: titleOf(m.content), text: m.content })
  }
  redraw($)
}

// Look and feel, from the SeKondBrain brand book v6 (brand.s9n.ai): the
// accent palette, hairline borders rather than coloured ones, pill tags with a
// coloured dot, status dots, and no decorative glyphs.
const BRAND = {
  purple: '#8B78F5',
  blue: '#1A8AF6',
  pink: '#E24AF2',
  orange: '#F28B68',
  yellow: '#E6B800',
  mint: '#3DD680',
  grey: '#969696',
  danger: '#EF4444',
  // 8% white on the dark panel (#0E0E10)
  hairline: '#2A2A2E',
}
const ACCENT = BRAND.purple
// One stable colour per namespace, so the same namespace reads the same everywhere.
const CHIP_COLORS = [BRAND.purple, BRAND.blue, BRAND.pink, BRAND.mint, BRAND.yellow, BRAND.orange]
// The dashboard has no page for a single memory; its memories view filters
// by namespace, so a memory links to its namespace there.
const DASHBOARD = 'https://app.kemory.ai/memories'

function chipColor(namespace: string): string {
  let hash = 0
  for (const c of namespace) hash = (hash * 31 + c.charCodeAt(0)) >>> 0

  return CHIP_COLORS[hash % CHIP_COLORS.length] ?? ACCENT
}

function dashboardLink(namespace: string): string {
  return namespace ? `${DASHBOARD}?ns=${encodeURIComponent(namespace)}` : DASHBOARD
}

function verb(e: Entry): string {
  if (e.isDeleted) return 'Deleted from Kemory'

  return {
    saved: 'Saved to Kemory',
    updated: 'Updated in Kemory',
    recalled: 'Recalled from Kemory',
    brief: 'Kemory knows this about the repo',
  }[e.kind]
}

// The status dot beside the verb: what happened, at a glance.
function kindColor(e: Entry): string {
  if (e.isDeleted) return BRAND.grey

  return { saved: BRAND.mint, updated: BRAND.yellow, recalled: BRAND.blue, brief: BRAND.purple }[e.kind]
}

// The text after the title, flattened to one line, for the closed card.
function previewOf(e: Entry): string {
  const flat = e.text.split(/\s+/).join(' ').trim()
  const rest = flat.startsWith(e.title) ? flat.slice(e.title.length).trim() : flat

  return rest.length > 160 ? `${rest.slice(0, 159)}…` : rest
}

// The SeKondBrain mark, drawn where the surface takes SVG.
function logomark(size: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 96 96">` +
    `<image href="data:image/png;base64,${LOGOMARK_PNG}" width="96" height="96"/></svg>`
  )
}

// A namespace as a pill tag: its colour as a dot, its name in grey capitals.
// biome-ignore lint/suspicious/noExplicitAny: the element table differs per surface
function tag(Text: any, namespace: string) {
  return (
    <Text>
      <Text color={chipColor(namespace)}>●</Text>
      <Text color={BRAND.grey}> {(namespace || 'kemory').toUpperCase()}</Text>
    </Text>
  )
}

// One memory as a card. Closed: what happened and where, the title, and one
// line of the memory. Open: the whole memory as Markdown and its actions.
// Elements are the drawing surface's own, passed in by the hook.
// biome-ignore lint/suspicious/noExplicitAny: the element table differs per surface
function memoryCard($: Engine, els: Record<string, any>, m: Entry, at: string) {
  const { Box, Button, Text, Markdown, Link } = els
  const svg = 'Svg' in els ? (els.Svg as (p: Record<string, unknown>) => never) : undefined
  const isShown = isOpen.has(m.key) && !m.isDeleted
  const preview = previewOf(m)

  return (
    <Box
      key={`box-${at}-${m.key}`}
      flexDirection="column"
      borderStyle="round"
      borderColor={BRAND.hairline}
      paddingX={1}
    >
      <Box gap={1} justifyContent="space-between">
        <Box gap={1} alignItems="center" flexShrink={1}>
          {svg && svg({ key: `mark-${at}-${m.key}`, source: logomark(14), alt: ' ', width: 14, height: 14 })}
          <Text color={kindColor(m)}>●</Text>
          <Text color={m.isDeleted ? BRAND.grey : undefined}>{verb(m)}</Text>
          {tag(Text, m.namespace)}
        </Box>
        {!m.isDeleted && (
          <Box flexShrink={0}>
            <Link key={`link-${at}-${m.key}`} href={dashboardLink(m.namespace)} label="Open ↗" />
          </Box>
        )}
      </Box>
      <Text bold strikethrough={m.isDeleted} color={m.isDeleted ? BRAND.grey : undefined}>
        {m.title}
      </Text>
      {!isShown && preview && (
        <Text color={BRAND.grey} wrap="truncate-end">
          {preview}
        </Text>
      )}
      {isShown && <Markdown key={`md-${at}-${m.key}`} text={m.text.slice(0, 9000)} />}
      <Box gap={1}>
        {!m.isDeleted && (preview || isShown) && (
          <Button
            key={`open-${at}-${m.key}`}
            plain
            dimColor
            label={isShown ? 'Show less' : 'Show more'}
            onPress={() => toggle($, m.key)}
          />
        )}
        {isShown && m.id && m.kind !== 'saved' && m.kind !== 'updated' && (
          <Button
            key={`up-${at}-${m.key}`}
            label={m.rating === 'up' ? '✓ Helpful' : 'Helpful'}
            onPress={() => rate($, m.key, 'up')}
          />
        )}
        {isShown && m.id && (
          <Button
            key={`down-${at}-${m.key}`}
            label={m.rating === 'down' ? '✓ Outdated' : 'Outdated'}
            onPress={() => rate($, m.key, 'down')}
          />
        )}
        {isShown && m.id && (
          <Button
            key={`del-${at}-${m.key}`}
            label={m.isConfirmingDelete ? 'Confirm delete' : 'Delete'}
            onPress={() => remove($, m.key)}
          />
        )}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.ui.status('…')
    void check($)
    $.clock.every(RECHECK_MS, () => void check($))
    void brief($)
    void findConnector($)

    return result
  })

  // The plugin's own commands (commands/*.md), answered here where the module
  // runs; elsewhere their files run as prompts. Shipping them as files is what
  // lists them in the command picker, which runtime-registered commands miss.
  on('command.run', { command: 'kemory-panel:memories' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Kemory' })

    return { text: 'Kemory panel opened.' }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'kemory-panel:remember' }, async ($, e) => {
    const text = e.args.trim() || (await lastReply($))
    if (!text) return { text: 'Nothing to save: no text given and no reply yet.' }

    const reason = await save($, text)

    return { text: reason ? `Save failed: ${reason}` : `Saved to ${NAMESPACE}: ${titleOf(text)}` }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'kemory-panel:learned' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Kemory' })
    await suggest($, true)

    return { text: 'Suggested memories are in the Kemory panel.' }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    idleTimer?.cancel()
    if (!hasPrompted) {
      hasPrompted = true
      redraw($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Opt-in (KEMORY_AUTO_SUGGEST=1): each run is a model call over the session
  // that the person did not ask for. /kemory-panel:learned runs it on request.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    turnsSinceSuggestion += 1
    idleTimer?.cancel()
    if ((await $.env.get('KEMORY_AUTO_SUGGEST')) !== '1') return result
    if (turnsSinceSuggestion >= MIN_TURNS_FOR_SUGGESTIONS) {
      idleTimer = $.clock.after(IDLE_MS, () => void suggest($, false))
    }

    return result
  })

  // A display must never cost the prompt or the tool call it watches: if a
  // hook below throws, its catch hands back what `next` settled to (replayed,
  // never run twice).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    if (!connector && connectorChecks < CONNECTOR_PROMPT_CHECKS) await findConnector($)
    // A prompt ends the repo brief. Marked here as well as at prompt.submit,
    // which a session hosted by the desktop app was seen not to raise.
    hasPrompted = true
    inContext = []
    for (const context of result.additionalContext ?? []) {
      for (const [, namespace = '', content, id] of context.matchAll(INJECTED)) {
        if (!content || !id) continue
        inContext.push(add({ key: id, id, kind: 'recalled', namespace, title: titleOf(content), text: content }))
      }
    }
    redraw($)

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    const input = e as Record<string, unknown>
    const text = result.text ?? ''

    if (STORE_TOOL.test(e.tool)) {
      const content = [input.content, input.name, input.trigger].find(v => typeof v === 'string') as string | undefined
      const entry = stored(text, content ?? '', e.tool_use_id, String(input.namespace ?? ''))
      byCall.set(e.tool_use_id, [add(entry)])
      $.ui.toast(saveNotice(entry), { timeoutMs: 6000 })
    } else if (RECALL_TOOL.test(e.tool)) {
      const keys = memoriesIn(text).map(m =>
        add({ key: m.id, id: m.id, kind: 'recalled', namespace: m.namespace, title: titleOf(m.content), text: m.content }),
      )
      byCall.set(e.tool_use_id, keys)
    }
    redraw($)

    return result
  }).catch(($, e, next) => next(e))

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    if (!connector || !e.tool.startsWith(OWN_TOOL_PREFIX)) return described
    const twin = `mcp__${connector}__${e.tool.slice(OWN_TOOL_PREFIX.length)}`

    return {
      description: `Same tool as ${twin}, which the claude.ai Kemory connector serves in this session; use that one. ${described.description}`,
      isDeferred: true,
    }
  }).catch(($, e, next) => next(e))

  // Above the prompt: the repo brief until the first prompt, then what each
  // prompt's recall put in context, as a row of namespace chips and titles.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey || isBandHidden) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const briefs = entries.filter(m => m.kind === 'brief')
    const shown = hasPrompted ? inContext.map(find).filter((x): x is Entry => !!x) : briefs
    const update = updateRow($, els, 'band')
    if (shown.length === 0 && !update) return next(e)
    const noun = shown.length === 1 ? 'memory' : 'memories'
    const heading =
      shown.length === 0 ? '' : hasPrompted ? `${shown.length} ${noun} in context` : `knows this about ${repoName}`
    const more = shown.length - BAND_ROWS

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={BRAND.hairline} paddingX={1}>
        <Box gap={1}>
          <Text color={ACCENT} bold>
            Kemory
          </Text>
          <Text dimColor>{heading}</Text>
          <Button key="band-open" label="Open" dimColor onPress={() => $.ui.open({ id: PANE, title: 'Kemory' })} />
          <Button
            key="band-hide"
            label="Hide"
            dimColor
            onPress={() => {
              isBandHidden = true
              $.ui.invalidate('ui.render')
            }}
          />
        </Box>
        {update}
        {shown.slice(0, BAND_ROWS).map(m => (
          <Box key={`band-${m.key}`} gap={1}>
            {tag(Text, m.namespace)}
            <Text wrap="truncate-end">{m.title}</Text>
          </Box>
        ))}
        {more > 0 && <Text dimColor>+{more} more in the panel</Text>}
      </Box>
    )
  })

  // A group of calls draws as one count line ("Used 2 tools"). Unfolded, each
  // call is its own row, and a Kemory call's row can draw as a card.
  // Transcript cards are drawn in the terminal only. Elsewhere the Kemory
  // server's own MCP App cards (ui://kemory/memory-saved, recall-results) show
  // each save and recall, in every app that supports them; one card per call.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const holdsKemory = e.props.calls.some(c => !!c.tool_use_id && byCall.has(c.tool_use_id))
    if (!holdsKemory || e.props.isExpanded) return next(e)

    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  // The transcript row of a save or recall becomes one card per memory.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const keys = byCall.get(e.props.tool_use_id)
    if (!keys || keys.length === 0) return next(e)
    const els = $.ui.resolve(e)
    const { Box } = els
    const shown = keys.map(find).filter((x): x is Entry => !!x)

    return <Box flexDirection="column">{shown.map(m => memoryCard($, els, m, e.props.tool_use_id))}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const saved = count(['saved', 'updated'])
    const recalled = count(['recalled'])
    const rated = entries.filter(m => m.rating).length
    const open = suggestions.filter(s => s.state !== 'skipped')
    const svg = 'Svg' in els ? (els as unknown as { Svg: (p: Record<string, unknown>) => never }).Svg : undefined

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2} alignItems="center" borderStyle="round" borderColor={BRAND.hairline} paddingX={1}>
          {svg && svg({ key: 'mark', source: logomark(56), alt: 'Kemory', width: 56, height: 56 })}
          <Box flexDirection="column">
            <Text>
              <Text bold>Kemory</Text>
              {orgName && <Text color={BRAND.grey}> · {orgName}</Text>}
              <Text color={BRAND.grey}> · this session</Text>
            </Text>
            <Text>
              <Text color={BRAND.purple}>●</Text>
              <Text color={BRAND.grey}> SAVED {saved}   </Text>
              <Text color={BRAND.blue}>●</Text>
              <Text color={BRAND.grey}> RECALLED {recalled}   </Text>
              <Text color={BRAND.mint}>●</Text>
              <Text color={BRAND.grey}> RATED {rated}</Text>
            </Text>
            {updateRow($, els, 'pane')}
            {orgRow($, els)}
            {orgMismatch() && (
              <Text color={BRAND.danger}>
                This panel and the kemory hooks write to {orgName}, but Claude's own saves go through the claude.ai
                connector, which writes to {orgMismatch()}. Pick one under Workspace to use it for both.
              </Text>
            )}
            <Box gap={1}>
              <Button
                key="pane-learn"
                variant="primary"
                label={isSuggesting ? 'Reading the session…' : 'Suggest memories'}
                onPress={() => suggest($, true)}
              />
              <Button key="pane-save-reply" label="Save last reply" onPress={() => saveLastReply($)} />
            </Box>
            <Text color={BRAND.grey}>
              Suggest memories reads this session and proposes facts worth keeping. Nothing is saved until you press
              Save.
            </Text>
          </Box>
        </Box>
        {open.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor={BRAND.hairline} paddingX={1}>
            <Text>
              <Text color={BRAND.yellow}>●</Text>
              <Text color={BRAND.grey}> SUGGESTED · NOT SAVED YET</Text>
            </Text>
            {open.map(s => (
              <Box key={`sug-${s.key}`} flexDirection="column">
                <Text color={s.state === 'saved' ? BRAND.grey : undefined}>
                  {s.state === 'saved' ? '✓ ' : ''}
                  {titleOf(s.text)}
                </Text>
                {s.state === 'failed' && <Text color={BRAND.danger}>Could not save: {s.reason}</Text>}
                {s.state !== 'saved' && (
                  <Box gap={1}>
                    <Button
                      key={`sug-save-${s.key}`}
                      label={{ new: 'Save', saving: 'Saving…', failed: 'Retry', skipped: 'Save' }[s.state]}
                      variant="primary"
                      onPress={() => saveSuggestion($, s.key)}
                    />
                    <Button key={`sug-skip-${s.key}`} label="Skip" onPress={() => skipSuggestion($, s.key)} />
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
        {entries.length === 0 && <Text dimColor>Nothing saved or recalled yet.</Text>}
        {[...entries].reverse().map(m => memoryCard($, els, m, 'pane'))}
      </Box>
    )
  })
}
