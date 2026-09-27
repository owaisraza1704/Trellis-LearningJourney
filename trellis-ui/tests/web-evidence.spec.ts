import { expect, test, type Page } from '@playwright/test'
import type { Interaction, NodeDetail, Source } from '../src/lib/api'

const createdAt = '2026-09-25T10:00:00Z'
const journey = {
  id: 'design-journey',
  title: 'System Design',
  description: 'Learn practical patterns.',
  progress: 0,
  node_count: 1,
  completed_count: 0,
  updated_at: createdAt,
}
const node: NodeDetail['node'] = {
  id: 'cache-node',
  path_id: journey.id,
  parent_id: null,
  title: 'Cache-aside',
  description: 'Learn how caching works.',
  position: 0,
  status: 'in_progress',
}
const suppliedSource: Source = {
  id: 'supplied-cache',
  path_id: journey.id,
  title: 'Cache-aside documentation',
  kind: 'url',
  url: 'https://example.org/cache-aside',
  status: 'ready',
  chunk_count: 1,
  created_at: createdAt,
}
const discoveredSource: Source = {
  ...suppliedSource,
  id: 'discovered-write-through',
  title: 'Write-through documentation',
  kind: 'web',
  url: 'https://example.org/write-through',
}
const original: Interaction = {
  id: 'original-answer',
  path_id: journey.id,
  node_id: node.id,
  thread_id: null,
  prompt: 'Explain cache-aside',
  action: 'question',
  status: 'answered',
  content: 'Cache-aside loads data on demand. [1]',
  evidence: [
    {
      id: 'cache-passage',
      source_id: suppliedSource.id,
      kind: suppliedSource.kind,
      title: suppliedSource.title,
      excerpt: 'The application loads data into the cache on demand.',
    },
  ],
  evaluation: { status: 'passed', web_search_performed: false },
  provider: 'fixture',
  model: 'fixture',
  created_at: createdAt,
}
const supplemented: Interaction = {
  ...original,
  id: 'web-answer',
  prompt: 'Compare cache-aside with write-through',
  content: 'Cache-aside loads on demand. Write-through updates the cache during writes. [1] [2]',
  evidence: [
    ...original.evidence,
    {
      id: 'write-through-passage',
      source_id: discoveredSource.id,
      title: discoveredSource.title,
      kind: 'web',
      excerpt: 'Write-through updates the cache when data is written.',
    },
  ],
  evaluation: { status: 'passed', web_search_performed: true, retrieval_warnings: [] },
}

