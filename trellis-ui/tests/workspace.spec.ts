import { test, expect } from '@playwright/test'

const path = {
  id: 'path-1',
  title: 'Database fundamentals',
  description: 'Understand relational data.',
  input: 'Learn databases',
  progress: 0,
  node_count: 1,
  completed_count: 0,
  updated_at: '2026-09-25T10:00:00Z',
}
const node = {
  id: 'node-1',
  path_id: path.id,
  parent_id: null,
  title: 'Transactions',
  description: 'Atomic units of work.',
  position: 0,
  status: 'not_started',
}
const workspace = {
  paths: [path],
  location: { path_id: path.id, node_id: node.id, thread_id: null },
  stats: { paths: 1, nodes: 1, completed: 0, notebook_items: 0 },
}

// Intercepted API tests verify browser state and request boundaries, not provider quality.
test('source-aware creation sends the selected material and opens the returned curriculum', async ({
  page,
}) => {
  let body: unknown
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace')
      return route.fulfill({ json: { ...workspace, paths: [], location: {} } })
    if (url === '/api/sources')
      return route.fulfill({
        json: [
          {
            id: 'source-1',
            path_id: null,
            title: 'Database handbook',
            kind: 'text',
            status: 'ready',
            chunk_count: 3,
          },
        ],
      })
    if (url === '/api/paths' && route.request().method() === 'POST') {
      body = route.request().postDataJSON()
      return route.fulfill({ json: { ...path, nodes: [node] } })
    }
    if (url === '/api/paths') return route.fulfill({ json: [path] })
    if (url === `/api/paths/${path.id}`) return route.fulfill({ json: { ...path, nodes: [node] } })
    if (url === '/api/location') return route.fulfill({ json: {} })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto('/?screen=create')
  await page.getByLabel('Your goal').fill('Learn databases')
  await page.getByRole('button', { name: 'Choose from source library', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Database handbook', exact: true }).check()
  await page.getByRole('button', { name: 'Use selected sources', exact: true }).click()
  await page.getByRole('button', { name: 'Build My Learning Path' }).click()
  await expect(page.getByRole('heading', { name: path.title })).toBeVisible()
  expect(body).toEqual({
    input: 'Learn databases',
    mode: 'goal',
    source_ids: ['source-1'],
  })
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit Transactions', exact: true })).toBeVisible()
})

test('thread answers stay on the thread endpoint and returning restores primary conversation', async ({
  page,
}) => {
  const primary = {
    id: 'primary',
    path_id: path.id,
    node_id: node.id,
    thread_id: null,
    prompt: 'Explain transactions',
    content: 'Primary learning explanation.',
    action: 'foundation',
    status: 'answered',
    evidence: [],
    evaluation: {},
    created_at: '2026-09-25T10:00:00Z',
  }
  const thread = {
    id: 'thread-1',
    path_id: path.id,
    node_id: node.id,
    title: 'Historical context',
    status: 'open',
    seed_context: '',
    created_at: primary.created_at,
  }
  const threadMessages: object[] = []
  const posts: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: {} })
    if (url === '/api/nodes/node-1')
      return route.fulfill({
        json: {
          node,
          path,
          nodes: [node],
          interactions: [
            primary,
            {
              ...primary,
              id: 'later',
              prompt: 'Explain isolation',
              content: 'A later primary explanation.',
            },
          ],
          threads: [thread],
        },
      })
    if (url === '/api/threads/thread-1')
      return route.fulfill({
        json: { thread, node, path, interactions: threadMessages },
      })
    if (url.endsWith('/interactions') && route.request().method() === 'POST') {
      posts.push(url)
      const answer = {
        ...primary,
        id: 'thread-answer',
        thread_id: thread.id,
        prompt: route.request().postDataJSON().prompt,
        content: 'Independent exploration response.',
      }
      threadMessages.push(answer)
      return route.fulfill({ json: answer })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await expect(page.getByRole('heading', { name: 'Explain isolation', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Explain transactions', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Explain transactions', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Primary learning explanation.', { exact: true }).first(),
  ).toBeVisible()
  await page.getByRole('button', { name: '↗ Historical context open' }).click()
  await expect(page.getByRole('heading', { name: thread.title, exact: true })).toBeVisible()
  await page.getByLabel('Ask about this topic').fill('When did transactions emerge?')
  await page.getByRole('button', { name: 'Ask Trellis' }).click()
  await expect(
    page.getByText('Independent exploration response.', { exact: true }).first(),
  ).toBeVisible()
  expect(posts).toEqual(['/api/threads/thread-1/interactions'])
  await page.getByRole('button', { name: 'Return to Learning Node' }).click()
  await expect(
    page.getByRole('heading', { name: 'Explain transactions', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Primary learning explanation.', { exact: true }).first(),
  ).toBeVisible()
  await expect(page.getByText('Independent exploration response.', { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Explain transactions', exact: true }),
  ).toBeVisible()
})

test('question progress appears before the checked answer stream is shown', async ({ page }) => {
  const answer = {
    id: 'checked-answer',
    path_id: path.id,
    node_id: node.id,
    thread_id: null,
    prompt: 'What is a transaction?',
    content: 'A transaction groups operations into one unit. [1]',
    action: 'question',
    status: 'answered',
    evidence: [{ id: 'passage-1', title: 'Database guide', excerpt: 'A transaction is one unit.' }],
    evaluation: { status: 'passed' },
    provider: 'fixture',
    model: 'fixture',
    created_at: '2026-09-25T10:00:00Z',
  }
  let releaseAnswer!: () => void
  const savedInteractions: object[] = []
  const answerReady = new Promise<void>((resolve) => {
    releaseAnswer = resolve
  })
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: {} })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { node, path, nodes: [node], interactions: savedInteractions, threads: [] },
      })
    if (url === `/api/nodes/${node.id}/interactions`) {
      expect(route.request().headers()['accept']).toBe('application/x-ndjson')
      await answerReady
      savedInteractions.push(answer)
      const events = [
        { type: 'progress', stage: 'finding_sources' },
        { type: 'progress', stage: 'writing' },
        { type: 'progress', stage: 'checking' },
        { type: 'progress', stage: 'saving' },
        { type: 'answer_delta', text: answer.content.slice(0, 25) },
        { type: 'answer_delta', text: answer.content.slice(25) },
        { type: 'done', interaction: answer },
      ]
      return route.fulfill({
        contentType: 'application/x-ndjson',
        body: events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })

  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await page.getByLabel('Ask about this topic').fill(answer.prompt)
  await page.getByRole('button', { name: 'Ask Trellis' }).click()
  await expect(page.getByRole('region', { name: 'Answer in progress' })).toContainText(
    'Understanding your question…',
  )
  releaseAnswer()
  await expect(page.getByRole('heading', { name: answer.prompt })).toBeVisible()
  await expect(
    page.getByTestId('lesson').getByText('A transaction groups operations into one unit.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Read response to ' + answer.prompt }),
  ).toBeVisible()
})

test('Enter sends a question and Shift+Enter adds a new line', async ({ page }) => {
  const prompts: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: {} })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { node, path, nodes: [node], interactions: [], threads: [] },
      })
    if (url === `/api/nodes/${node.id}/interactions`) {
      const prompt = route.request().postDataJSON().prompt
      prompts.push(prompt)
      return route.fulfill({
        json: {
          id: 'keyboard-answer',
          path_id: path.id,
          node_id: node.id,
          thread_id: null,
          prompt,
          content: 'A transaction groups operations into one unit.',
          action: 'question',
          status: 'answered',
          evidence: [],
          evaluation: {},
          created_at: '2026-09-25T10:00:00Z',
        },
      })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })

  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  const composer = page.getByLabel('Ask about this topic')
  await composer.fill('How do transactions work?')
  await composer.press('Shift+Enter')
  await composer.type('Give an example.')
  await expect(composer).toHaveValue('How do transactions work?\nGive an example.')
  expect(prompts).toEqual([])

  await composer.press('Enter')
  await expect.poll(() => prompts).toEqual(['How do transactions work?\nGive an example.'])
  await expect(composer).toHaveValue('')
})

