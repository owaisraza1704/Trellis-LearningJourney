import { expect, test, type Page } from '@playwright/test'
import type { Interaction, NodeDetail, PathDetail, Thread } from '../src/lib/api'

const created = '2026-09-25T10:00:00Z'
const path: PathDetail = {
  id: 'design-path',
  title: 'System Design',
  description: 'Learn how services handle requests.',
  input: 'Learn system design',
  progress: 0,
  node_count: 2,
  completed_count: 0,
  updated_at: created,
  nodes: [
    {
      id: 'fundamentals',
      path_id: 'design-path',
      parent_id: null,
      title: 'Request fundamentals',
      description: 'Understand a request before optimizing it.',
      position: 0,
      status: 'not_started',
    },
    {
      id: 'cache',
      path_id: 'design-path',
      parent_id: null,
      title: 'Cache-aside',
      description: 'Read through the cache and handle misses.',
      position: 1,
      status: 'in_progress',
    },
  ],
}
const oldAnswer: Interaction = {
  id: 'old-answer',
  path_id: path.id,
  node_id: 'cache',
  thread_id: null,
  prompt: 'How does cache-aside work?',
  content: [
    'Read the cache before querying the database. [1]',
    '',
    '```python',
    'values = [1]',
    'print(values[0])',
    '``` [2]',
    '',
    'Inline examples such as `[1]` stay literal. [99]',
    '',
    '[Guide [1]](https://example.org/cache)',
  ].join('\n'),
  action: 'question',
  status: 'answered',
  evidence: [
    {
      id: 'cache-passage',
      title: 'Cache guide',
      excerpt: `${'A cache miss reads the backing store. '.repeat(25)}CACHE_PASSAGE_END`,
      url: 'https://example.org/cache',
    },
    {
      id: 'sequence-passage',
      title: 'Sequence reference',
      excerpt: `${'A list preserves its element order. '.repeat(25)}SEQUENCE_PASSAGE_END`,
      url: 'https://example.org/sequences',
    },
  ],
  evaluation: { status: 'passed', grounding: 1, completeness: 0.9 },
  provider: 'fixture',
  model: 'fixture',
  created_at: created,
}
const recentAnswer: Interaction = {
  ...oldAnswer,
  id: 'recent-answer',
  prompt: 'What happens on a cache miss?',
  content: 'Read the backing store and populate the cache. [1]',
}
const thread: Thread = {
  id: 'cache-consistency',
  path_id: path.id,
  node_id: 'cache',
  title: 'Cache consistency',
  status: 'open',
  seed_context: 'Explore updates.',
  created_at: created,
}

