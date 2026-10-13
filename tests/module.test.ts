import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

// The module under test reads the session through these events; each test
// answers the ones its path reaches. Unanswered, the kit's bottom throws.
// A call on `$` (ui.status, tool.list, mcp.call) is answered as `{ value }`
// beneath the plugin, which is not the shape its result type declares, and
// made to reject with `{ deny }` (a hook that throws is skipped instead).
const answer = (value?: unknown) => ({ value }) as never

const RECALL_CONTEXT = [
  'Kemory recalled these for the prompt above, ranked by relevance.',
  '',
  '- [shared] Where does the Claude Code plugin for kemory live? In its own repo, kemory-plugin.',
  '  (memory_id: 11111111-2222-3333-4444-555555555555)',
  '- [user:preferences] How does Karol want results reported? Short, about five lines.',
  '  (memory_id: 66666666-7777-8888-9999-000000000000)',
].join('\n')

const SURFACES = ['terminal', 'desktop'] as const

const BAND = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'kemory-panel',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 12,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 12 },
      view: {},
    },
  }) as const

test('prompt recall shows in the band and counts on the status line', async ($, on) => {
  mock.env(on, {})
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return answer()
  })
  on('tool.list', () => answer([]))
  on('classic.UserPromptSubmit', () => ({ additionalContext: [RECALL_CONTEXT] }))

  await $.classic.UserPromptSubmit({ prompt: 'where does the kemory plugin live?' })

  expect(statuses.at(-1)).toContain('2 recalled')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(BAND(surface))
    expect((await ui.find({ text: /2 memories in context/ }))?.text).toBeTruthy()
    expect((await ui.find({ text: /Where does the Claude Code plugin for kemory live\?/ }))?.text).toBeTruthy()
  }
})

test('a store call becomes a card and a toast', async ($, on) => {
  mock.env(on, {})
  const toasts: string[] = []
  on('ui.status', () => answer())
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return answer()
  })
  let callId = ''
  on('tool.call', (_$, e) => {
    callId = e.tool_use_id ?? ''
    return {
      result: {},
      text: 'Memory stored successfully.\nID: abc-123\nNamespace: shared\nVersion: 1\nContent type: fact',
    }
  })

  const content = 'Why does the band show nothing on a short prompt? Short prompts need 0.65 similarity.'
  await $.tool.call({ tool: 'mcp__plugin_kemory_kemory__kemory_store_memory', content, namespace: 'shared' })

  expect(toasts.at(-1)).toBe('Saved to shared: "Why does the band show nothing on a short prompt?"')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'kemory-panel',
      surface,
      component: 'ToolUse',
      props: {
        tool_use_id: callId,
        tool: 'mcp__plugin_kemory_kemory__kemory_store_memory',
        input: { content },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    } as never)
    expect(await ui.find({ type: 'Text', text: 'Saved to Kemory' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Why does the band show nothing on a short prompt\?$/ })).toBeTruthy()
    // Closed: one line of the memory, then Show more opens it with its actions.
    expect(await ui.find({ text: /^Short prompts need 0\.65 similarity\.$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: 'Delete' })).toBeUndefined()
    await ui.press({ key: `open-${callId}-abc-123` } as never)
    expect(await ui.find({ type: 'Markdown' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: 'Delete' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: 'Show less' })).toBeTruthy()
    await ui.press({ key: `open-${callId}-abc-123` } as never)
  }
})

test("a live connector moves the plugin's duplicate tools behind tool search", async ($, on) => {
  mock.env(on, {})
  on('ui.status', () => answer())
  on('tool.list', () => answer([{ name: 'mcp__conn-1__kemory_whoami', description: '', mcp: true }]))
  on('mcp.call', () => answer({ content: [{ type: 'text', text: '{"user":"k"}' }], isError: false }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: [] }))
  on('tool.describe', (_$, e) => ({ description: e.description }))

  await $.classic.UserPromptSubmit({ prompt: 'anything long enough to recall' })
  const described = await $.tool.describe({
    tool: 'mcp__plugin_kemory_kemory__kemory_recall_memory',
    description: 'Search memories.',
    provider: { plugin: 'kemory', tier: 'user' },
  } as never)

  expect(described.isDeferred).toBe(true)
  expect(described.description).toContain('mcp__conn-1__kemory_recall_memory')
})