async function mockJourney(page: Page, interactions: Interaction[]) {
  const state = {
    interactions: structuredClone(interactions),
    sources: [suppliedSource],
    sourceScopes: [] as Array<string | null>,
    questions: [] as Array<{ prompt: string; action: string }>,
    waitForAnswer: Promise.resolve(),
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/workspace')
      return route.fulfill({
        json: {
          paths: [journey],
          location: { path_id: journey.id, node_id: node.id, thread_id: null },
          stats: { paths: 1, nodes: 1, completed: 0, notebook_items: 0 },
        },
      })
    if (url.pathname === '/api/location')
      return route.fulfill({ json: route.request().postDataJSON() })
    if (url.pathname === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { path: journey, node, nodes: [node], threads: [], interactions: state.interactions },
      })
    if (url.pathname === `/api/nodes/${node.id}/interactions`) {
      state.questions.push(route.request().postDataJSON())
      await state.waitForAnswer
      state.interactions.push(supplemented)
      state.sources.push(discoveredSource)
      return route.fulfill({ json: supplemented })
    }
    if (url.pathname === '/api/sources') {
      state.sourceScopes.push(url.searchParams.get('path_id'))
      return route.fulfill({ json: state.sources })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url.pathname}` } })
  })
  return state
}

test('a question can grow journey sources while retaining one selected lesson and answer history', async ({
  page,
}) => {
  const state = await mockJourney(page, [original])
  let finishAnswer!: () => void
  state.waitForAnswer = new Promise<void>((resolve) => {
    finishAnswer = resolve
  })
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await page
    .getByRole('navigation', { name: 'Journey sections' })
    .getByRole('button', { name: 'Sources', exact: true })
    .click()
  await expect(page.getByRole('button', { name: suppliedSource.title, exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: original.prompt, exact: true })).toBeVisible()
  await page.getByLabel('Ask about this topic', { exact: true }).fill(supplemented.prompt)
  await page.getByRole('button', { name: 'Ask Trellis', exact: true }).click()
  await expect(
    page
      .getByTestId('study-tools')
      .getByRole('status')
      .filter({ hasText: 'Understanding your question…' }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Lesson', exact: true }).locator('article'),
  ).toHaveCount(1)
  await expect(page.getByRole('heading', { name: original.prompt, exact: true })).toBeVisible()
  finishAnswer()
  await expect(page.getByRole('heading', { name: supplemented.prompt, exact: true })).toBeVisible()
  const lesson = page.getByRole('region', { name: 'Lesson', exact: true })
  await expect(lesson.locator('article')).toHaveCount(1)
  await expect(lesson).toContainText('Cited web sources are saved with this journey for reuse.')
  await expect(lesson).not.toContainText('Some sources need attention')
  await expect(
    page.getByRole('button', { name: `Read response to ${original.prompt}`, exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: `Read response to ${supplemented.prompt}`, exact: true }),
  ).toBeVisible()
  expect(state.questions).toEqual([{ prompt: supplemented.prompt, action: 'question' }])
  await page.getByRole('button', { name: 'View journey sources', exact: true }).click()
  await expect(page).toHaveURL(`/?screen=sources&path=${journey.id}`)
  await expect(
    page.getByRole('button', { name: discoveredSource.title, exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Discovered on the web/)).toBeVisible()
  expect(state.sourceScopes.length).toBeGreaterThanOrEqual(2)
  expect(state.sourceScopes.every((scope) => scope === journey.id)).toBe(true)
})

test('reused web evidence is distinguished from a fresh web search and historical success warnings', async ({
  page,
}) => {
  const state = await mockJourney(page, [
    {
      ...supplemented,
      evaluation: {
        status: 'passed',
        web_search_performed: false,
        retrieval_warnings: [
          'This response also uses web sources because the supplied material was unavailable or insufficient.',
          'No usable supplied passages matched this question; available web sources may be used.',
        ],
      },
    },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByText('Using saved web evidence', { exact: true })).toBeVisible()
  await expect(page.getByText('Web research', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Some sources need attention', { exact: true })).toHaveCount(0)
  await page
    .getByRole('button', { name: `Read response to ${supplemented.prompt}`, exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: 'Lesson', exact: true }).locator('article'),
  ).toHaveCount(1)
  expect(state.questions).toEqual([])
})

test('a web search that cannot support an answer stays withheld and labels passages as consulted', async ({
  page,
}) => {
  await mockJourney(page, [
    {
      ...supplemented,
      status: 'abstained',
      content: 'A draft that must not be displayed.',
      evaluation: {
        status: 'low_grounding',
        web_search_performed: true,
        retrieval_warnings: ['One web page could not be read.'],
      },
    },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(
    page.getByText('Trellis looked for additional web evidence, but could not verify an answer.'),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Lesson', exact: true })).not.toContainText(
    'A draft that must not be displayed.',
  )
  await expect(
    page.getByRole('button', { name: '2 consulted passages', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('One web page could not be read.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save to Notebook', exact: true })).toHaveCount(0)
  await expect(page.getByText(/Cited web sources are saved/)).toHaveCount(0)
})

test('a completed search does not claim web evidence was used when only supplied passages are cited', async ({
  page,
}) => {
  await mockJourney(page, [
    { ...original, evaluation: { status: 'passed', web_search_performed: true } },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(
    page.getByText(
      'Trellis looked for additional web evidence. This answer uses your existing materials.',
    ),
  ).toBeVisible()
  await expect(page.getByText(/Cited web sources are saved/)).toHaveCount(0)
})

test('an unavailable search is shown as attempted research without claiming it completed', async ({
  page,
}) => {
  await mockJourney(page, [
    {
      ...original,
      status: 'abstained',
      evidence: [],
      evaluation: {
        status: 'evidence_unavailable',
        web_search_performed: true,
        retrieval_warnings: ['Web search unavailable. Please try again later.'],
      },
    },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByText('Web research', { exact: true })).toBeVisible()
  await expect(page.getByText('Web search completed', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('Trellis looked for additional web evidence, but could not verify an answer.'),
  ).toBeVisible()
  await expect(
    page.getByText('Web search unavailable. Please try again later.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '0 consulted passages', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Cited web sources are saved/)).toHaveCount(0)
})