// Only the HTTP boundary is mocked; navigation, query retries, rendering and focus run in the browser.
async function mockLearning(page: Page) {
  const journey = structuredClone(path)
  const detail: NodeDetail = {
    node: journey.nodes[1],
    path: journey,
    nodes: journey.nodes,
    interactions: structuredClone([oldAnswer, recentAnswer]),
    threads: [thread],
  }
  const state = {
    nodeFailures: [] as number[],
    nodeReads: 0,
    failQuestions: false,
    questionPosts: [] as Array<{ prompt: string; action: string }>,
    detail,
  }
  let location = { path_id: path.id, node_id: 'cache', thread_id: null as string | null }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace')
      return route.fulfill({
        json: {
          paths: [journey],
          location,
          stats: { paths: 1, nodes: 2, completed: journey.completed_count, notebook_items: 2 },
        },
      })
    if (url === '/api/location') {
      location = { ...location, ...route.request().postDataJSON() }
      return route.fulfill({ json: location })
    }
    if (url === '/api/paths') return route.fulfill({ json: [journey] })
    if (url === `/api/paths/${journey.id}`) return route.fulfill({ json: journey })
    if (url === '/api/nodes/cache') {
      state.nodeReads++
      const failure = state.nodeFailures.shift()
      return failure
        ? route.fulfill({ status: failure, json: { detail: `Node read failed (${failure}).` } })
        : route.fulfill({ json: detail })
    }
    if (url === '/api/nodes/cache/interactions') {
      const body = route.request().postDataJSON()
      state.questionPosts.push(body)
      if (state.failQuestions)
        return route.fulfill({ status: 503, json: { detail: 'Answer service is unavailable.' } })
      const answer = {
        ...recentAnswer,
        id: `new-answer-${state.questionPosts.length}`,
        prompt: body.prompt,
        content: 'A newly requested explanation. [1]',
      }
      detail.interactions.push(answer)
      return route.fulfill({ json: answer })
    }
    if (url === `/api/threads/${thread.id}`)
      return route.fulfill({
        json: { thread, path: journey, node: detail.node, interactions: [recentAnswer] },
      })
    if (url === '/api/notebook/pages')
      return route.fulfill({
        json: [
          {
            id: 'notes',
            path_id: journey.id,
            title: 'Design notes',
            position: 0,
            items: [
              {
                id: 'first-note',
                page_id: 'notes',
                title: 'Unrelated first note',
                content: 'This is not the note selected from history.',
                position: 0,
                created_at: created,
              },
              {
                id: 'cache-note',
                page_id: 'notes',
                title: 'Saved cache summary',
                content: 'The exact note selected from history.',
                position: 1,
                created_at: created,
              },
            ],
          },
        ],
      })
    if (url === '/api/history')
      return route.fulfill({
        json: [
          {
            id: 'saved-note-activity',
            kind: 'notebook_saved',
            label: 'Saved cache summary',
            path_id: journey.id,
            node_id: 'cache',
            notebook_item_id: 'cache-note',
            created_at: created,
          },
          {
            id: 'old-question-activity',
            kind: 'interaction',
            label: oldAnswer.prompt,
            path_id: journey.id,
            node_id: 'cache',
            interaction_id: oldAnswer.id,
            created_at: created,
          },
        ],
      })
    if (url === '/api/learning-sessions')
      return route.fulfill({
        json: [
          {
            id: 'previous-session',
            path_id: journey.id,
            node_id: 'cache',
            thread_id: thread.id,
            path_title: journey.title,
            node_title: detail.node.title,
            thread_title: thread.title,
            started_at: '2026-09-24T10:00:00Z',
            last_active_at: '2026-09-24T10:30:00Z',
            ended_at: '2026-09-24T10:31:00Z',
          },
        ],
      })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  return state
}

test('a transient node read recovers automatically once', async ({ page }) => {
  const state = await mockLearning(page)
  state.nodeFailures.push(500)
  await page.goto('/?screen=node&path=design-path&node=cache')
  await expect(page.getByRole('heading', { name: 'Cache-aside', exact: true })).toBeVisible()
  expect(state.nodeReads).toBe(2)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  expect(state.questionPosts).toEqual([])
})

test('an exhausted node read exposes Retry and recovers through the explicit action', async ({
  page,
}) => {
  const state = await mockLearning(page)
  state.nodeFailures.push(500, 500)
  await page.goto('/?screen=node&path=design-path&node=cache')
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Node read failed (500).')
  expect(state.nodeReads).toBe(2)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cache-aside', exact: true })).toBeVisible()
  expect(state.nodeReads).toBe(3)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
})

test('missing-node reads and failed answer writes are not automatically replayed', async ({
  page,
}) => {
  await page.clock.install()
  const state = await mockLearning(page)
  state.nodeFailures.push(404)
  state.failQuestions = true
  await page.goto('/?screen=node&path=design-path&node=cache')
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Node read failed (404).')
  await page.clock.runFor(3000)
  expect(state.nodeReads).toBe(1)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cache-aside', exact: true })).toBeVisible()
  await page.getByLabel('Ask about this topic', { exact: true }).fill('Explain write ordering.')
  await page.getByRole('button', { name: 'Ask Trellis', exact: true }).click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Answer service is unavailable.',
  )
  await page.clock.runFor(3000)
  expect(state.questionPosts).toEqual([{ prompt: 'Explain write ordering.', action: 'question' }])
  await expect(page.getByLabel('Ask about this topic', { exact: true })).toHaveValue(
    'Explain write ordering.',
  )
})