test('a connector that refuses the call leaves the plugin tools in front', async ($, on) => {
  mock.env(on, {})
  on('ui.status', () => answer())
  on('tool.list', () => answer([{ name: 'mcp__conn-1__kemory_whoami', description: '', mcp: true }]))
  on('mcp.call', () => answer({ content: [{ type: 'text', text: 'disabled in your connector settings' }], isError: true }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: [] }))
  on('tool.describe', (_$, e) => ({ description: e.description }))

  await $.classic.UserPromptSubmit({ prompt: 'anything long enough to recall' })
  const described = await $.tool.describe({
    tool: 'mcp__plugin_kemory_kemory__kemory_recall_memory',
    description: 'Search memories.',
    provider: { plugin: 'kemory', tier: 'user' },
  } as never)

  expect(described.isDeferred).toBeUndefined()
  expect(described.description).toBe('Search memories.')
})

test('KEMORY_ALLOW_DUPLICATE=1 keeps both sets in front', async ($, on) => {
  mock.env(on, { KEMORY_ALLOW_DUPLICATE: '1' })
  on('ui.status', () => answer())
  on('tool.list', () => answer([{ name: 'mcp__conn-1__kemory_whoami', description: '', mcp: true }]))
  on('mcp.call', () => answer({ content: [], isError: false }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: [] }))
  on('tool.describe', (_$, e) => ({ description: e.description }))

  await $.classic.UserPromptSubmit({ prompt: 'anything long enough to recall' })
  const described = await $.tool.describe({
    tool: 'mcp__plugin_kemory_kemory__kemory_recall_memory',
    description: 'Search memories.',
    provider: { plugin: 'kemory', tier: 'user' },
  } as never)

  expect(described.isDeferred).toBeUndefined()
})

const PANE = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'kemory-panel',
    surface,
    component: 'Pane',
    requestId: 'kemory-memories',
    props: { title: 'Kemory', isFocused: true, bodyColumns: 100, placement: 'dock' },
  }) as never

const SUGGESTED = 'How do we test a marketplace entry without touching the real install? Use a throwaway CLAUDE_CONFIG_DIR.'
const STORED = { content: [{ type: 'text', text: 'Memory stored successfully.\nID: m-1\nNamespace: shared\nVersion: 1' }], isError: false }
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

for (const surface of SURFACES) {
  test(`a suggested memory that fails to save says why and offers Retry (${surface})`, async ($, on) => {
    mock.env(on, {})
    const toasts: string[] = []
    on('ui.status', () => answer())
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return answer()
    })
    on('model.fork', () => answer({ isAnswered: true, text: JSON.stringify([SUGGESTED]), usage: USAGE }))
    let calls = 0
    on('mcp.call', () => {
      calls += 1
      if (calls === 1) return { deny: 'Kemory API returned 503' } as never
      return answer(STORED)
    })

    const ui = await $.ui.mount(PANE(surface))
    await ui.press({ key: 'pane-learn' } as never)
    expect(await ui.find({ text: /SUGGESTED · NOT SAVED YET/ })).toBeTruthy()

    await ui.press({ key: 'sug-save-s-0' } as never)
    expect(await ui.find({ text: /Could not save: .*503/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', text: 'Retry' })).toBeTruthy()
    expect(toasts.some(t => t.startsWith('Kemory: save failed:'))).toBe(true)

    await ui.press({ key: 'sug-save-s-0' } as never)
    expect(await ui.find({ text: /Could not save/ })).toBeUndefined()
    expect(await ui.find({ text: /SAVED 1/ })).toBeTruthy()
  })
}

test('a save made while the server is still connecting is tried again', async ($, on) => {
  mock.env(on, {})
  const clock = mock.clock(on)
  on('ui.status', () => answer())
  on('ui.toast', () => answer())
  on('model.fork', () => answer({ isAnswered: true, text: JSON.stringify([SUGGESTED]), usage: USAGE }))
  let calls = 0
  on('mcp.call', () => {
    calls += 1
    if (calls === 1) {
      return { deny: 'no connected MCP tool "kemory_store_memory" on a server named "plugin:kemory:kemory"' } as never
    }
    return answer(STORED)
  })

  const ui = await $.ui.mount(PANE('desktop'))
  await ui.press({ key: 'pane-learn' } as never)
  const pressed = ui.press({ key: 'sug-save-s-0' } as never)
  await clock.advance(2000)
  await pressed

  expect(calls).toBe(2)
  expect(await ui.find({ text: /SAVED 1/ })).toBeTruthy()
})

const recallOf = (memories: { id: string; ns: string; text: string; score: number }[]) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        memories: memories.map(m => ({ memory_id: m.id, namespace: m.ns, content: m.text, similarity_score: m.score })),
      }),
    },
  ],
  isError: false,
})

