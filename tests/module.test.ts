import { expect, mock, test } from 'claude-code/testing'

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
    plugin: 'kemory-plus',
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
      plugin: 'kemory-plus',
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
    expect(await ui.find({ type: 'Button', text: /Why does the band show nothing on a short prompt\?/ })).toBeTruthy()
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
    plugin: 'kemory-plus',
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