test('legacy code fences render cleanly and citations focus their matching full passage', async ({
  page,
}) => {
  await mockLearning(page)
  await page.goto('/?screen=node&path=design-path&node=cache&interaction=old-answer')
  const answer = page.getByRole('region', { name: 'Lesson', exact: true }).getByRole('article')
  await expect(answer.getByRole('heading', { name: oldAnswer.prompt, exact: true })).toBeVisible()
  await expect(answer.locator('pre code')).toHaveText('values = [1]\nprint(values[0])\n')
  await expect(answer.locator('pre')).not.toContainText('```')
  await expect(answer.locator('pre button')).toHaveCount(0)
  await expect(answer.locator('code').last()).toHaveText('[1]')
  await expect(answer.getByRole('link', { name: 'Guide [1]', exact: true })).toHaveAttribute(
    'href',
    'https://example.org/cache',
  )
  await expect(
    answer.getByRole('button', { name: 'View cited passage 1', exact: true }),
  ).toHaveCount(1)
  await expect(
    answer.getByRole('button', { name: 'View cited passage 2', exact: true }),
  ).toHaveCount(1)
  await expect(
    answer.getByRole('button', { name: 'View cited passage 99', exact: true }),
  ).toHaveCount(0)
  await answer.getByRole('button', { name: '2 cited passages', exact: true }).click()
  const first = page.getByRole('article', { name: 'Cited passage 1', exact: true })
  const second = page.getByRole('article', { name: 'Cited passage 2', exact: true })
  await expect(first).not.toContainText('CACHE_PASSAGE_END')
  await expect(second).not.toContainText('SEQUENCE_PASSAGE_END')
  await answer.getByRole('button', { name: 'View cited passage 2', exact: true }).click()
  await expect(second).toBeFocused()
  await expect(second).toContainText('SEQUENCE_PASSAGE_END')
  await expect(second.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(first).not.toContainText('CACHE_PASSAGE_END')
  await second.getByRole('button', { name: 'Show less', exact: true }).click()
  await answer.getByRole('button', { name: 'View cited passage 2', exact: true }).click()
  await expect(second).toContainText('SEQUENCE_PASSAGE_END')
})

test('an exact response link opens the old answer and allows selecting other responses', async ({
  page,
}) => {
  const state = await mockLearning(page)
  await page.goto('/?screen=node&path=design-path&node=cache&interaction=old-answer')
  const response = page.getByRole('region', { name: 'Lesson', exact: true }).getByRole('article')
  await expect(response).toHaveCount(1)
  await expect(response.getByRole('heading')).toHaveText(oldAnswer.prompt)
  await page
    .getByRole('button', { name: `Read response to ${recentAnswer.prompt}`, exact: true })
    .click()
  await expect(response).toHaveCount(1)
  await expect(response.getByRole('heading')).toHaveText(recentAnswer.prompt)
  await page.getByLabel('Ask about this topic', { exact: true }).fill('Explain cache eviction.')
  await page.getByRole('button', { name: 'Ask Trellis', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Explain cache eviction.', exact: true }),
  ).toBeVisible()
  await expect(response).toHaveCount(1)
  await expect(response).not.toContainText('Read the cache before querying the database.')
  await expect(response).not.toContainText('Read the backing store and populate the cache.')
  expect(state.questionPosts).toHaveLength(1)
  await page
    .getByRole('button', { name: `Read response to ${oldAnswer.prompt}`, exact: true })
    .click()
  await expect(response).toHaveCount(1)
  await expect(response.getByRole('heading')).toHaveText(oldAnswer.prompt)
  await expect(response).toContainText('Read the cache before querying the database.')
  await page
    .getByRole('button', { name: 'Read response to Explain cache eviction.', exact: true })
    .click()
  await expect(response).toHaveCount(1)
  await expect(response.getByRole('heading')).toHaveText('Explain cache eviction.')
  await expect(response).toContainText('A newly requested explanation.')
})

test('history opens the exact saved note or answer and labels earlier resumable sessions', async ({
  page,
}) => {
  await mockLearning(page)
  await page.goto('/?screen=history&path=design-path')
  await page.getByRole('button', { name: /^Saved cache summary/ }).click()
  await expect(page).toHaveURL(/screen=notebook.*note=cache-note/)
  await expect(
    page.getByRole('heading', { name: 'Saved cache summary', exact: true }),
  ).toBeVisible()
  await expect(page.locator('article')).toContainText('The exact note selected from history.')
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: 'History', exact: true })
    .click()
  await page
    .getByRole('button', { name: new RegExp(`^${oldAnswer.prompt.replace('?', '\\?')}`) })
    .click()
  await expect(page).toHaveURL(/screen=node.*interaction=old-answer/)
  await expect(page.getByRole('heading', { name: oldAnswer.prompt, exact: true })).toBeVisible()
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: 'History', exact: true })
    .click()
  await expect(
    page.getByText('System Design › Cache-aside › Cache consistency', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/^Ended /)).toBeVisible()
  await page.getByRole('button', { name: /^Resume session from / }).click()
  await expect(page).toHaveURL(/screen=node.*node=cache.*thread=cache-consistency/)
  await expect(page.getByRole('heading', { name: 'Cache consistency', exact: true })).toBeVisible()
})