test('the repo brief keeps strong matches only, each card with its title on a line of its own', async ($, on) => {
  mock.env(on, {})
  on('ui.status', () => answer())
  on('ui.toast', () => answer())
  on('tool.list', () => answer([]))
  on('process.run', () => answer({ stdout: '200', stderr: '', code: 0 }))
  on('session.root', () => answer('/Users/k/src/kemory-plugin'))
  on('mcp.call', (_$, e) =>
    answer(
      e.tool === 'kemory_recall_memory'
        ? recallOf([
            { id: 'strong', ns: 'project:kemory-api-integration', text: 'Where does the kemory plugin live? In kemory-plugin.', score: 0.71 },
            { id: 'weak', ns: 'shared', text: 'The user requested to connect to Kemory once.', score: 0.6 },
          ])
        : { content: [], isError: false },
    ),
  )

  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/Users/k/src/kemory-plugin', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ text: /Where does the kemory plugin live\?/ })).toBeTruthy()
  expect(await ui.find({ text: /connect to Kemory once/ })).toBeUndefined()

  // No row holds both the label and the title.
  type Node = string | { type: string; props?: { label?: string }; children?: Node[] }
  const textOf = (n: Node): string =>
    typeof n === 'string' ? n : (n.props?.label ?? '') + (n.children ?? []).map(textOf).join('')
  const rows: Node[][] = []
  const walk = (n: Node) => {
    if (typeof n === 'string') return
    if (n.type === 'Box') rows.push(n.children ?? [])
    for (const c of n.children ?? []) walk(c)
  }
  walk((await ui.drawn()) as unknown as Node)
  const holds = (row: Node[], re: RegExp) => row.some(c => re.test(textOf(c)))
  expect(rows.some(r => holds(r, /^Kemory knows this about the repo$/))).toBe(true)
  expect(rows.some(r => holds(r, /^Kemory knows this about the repo$/) && holds(r, /kemory plugin live/))).toBe(false)
})

// The update check reads the panel's own manifest, both repositories' latest
// manifests and installed_plugins.json, and toasts the commands once.
function updateCheck(
  on: On,
  v: { running: string; latestPanel: string; latestKemory: string; installed: Record<string, string> },
) {
  const toasts: string[] = []
  const statuses: string[] = []
  mock.env(on, { HOME: '/home/k' })
  on('ui.status', (_$, e) => {
    statuses.push(e.text ?? '')
    return answer()
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return answer()
  })
  on('tool.list', () => answer([]))
  on('session.root', () => answer('/home/k/src/app'))
  on('session.surfaces', () => answer(['desktop']))
  on('process.run', () => answer({ stdout: '200', stderr: '', code: 0 }))
  on('mcp.call', () => answer({ content: [], isError: false }))
  on('http.fetch', (_$, e) =>
    answer({
      ok: true,
      status: 200,
      text: JSON.stringify({ version: String(e.url).includes('kemory-panel') ? v.latestPanel : v.latestKemory }),
    }),
  )
  on('fs.read', (_$, e) => {
    const path = String((e as { path?: string }).path ?? e)
    if (path.endsWith('installed_plugins.json')) {
      const plugins = Object.fromEntries(Object.entries(v.installed).map(([n, ver]) => [`${n}@kemory`, [{ version: ver }]]))
      return answer(JSON.stringify({ plugins }))
    }
    return answer(JSON.stringify({ version: v.running }))
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)

  return { toasts, statuses }
}

const start = async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/home/k/src/app', surface: 'desktop', isInteractive: true })
  await clock.settle()
}

test('each plugin is checked against its own latest version', async ($, on) => {
  const { toasts, statuses } = updateCheck(on, {
    running: '0.15.0',
    latestPanel: '0.15.0',
    latestKemory: '0.15.1',
    installed: { kemory: '0.15.1', 'kemory-panel': '0.15.0' },
  })
  await start($, on)

  expect(toasts.some(t => /is out|not installed/.test(t))).toBe(false)
  expect(statuses.at(-1)).not.toContain('↑')
})

test('an outdated kemory is named with its own versions and its update command', async ($, on) => {
  const { toasts, statuses } = updateCheck(on, {
    running: '0.15.0',
    latestPanel: '0.15.0',
    latestKemory: '0.15.1',
    installed: { kemory: '0.14.0', 'kemory-panel': '0.15.0' },
  })
  await start($, on)

  const toast = toasts.find(t => t.includes('is out')) ?? ''
  expect(toast).toContain('kemory 0.15.1 is out (you have 0.14.0)')
  expect(toast).toContain("'claude plugin update kemory@kemory'")
  expect(toast).not.toContain('kemory-panel@kemory')
  expect(statuses.at(-1)).toContain('↑ kemory 0.15.1')
})

