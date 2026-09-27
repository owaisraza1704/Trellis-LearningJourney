import { expect, test, type Page } from '@playwright/test'
import type { Source } from '../src/lib/api'

const created = '2026-09-25T10:00:00Z'
const journeys = [
  {
    id: 'databases',
    title: 'Database fundamentals',
    description: 'Understand relational data.',
    progress: 0,
    node_count: 1,
    completed_count: 0,
    updated_at: created,
  },
  {
    id: 'networks',
    title: 'Computer networks',
    description: 'Connections and packets.',
    progress: 0,
    node_count: 1,
    completed_count: 0,
    updated_at: created,
  },
]

async function mockSources(page: Page) {
  const sources: Source[] = Array.from({ length: 14 }, (_, index) => ({
    id: `source-${index + 1}`,
    path_id: index === 0 ? 'networks' : index === 1 ? null : 'databases',
    title: `Reference ${index + 1}`,
    kind: index === 0 ? 'web' : 'url',
    url: `https://example.org/reference-${index + 1}`,
    status: 'ready',
    chunk_count: 2,
    created_at: created,
  }))
  const filters: Array<string | null> = []
  const submissions: Array<Record<string, unknown>> = []
  const locationWrites: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/workspace')
      return route.fulfill({
        json: {
          paths: journeys,
          location: { path_id: 'databases', node_id: 'transactions', thread_id: null },
          location_detail: {
            path_title: 'Database fundamentals',
            node_title: 'Transactions',
            thread_title: null,
          },
          stats: { paths: 2, nodes: 2, completed: 0, notebook_items: 0 },
        },
      })
    if (url.pathname === '/api/location') {
      locationWrites.push(request.postDataJSON())
      return route.fulfill({ json: request.postDataJSON() })
    }
    const journey = journeys.find((item) => url.pathname === `/api/paths/${item.id}`)
    if (journey) return route.fulfill({ json: { ...journey, input: journey.title, nodes: [] } })
    if (url.pathname === '/api/sources') {
      const filter = url.searchParams.get('path_id')
      filters.push(filter)
      return route.fulfill({
        json: filter ? sources.filter((source) => source.path_id === filter) : sources,
      })
    }
    if (url.pathname === '/api/sources/text') {
      const body = request.postDataJSON()
      submissions.push(body)
      const source: Source = {
        id: `added-${submissions.length}`,
        path_id: body.path_id,
        title: body.title,
        kind: 'text',
        status: 'ready',
        chunk_count: 1,
        created_at: created,
      }
      sources.unshift(source)
      return route.fulfill({ status: 202, json: source })
    }
    const source = sources.find((item) => url.pathname === `/api/sources/${item.id}`)
    if (source)
      return route.fulfill({
        json: {
          ...source,
          excerpts: [{ content: 'A retained source passage.', location: 'Page 1' }],
        },
      })
    return route.fulfill({
      status: 404,
      json: { detail: `Unexpected ${request.method()} ${url.pathname}` },
    })
  })
  return { filters, submissions, locationWrites }
}

test('Source Library remains global and supports search, paging and explicit source associations', async ({
  page,
}) => {
  const state = await mockSources(page)
  await page.goto('/?screen=sources')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Source Library', exact: true })).toBeVisible()
  await expect(main.getByText('Your saved documents and links across all journeys.')).toBeVisible()
  await expect(main.getByText('Current journey', { exact: true })).toHaveCount(0)
  await expect(main.locator('article')).toHaveCount(12)
  const firstSource = main.locator('article').filter({ hasText: 'Reference 1' }).first()
  await expect(firstSource.getByText('Found by Trellis', { exact: true })).toBeVisible()
  await expect(firstSource.getByText('Attached to: Computer networks')).toBeVisible()
  const secondSource = main
    .locator('article')
    .filter({ has: page.getByRole('button', { name: 'Reference 2', exact: true }) })
  await expect(secondSource.getByText('Added by you', { exact: true })).toBeVisible()
  await expect(secondSource.getByText('Not attached to a journey')).toBeVisible()
  await main
    .getByRole('navigation', { name: 'Source pages' })
    .getByRole('button', { name: 'Next', exact: true })
    .click()
  await expect(main.locator('article')).toHaveCount(2)
  await expect(main.getByRole('button', { name: 'Reference 14', exact: true })).toBeVisible()
  await main.getByRole('searchbox', { name: 'Search sources' }).fill('computer networks')
  await expect(main.locator('article')).toHaveCount(1)
  await expect(main.getByRole('navigation', { name: 'Source pages' })).toHaveCount(0)
  await main.getByRole('button', { name: 'Reference 1', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'Reference 1', exact: true })
  await expect(preview.getByText('A retained source passage.')).toBeVisible()
  await preview.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await main.getByRole('searchbox', { name: 'Search sources' }).fill('missing source')
  await expect(main.getByText('No sources match your search')).toBeVisible()
  expect(state.filters.every((filter) => filter === null)).toBe(true)
  expect(state.locationWrites).toEqual([])
})