test('history pages through activity older than the first screen', async ({ page }) => {
  await mockLearning(page)
  const activities = Array.from({ length: 25 }, (_, index) => ({
    id: `activity-${index + 1}`,
    kind: 'interaction',
    label: `Activity ${index + 1}`,
    path_id: path.id,
    node_id: 'cache',
    created_at: created,
  }))
  const offsets: number[] = []
  await page.route('**/api/history?*', (route) => {
    const url = new URL(route.request().url())
    const offset = Number(url.searchParams.get('offset'))
    const limit = Number(url.searchParams.get('limit'))
    offsets.push(offset)
    return route.fulfill({ json: activities.slice(offset, offset + limit) })
  })
  await page.goto('/?screen=history')
  const main = page.getByRole('main')
  const pages = main.getByRole('navigation', { name: 'History pages' })
  await expect(main.getByRole('button', { name: /^Activity / })).toHaveCount(12)
  await expect(main.getByRole('button', { name: /^Activity 1\b/ })).toBeVisible()
  await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled()

  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(pages).toContainText('Page 2')
  await expect(main.getByRole('button', { name: /^Activity 13\b/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /^Activity / })).toHaveCount(12)

  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(pages).toContainText('Page 3')
  await expect(main.getByRole('button', { name: /^Activity 25\b/ })).toBeVisible()
  await expect(main.getByRole('button', { name: /^Activity / })).toHaveCount(1)
  await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled()
  expect(offsets).toEqual([0, 12, 24])
})

test('finishing the last topic returns to earlier unfinished topics', async ({ page }) => {
  const state = await mockLearning(page)
  state.detail.node.status = 'completed'
  state.detail.path.completed_count = 1
  state.detail.path.progress = 50
  await page.goto('/?screen=node&path=design-path&node=cache')
  const remaining = page.getByRole('button', { name: 'Return to remaining topics', exact: true })
  await expect(remaining).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toHaveCount(0)
  await remaining.click()
  await expect(page).toHaveURL(/screen=graph&path=design-path/)
  await expect(page.getByRole('heading', { name: 'System Design', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Request fundamentals', exact: true }),
  ).toBeVisible()
})