test('a missing kemory plugin gets an install command, not an update', async ($, on) => {
  const { toasts, statuses } = updateCheck(on, {
    running: '0.15.0',
    latestPanel: '0.15.0',
    latestKemory: '0.15.1',
    installed: { 'kemory-panel': '0.15.0' },
  })
  await start($, on)

  const toast = toasts.find(t => t.includes('not installed')) ?? ''
  expect(toast).toContain("'claude plugin install kemory@kemory'")
  expect(toast).not.toContain('update')
  expect(statuses.at(-1)).toContain('kemory plugin not installed')
})

test('an outdated kemory-panel is named with its own versions', async ($, on) => {
  const { toasts } = updateCheck(on, {
    running: '0.15.0',
    latestPanel: '0.16.0',
    latestKemory: '0.15.1',
    installed: { kemory: '0.15.1', 'kemory-panel': '0.15.0' },
  })
  await start($, on)

  const toast = toasts.find(t => t.includes('is out')) ?? ''
  expect(toast).toContain('kemory-panel 0.16.0 is out (you have 0.15.0)')
  expect(toast).toContain("'claude plugin update kemory-panel@kemory'")
  expect(toast).not.toContain("'claude plugin update kemory@kemory'")
})

test('a live connector on the same organisation adds nothing to the panel or the status line', async ($, on) => {
  mock.env(on, {})
  const statuses: string[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text ?? '')
    return answer()
  })
  on('tool.list', () => answer([{ name: 'mcp__conn-1__kemory_whoami', description: '', mcp: true }]))
  on('mcp.call', () => answer({ content: [{ type: 'text', text: '{"user":"k"}' }], isError: false }))
  on('classic.UserPromptSubmit', () => ({ additionalContext: [] }))

  await $.classic.UserPromptSubmit({ prompt: 'anything long enough to recall' })

  expect(statuses.some(t => t.includes('connector'))).toBe(false)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ text: /connector/ })).toBeUndefined()
  }
})

// whoami answers per server: the plugin's own and, when given, a connector's.
function orgs(on: On, plugin: string, connectorOrg?: string) {
  const toasts: string[] = []
  const statuses: string[] = []
  mock.env(on, { HOME: '/home/k' })
  on('ui.status', (_$, e) => {
    statuses.push(e.text ?? '')
    return answer()
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return answer()
  })
  on('tool.list', () =>
    answer(connectorOrg ? [{ name: 'mcp__conn-1__kemory_whoami', description: '', mcp: true }] : []),
  )
  on('session.root', () => answer('/home/k/src/app'))
  on('session.surfaces', () => answer(['desktop']))
  on('process.run', () => answer({ stdout: '200', stderr: '', code: 0 }))
  on('http.fetch', () => answer({ ok: false, status: 404, text: '' }))
  on('fs.read', () => answer('{"plugins":{"kemory@kemory":[{"version":"0.15.1"}]}}'))
  on('mcp.call', (_$, e) => {
    if (e.tool !== 'kemory_whoami') return answer({ content: [], isError: false })
    const name = e.server === 'conn-1' ? connectorOrg : plugin
    return answer({ content: [{ type: 'text', text: JSON.stringify({ org_name: name }) }], isError: false })
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)

  return { toasts, statuses }
}

test('the status line and the panel name the organisation the plugin writes to', async ($, on) => {
  const { toasts, statuses } = orgs(on, 'SeKondBrain')
  await start($, on)

  expect(statuses.at(-1)).toContain('✓ SeKondBrain')
  expect(toasts.some(t => t.includes('connector'))).toBe(false)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ text: / · SeKondBrain/ })).toBeTruthy()
  }
})

test('a connector on another organisation is flagged, with the command to fix it', async ($, on) => {
  const { toasts, statuses } = orgs(on, 'StressTest', 'SeKondBrain')
  await start($, on)

  expect(statuses.at(-1)).toContain('✓ StressTest')
  expect(statuses.at(-1)).toContain('⚠ connector on SeKondBrain')
  const toast = toasts.find(t => t.includes('connector')) ?? ''
  expect(toast).toContain('the plugin writes to StressTest but the claude.ai connector writes to SeKondBrain')
  expect(toast).toContain(`'kemory use "SeKondBrain"'`)
  expect(toasts.filter(t => t.includes('connector writes to'))).toHaveLength(1)
  const ui = await $.ui.mount(PANE('desktop'))
  expect(await ui.find({ text: /Claude's own saves go through the claude\.ai/ })).toBeTruthy()
})