test('Source Library groups sources by journey and keeps unallocated sources separate', async ({
  page,
}) => {
  const state = await mockSources(page)
  await page.goto('/?screen=sources')
  const main = page.getByRole('main')
  const groups = main.getByRole('navigation', { name: 'Source groups' })
  await expect(groups.getByRole('button', { name: 'All sources' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(groups.getByRole('button', { name: 'Computer networks' })).toHaveCount(0)
  const journeyCards = main.getByRole('region', { name: 'Journey source groups' })
  await expect(journeyCards.getByRole('button', { name: 'Computer networks' })).toContainText(
    '1 source',
  )

  await groups.getByRole('button', { name: 'Unallocated' }).click()
  await expect(main.locator('article')).toHaveCount(1)
  await expect(main.getByRole('button', { name: 'Reference 2', exact: true })).toBeVisible()
  await expect(main.getByRole('navigation', { name: 'Source pages' })).toHaveCount(0)

  await journeyCards.getByRole('button', { name: 'Computer networks' }).click()
  await expect(journeyCards.getByRole('button', { name: 'Computer networks' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(main.locator('article')).toHaveCount(1)
  await expect(main.getByRole('button', { name: 'Reference 1', exact: true })).toBeVisible()
  await main.getByRole('button', { name: 'Add source to this journey' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add source to this journey' })
  await expect(dialog).toContainText('This source will be attached to Computer networks.')
  await dialog.getByRole('button', { name: 'Paste text' }).click()
  await dialog.getByLabel('Source title').fill('Network notes')
  await dialog.getByLabel('Source text').fill('A network source for this journey.')
  await dialog.getByRole('button', { name: 'Add source to this journey' }).click()
  await expect(main.getByRole('button', { name: 'Network notes', exact: true })).toBeVisible()
  expect(state.submissions.at(-1)?.path_id).toBe('networks')

  await main.getByRole('searchbox', { name: 'Search sources' }).fill('Reference 2')
  await expect(main.getByText('No sources match your search')).toBeVisible()
  await groups.getByRole('button', { name: 'Unallocated' }).click()
  await expect(main.getByRole('button', { name: 'Reference 2', exact: true })).toBeVisible()
  expect(state.filters.every((filter) => filter === null)).toBe(true)
})

test('source creation uses the named journey or the global library without moving the study location', async ({
  page,
}) => {
  const state = await mockSources(page)
  await page.goto('/?screen=sources&path=networks')
  const main = page.getByRole('main')
  await expect(
    main.getByRole('heading', { name: 'Sources for Computer networks', exact: true }),
  ).toBeVisible()
  await expect(main.locator('article')).toHaveCount(1)
  await expect(main.getByText('Documents and links attached to this journey.')).toBeVisible()
  expect(state.filters.at(-1)).toBe('networks')
  await main.getByRole('button', { name: 'Add source to this journey', exact: true }).click()
  const journeyDialog = page.getByRole('dialog', {
    name: 'Add source to this journey',
    exact: true,
  })
  await expect(
    journeyDialog.getByText('This source will be attached to Computer networks.'),
  ).toBeVisible()
  await journeyDialog.getByRole('button', { name: 'Paste text', exact: true }).click()
  await journeyDialog.getByLabel('Source title').fill('Network field notes')
  await journeyDialog.getByLabel('Source text').fill('Packets cross networks through routers.')
  await journeyDialog
    .getByRole('button', { name: 'Add source to this journey', exact: true })
    .click()
  await expect(journeyDialog).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Network field notes', exact: true })).toBeVisible()
  expect(state.submissions[0]).toEqual({
    title: 'Network field notes',
    content: 'Packets cross networks through routers.',
    path_id: 'networks',
  })

  await page.getByRole('button', { name: 'Source Library', exact: true }).click()
  await expect(page).toHaveURL(/\?screen=sources$/)
  await expect(main.getByRole('heading', { name: 'Source Library', exact: true })).toBeVisible()
  await main.getByRole('button', { name: 'Add to library', exact: true }).click()
  const libraryDialog = page.getByRole('dialog', { name: 'Add to library', exact: true })
  await expect(
    libraryDialog.getByText(
      'This source will be saved in your library. Choose it when creating a journey.',
    ),
  ).toBeVisible()
  await libraryDialog.getByRole('button', { name: 'Paste text', exact: true }).click()
  await libraryDialog.getByLabel('Source title').fill('Unassigned reading notes')
  await libraryDialog.getByLabel('Source text').fill('Material for a future journey.')
  await libraryDialog.getByRole('button', { name: 'Add to library', exact: true }).click()
  await expect(libraryDialog).toHaveCount(0)
  expect(state.submissions[1]).toEqual({
    title: 'Unassigned reading notes',
    content: 'Material for a future journey.',
    path_id: null,
  })
  expect(state.filters.at(-1)).toBeNull()
  expect(state.locationWrites).toEqual([])
})