test('a failed answer stream shows the error without adding a response', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: {} })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({ json: { node, path, nodes: [node], interactions: [], threads: [] } })
    if (url === `/api/nodes/${node.id}/interactions`)
      return route.fulfill({
        contentType: 'application/x-ndjson',
        body:
          [
            { type: 'progress', stage: 'finding_sources' },
            { type: 'error', message: 'The model is unavailable.', status: 503 },
          ]
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n',
      })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })

  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await page.getByLabel('Ask about this topic').fill('What is a transaction?')
  await page.getByRole('button', { name: 'Ask Trellis' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'The model is unavailable.' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Read response to/ })).toHaveCount(0)
})

test('failed creation displays the server error and does not claim success', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/sources') return route.fulfill({ json: [] })
    if (url === '/api/paths')
      return route.fulfill({
        status: 503,
        json: { detail: 'The configured model is unavailable.' },
      })
    return route.fulfill({ json: {} })
  })
  await page.goto('/?screen=create')
  await page.getByLabel('Your goal').fill('Learn databases')
  await page.getByRole('button', { name: 'Build My Learning Path' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'The configured model is unavailable.' }),
  ).toHaveText('The configured model is unavailable.')
  await expect(page.getByRole('heading', { name: 'What do you want to learn?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Build My Learning Path' })).toBeEnabled()
})

test('changing a study selection clears its previous PDF and reports failed saves honestly', async ({
  page,
}) => {
  const first = {
    id: 'note-1',
    page_id: 'page-1',
    path_id: path.id,
    title: 'First note',
    content: 'First material',
    position: 0,
  }
  const second = {
    id: 'note-2',
    page_id: 'page-1',
    path_id: path.id,
    title: 'Second note',
    content: 'Second material',
    position: 1,
  }
  let selected = ['note-1']
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/paths') return route.fulfill({ json: [path] })
    if (url === '/api/notebook/pages')
      return route.fulfill({
        json: [
          {
            id: 'page-1',
            path_id: path.id,
            title: 'Study notes',
            position: 0,
            items: [first, second],
          },
        ],
      })
    if (url === '/api/study-sessions')
      return route.fulfill({
        json: [{ id: 'study-1', path_id: path.id, title: 'Review', item_ids: selected }],
      })
    if (url === '/api/study-sessions/study-1') {
      const ids = route.request().postDataJSON().item_ids
      if (!ids.includes('note-1'))
        return route.fulfill({ status: 500, json: { detail: 'Could not save selection.' } })
      selected = ids
      return route.fulfill({
        json: { id: 'study-1', path_id: path.id, title: 'Review', item_ids: selected },
      })
    }
    if (url === '/api/exports')
      return route.fulfill({
        json:
          route.request().method() === 'POST'
            ? {
                id: 'export-1',
                path_id: path.id,
                title: 'Review',
                status: 'completed',
                download_url: '/api/exports/export-1/download',
              }
            : [],
      })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto(`/?screen=session&path=${path.id}`)
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Download prepared PDF' })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Second note Second material' }).click()
  await expect(page.getByRole('checkbox', { name: 'Second note Second material' })).toBeChecked()
  await expect(page.getByRole('link', { name: 'Download prepared PDF' })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'First note First material' }).click()
  await expect(page.getByText('Selection was not saved.', { exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'First note First material' })).toBeChecked()
})
