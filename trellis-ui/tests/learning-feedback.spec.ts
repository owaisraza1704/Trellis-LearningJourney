import { test, expect, type Page } from '@playwright/test'
import type { Interaction, NotebookPage, StudySet } from '../src/lib/api'

const path = {
  id: 'physics-path',
  title: 'Physics foundations',
  description: 'Learn mechanics.',
  progress: 0,
  node_count: 1,
  completed_count: 0,
  updated_at: '2026-09-25T10:00:00Z',
}
const node = {
  id: 'motion-node',
  path_id: path.id,
  parent_id: null,
  title: 'Motion',
  description: 'Position and velocity.',
  position: 0,
  status: 'in_progress',
}
const workspace = {
  paths: [path],
  location: { path_id: path.id, node_id: node.id, thread_id: null },
  stats: { paths: 1, nodes: 1, completed: 0, notebook_items: 0 },
}
const evidenceId = '123e4567-e89b-12d3-a456-426614174000'
const answer: Interaction = {
  id: 'answer-1',
  path_id: path.id,
  node_id: node.id,
  thread_id: null,
  prompt: 'Explain motion',
  action: 'foundation',
  status: 'answered',
  content: '**Velocity** describes the rate of change of position. Use `v` for velocity. [1]',
  evidence: [
    {
      id: evidenceId,
      title: 'Mechanics handbook',
      excerpt: 'Velocity is the rate of change of position.',
    },
  ],
  evaluation: { status: 'passed', grounding: 1 },
  provider: 'fixture',
  model: 'fixture',
  created_at: '2026-09-25T10:00:00Z',
}

async function openNotebook(page: Page, title: string) {
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: 'Notebooks', exact: true })
    .click()
  await page.getByLabel('Search notebooks by journey').fill(title)
  await page
    .getByRole('article', { name: title, exact: true })
    .getByRole('button', { name: 'Open notebook', exact: true })
    .click()
}

// These fixtures exercise UI state and API boundaries without generating answers or changing local data.
test('legacy abstentions have safe feedback, numbered assessment references and a working retry', async ({
  page,
}) => {
  const legacy: Interaction = {
    ...answer,
    status: 'abstained',
    content: `I could not produce a sufficiently supported answer. PRIVATE EVALUATOR DUMP: ${evidenceId}`,
    evaluation: {
      status: 'low_grounding',
      grounding: 0.48,
      relevance: 0.98,
      explanation: `Passage ${evidenceId} does not establish this claim. ${'Detailed diagnostic material. '.repeat(30)}`,
      correction_attempted: true,
      retrieval_warnings: ['Preferred source Mechanics appendix is still processing.'],
    },
  }
  const interactions = [legacy]
  let retry: unknown
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: workspace.location })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({ json: { node, path, nodes: [node], interactions, threads: [] } })
    if (url === `/api/nodes/${node.id}/interactions`) {
      retry = route.request().postDataJSON()
      const accepted = { ...answer, id: 'accepted-retry' }
      interactions.push(accepted)
      return route.fulfill({ json: accepted })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await expect(page.getByRole('heading', { name: answer.prompt })).toBeVisible()
  await expect(page.locator('article').first()).toContainText(
    'The draft did not pass the source checks',
  )
  await expect(page.locator('body')).not.toContainText('PRIVATE EVALUATOR DUMP')
  await expect(page.locator('body')).not.toContainText(evidenceId)
  await expect(page.getByRole('button', { name: 'Save to Notebook' })).toHaveCount(0)
  await expect(
    page.getByText('Preferred source Mechanics appendix is still processing.'),
  ).toBeVisible()
  await page.getByText('Grounding assessment', { exact: true }).click()
  await expect(page.getByText('Support from sources', { exact: true })).toBeVisible()
  await expect(page.getByText('48%', { exact: true })).toBeVisible()
  await expect(page.getByText('98%', { exact: true })).toBeVisible()
  await expect(page.locator('details')).toContainText('Passage [1] does not establish this claim.')
  await expect(page.locator('details')).not.toContainText('low_grounding')
  await page.screenshot({
    path: test.info().outputPath('withheld-answer.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: '1 consulted passage', exact: true }).click()
  await expect(
    page.getByText('Passages consulted for this question.', { exact: false }),
  ).toBeVisible()
  await expect(page.getByText('[1] Mechanics handbook', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'AI', exact: true }).click()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.locator('article').first().locator('strong')).toHaveText('Velocity')
  expect(retry).toEqual({ prompt: answer.prompt, action: answer.action })
  await expect(page.getByRole('button', { name: 'Save to Notebook', exact: true })).toBeVisible()
  const preview = page
    .getByRole('button', { name: `Read response to ${answer.prompt}`, exact: true })
    .last()
  await expect(preview.locator('strong')).toHaveText('Velocity')
  await expect(preview.locator('code')).toHaveText('v')
  await expect(preview).not.toContainText('**Velocity**')
  await page.screenshot({
    path: test.info().outputPath('formatted-answer.png'),
    animations: 'disabled',
  })
  expect(pageErrors).toEqual([])
})

test('saving requires an intentional section and keeps a created destination after a failed save', async ({
  page,
}) => {
  const pages: NotebookPage[] = [
    { id: 'python-section', path_id: 'python-path', title: 'Python notes', position: 0, items: [] },
    { id: 'mechanics-section', path_id: path.id, title: 'Mechanics notes', position: 0, items: [] },
  ]
  const writes: Array<Record<string, string>> = []
  let sectionCreates = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: workspace.location })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { node, path, nodes: [node], interactions: [answer], threads: [] },
      })
    if (url === '/api/notebook/pages' && method === 'GET') {
      const requestedPath = new URL(route.request().url()).searchParams.get('path_id')
      expect(requestedPath).toBe(path.id)
      return route.fulfill({ json: pages.filter((section) => section.path_id === requestedPath) })
    }
    if (url === '/api/notebook/pages' && method === 'POST') {
      sectionCreates++
      const section = {
        id: 'physics-section',
        path_id: route.request().postDataJSON().path_id,
        title: route.request().postDataJSON().title,
        position: 1,
        items: [],
      }
      pages.push(section)
      return route.fulfill({ json: section })
    }
    if (url === '/api/notebook/items') {
      writes.push(route.request().postDataJSON())
      if (writes.length === 1)
        return route.fulfill({
          status: 503,
          json: { detail: 'Could not save this note. Please try again.' },
        })
      return route.fulfill({ json: { id: 'saved-item', ...writes.at(-1) } })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await page.getByRole('button', { name: 'Save to Notebook', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const save = dialog.getByRole('button', { name: 'Save to Notebook', exact: true })
  await expect(dialog).toContainText('Learning context: Physics foundations › Motion')
  await expect(dialog).toContainText('Physics foundations notebook')
  await expect(dialog.getByRole('option', { name: 'Python notes', exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('Notebook section', { exact: true })).toHaveValue('')
  await expect(save).toBeDisabled()
  await dialog.getByLabel('Notebook section', { exact: true }).selectOption('mechanics-section')
  await expect(save).toBeEnabled()
  await dialog.getByRole('button', { name: 'Create section', exact: true }).click()
  await expect(save).toBeDisabled()
  await dialog.getByLabel('New section title').fill('Physics notes')
  await dialog.getByLabel('Note title').fill('Velocity explained')
  await expect(dialog).toContainText('PDF pages are created automatically')
  const bounds = await dialog.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1024)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(768)
  await page.screenshot({
    path: test.info().outputPath('save-to-section.png'),
    animations: 'disabled',
  })
  await save.click()
  await expect(dialog.getByRole('alert')).toContainText('Could not save this note')
  await expect(dialog.getByLabel('Note title')).toHaveValue('Velocity explained')
  await expect(dialog.getByLabel('Notebook section', { exact: true })).toHaveValue(
    'physics-section',
  )
  await save.click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('Saved to Notebook', { exact: true })).toBeVisible()
  expect(sectionCreates).toBe(1)
  expect(pages.find((section) => section.id === 'physics-section')?.path_id).toBe(path.id)
  expect(writes).toHaveLength(2)
  expect(writes.every((write) => write.page_id === 'physics-section')).toBe(true)
  expect(writes[1]).toMatchObject({
    interaction_id: answer.id,
    node_id: node.id,
    title: 'Velocity explained',
  })
})

test('notebook sections support personal notes, edit, reorder, move and safe deletion', async ({
  page,
}) => {
  const pages: NotebookPage[] = [
    { id: 'working-section', path_id: path.id, title: 'Working notes', position: 0, items: [] },
  ]
  const writes: Array<{ method: string; url: string; body?: Record<string, unknown> }> = []
  let nextItem = 1
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    const method = route.request().method()
    const body = route.request().postData() ? route.request().postDataJSON() : undefined
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (method !== 'GET') writes.push({ method, url, body })
    if (url === '/api/notebook/pages' && method === 'GET') return route.fulfill({ json: pages })
    if (url === '/api/notebook/pages' && method === 'POST') {
      const section = {
        id: 'physics-section',
        path_id: body.path_id,
        title: body.title,
        position: pages.length,
        items: [],
      }
      pages.push(section)
      return route.fulfill({ json: section })
    }
    if (url === '/api/notebook/items' && method === 'POST') {
      const section = pages.find((entry) => entry.id === body.page_id)!
      const item = {
        id: `note-${nextItem++}`,
        ...body,
        position: section.items.length,
        created_at: answer.created_at,
      }
      section.items.push(item)
      return route.fulfill({ json: item })
    }
    if (url.startsWith('/api/notebook/items/')) {
      const id = url.split('/').at(-1)
      const section = pages.find((entry) => entry.items.some((item) => item.id === id))!
      const item = section.items.find((entry) => entry.id === id)!
      if (method === 'DELETE') section.items = section.items.filter((entry) => entry.id !== id)
      else {
        if (body.page_id && body.page_id !== section.id) {
          section.items = section.items.filter((entry) => entry.id !== id)
          pages.find((entry) => entry.id === body.page_id)!.items.push(item)
        }
        Object.assign(item, body)
      }
      return route.fulfill(method === 'DELETE' ? { status: 204 } : { json: item })
    }
    if (url.endsWith('/reorder')) {
      const section = pages.find((entry) => url.includes(entry.id))!
      section.items = body.item_ids.map((id: string) =>
        section.items.find((item) => item.id === id)!,
      )
      return route.fulfill({ json: section })
    }
    if (url.startsWith('/api/notebook/pages/')) {
      const index = pages.findIndex((entry) => entry.id === url.split('/').at(-1))
      if (method === 'DELETE') {
        expect(pages[index].items).toHaveLength(0)
        pages.splice(index, 1)
        return route.fulfill({ status: 204 })
      }
      Object.assign(pages[index], body)
      if (typeof body.position === 'number') {
        const [section] = pages.splice(index, 1)
        pages.splice(body.position, 0, section)
        pages.forEach((entry, position) => {
          entry.position = position
        })
      }
      return route.fulfill({ json: pages[index] })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto('/?screen=notebook')
  await page
    .getByRole('article', { name: path.title, exact: true })
    .getByRole('button', { name: 'Open notebook', exact: true })
    .click()
  await page.getByRole('button', { name: 'New section', exact: true }).click()
  await page.getByLabel('Section title', { exact: true }).fill('Physics notes')
  await page.getByRole('button', { name: 'Save section', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('Notebook section', { exact: true })).toHaveValue(
    'physics-section',
  )
  await dialog.getByLabel('Note title').fill('First idea')
  await dialog.getByLabel('Your note').fill('   ')
  await expect(dialog.getByRole('button', { name: 'Save to Notebook' })).toBeDisabled()
  await dialog.getByLabel('Your note').fill('**Velocity** is a rate.')
  await dialog.getByRole('button', { name: 'Save to Notebook' }).click()
  await expect(page.getByRole('heading', { name: 'First idea', exact: true })).toBeVisible()
  await expect(page.getByText('Note saved to Notebook', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByLabel('Your note').fill('Position is measured from an origin.')
  await expect(dialog.getByRole('button', { name: 'Save to Notebook' })).toBeDisabled()
  await dialog.getByLabel('Note title').fill('Second idea')
  await dialog.getByRole('button', { name: 'Save to Notebook' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: /Second idea Position is measured/ }).click()
  await page.getByRole('button', { name: 'Move note up', exact: true }).click()
  await expect.poll(() => pages[1].items[0]?.title).toBe('Second idea')
  await page.getByRole('button', { name: 'Edit selected note', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('   ')
  await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeDisabled()
  await page.getByLabel('Title', { exact: true }).fill('Position clarified')
  await page
    .getByLabel('Content · Markdown supported')
    .fill('Position depends on the chosen origin.')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Position clarified', exact: true })).toBeVisible()
  await page.getByLabel('Notebook section', { exact: true }).selectOption('working-section')
  await expect.poll(() => pages[0].items[0]?.title).toBe('Position clarified')
  await page.getByRole('button', { name: 'Working notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Position clarified', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit section Working notes', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Delete empty section', exact: true }),
  ).toBeDisabled()
  await page.getByLabel('Section title', { exact: true }).fill('Reference notes')
  await page.getByRole('button', { name: 'Save section', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reference notes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit section Reference notes', exact: true }).click()
  await page.getByRole('button', { name: 'Move section later', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(pages.map((section) => section.title)).toEqual(['Physics notes', 'Reference notes'])
  page.once('dialog', (confirmation) => confirmation.accept())
  await page.getByRole('button', { name: 'Delete selected note', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Position clarified', exact: true })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: 'Edit section Reference notes', exact: true }).click()
  await page.getByRole('button', { name: 'Delete empty section', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reference notes', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'First idea', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'First idea', exact: true })).toBeVisible()
  expect(pages).toHaveLength(1)
  expect(pages[0].items.map((item) => item.title)).toEqual(['First idea'])
  expect(writes.some((write) => write.url.endsWith('/reorder') && write.body?.item_ids)).toBe(true)
})

test('a pending PDF keeps its selection fixed and later edits do not change the previous export', async ({
  page,
}) => {
  const items = ['First note', 'Second note'].map((title, index) => ({
    id: `note-${index + 1}`,
    page_id: 'section-1',
    title,
    content: `${title} content`,
    position: index,
    created_at: answer.created_at,
  }))
  const selection: StudySet = {
    id: 'study-1',
    path_id: path.id,
    title: 'Mechanics revision',
    item_ids: ['note-1'],
    created_at: answer.created_at,
  }
  let finishExport: (() => void) | undefined
  const exports: object[] = []
  let exportedIds: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/notebook/pages')
      return route.fulfill({
        json: [{ id: 'section-1', title: 'Physics notes', position: 0, items }],
      })
    if (url === '/api/study-sessions') return route.fulfill({ json: [selection] })
    if (url === '/api/study-sessions/study-1') {
      Object.assign(selection, route.request().postDataJSON())
      return route.fulfill({ json: selection })
    }
    if (url === '/api/exports' && method === 'POST') {
      exportedIds = [...route.request().postDataJSON().item_ids]
      await new Promise<void>((resolve) => {
        finishExport = resolve
      })
      const result = {
        id: 'pdf-1',
        title: selection.title,
        status: 'completed',
        item_ids: exportedIds,
        item_count: exportedIds.length,
        download_url: '/api/exports/pdf-1/download',
        created_at: answer.created_at,
      }
      exports.push(result)
      return route.fulfill({ json: result })
    }
    if (url === '/api/exports') return route.fulfill({ json: exports })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto(`/?screen=session&path=${path.id}`)
  await page.getByRole('checkbox', { name: /Second note/ }).click()
  await expect(page.getByRole('checkbox', { name: /Second note/ })).toBeChecked()
  await page.getByRole('button', { name: 'Move Second note earlier', exact: true }).click()
  await expect.poll(() => selection.item_ids).toEqual(['note-2', 'note-1'])
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  await expect.poll(() => !!finishExport).toBe(true)
  await expect(page.getByRole('checkbox', { name: /Second note/ })).toBeDisabled()
  await expect(page.getByLabel('Study selection', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Move First note earlier', exact: true }),
  ).toBeDisabled()
  finishExport!()
  await expect(page.getByRole('link', { name: 'Download prepared PDF', exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: /First note/ }).click()
  await expect(page.getByRole('checkbox', { name: /First note/ })).not.toBeChecked()
  await expect(page.getByRole('link', { name: 'Download prepared PDF', exact: true })).toHaveCount(
    0,
  )
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
    'href',
    '/api/exports/pdf-1/download',
  )
  expect(exportedIds).toEqual(['note-2', 'note-1'])
  await page.reload()
  await expect(page.getByRole('checkbox', { name: /Second note/ })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: /First note/ })).not.toBeChecked()
})

test('journey notebooks isolate sections, drafts, study selections and exports without changing study resume', async ({
  page,
}) => {
  const python = {
    ...path,
    id: 'python-journey',
    title: 'Python essentials',
    last_studied_at: path.updated_at,
    resume: { path_id: 'python-journey', node_id: 'python-lists', thread_id: null },
  }
  const hybrid = { ...path, id: 'hybrid-journey', title: 'Hybrid RAG' }
  const pythonNode = { ...node, id: 'python-lists', path_id: python.id, title: 'Lists' }
  const savedLocation = { path_id: python.id, node_id: pythonNode.id, thread_id: null }
  const pages = [python, hybrid].map((journey) => ({
    id: `${journey.id}-section`,
    path_id: journey.id,
    title: `${journey.title} section`,
    position: 0,
    items: [
      {
        id: `${journey.id}-note`,
        page_id: `${journey.id}-section`,
        title: `${journey.title} question`,
        content: `Notes for ${journey.title}.`,
        position: 0,
        created_at: answer.created_at,
      },
    ],
  }))
  const selections = [python, hybrid].map((journey) => ({
    id: `${journey.id}-study`,
    path_id: journey.id,
    title: `${journey.title} revision`,
    item_ids: [`${journey.id}-note`],
    created_at: answer.created_at,
  }))
  const locationWrites: unknown[] = []
  const exports: Array<Record<string, unknown>> = []
  let createdSelection: Record<string, unknown> | undefined
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url())
    const url = requestUrl.pathname
    const method = route.request().method()
    const body = route.request().postData() ? route.request().postDataJSON() : undefined
    if (url === '/api/workspace')
      return route.fulfill({
        json: {
          ...workspace,
          paths: [python, hybrid],
          location: savedLocation,
          location_detail: {
            path_title: python.title,
            node_title: pythonNode.title,
            thread_title: null,
          },
        },
      })
    if (url === '/api/location') {
      locationWrites.push(body)
      return route.fulfill({ json: body })
    }
    if (url === `/api/nodes/${pythonNode.id}`)
      return route.fulfill({
        json: {
          path: python,
          node: pythonNode,
          nodes: [pythonNode],
          interactions: [],
          threads: [],
        },
      })
    if (url === '/api/notebook/pages') {
      const pathId = requestUrl.searchParams.get('path_id')
      expect(pathId).toBeTruthy()
      return route.fulfill({ json: pages.filter((section) => section.path_id === pathId) })
    }
    if (url === '/api/study-sessions' && method === 'GET') {
      const pathId = requestUrl.searchParams.get('path_id')
      expect(pathId).toBeTruthy()
      return route.fulfill({ json: selections.filter((selection) => selection.path_id === pathId) })
    }
    if (url === '/api/study-sessions' && method === 'POST') {
      createdSelection = body
      const selection = { id: 'new-hybrid-selection', ...body, created_at: answer.created_at }
      selections.push(selection)
      return route.fulfill({ json: selection })
    }
    if (url.startsWith('/api/study-sessions/')) {
      const selection = selections.find((entry) => entry.id === url.split('/').at(-1))!
      Object.assign(selection, body)
      return route.fulfill({ json: selection })
    }
    if (url === '/api/exports' && method === 'POST') {
      const result = {
        id: 'hybrid-export',
        ...body,
        status: 'completed',
        download_url: '/api/exports/hybrid-export/download',
        created_at: answer.created_at,
      }
      exports.push(result)
      return route.fulfill({ json: result })
    }
    if (url === '/api/exports') {
      const pathId = requestUrl.searchParams.get('path_id')
      expect(pathId).toBeTruthy()
      return route.fulfill({ json: exports.filter((entry) => entry.path_id === pathId) })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${method} ${url}` } })
  })
  await page.goto(`/?screen=notebook&path=${hybrid.id}`)
  await expect(
    page.getByRole('heading', { name: 'Hybrid RAG notebook', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Python essentials section', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'New note', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Hybrid RAG notebook')
  await expect(
    page
      .getByRole('dialog')
      .getByRole('option', { name: 'Python essentials section', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Edit selected note', exact: true }).click()
  await page.getByLabel('Title', { exact: true }).fill('Unsaved Hybrid draft')
  await openNotebook(page, python.title)
  await expect(
    page.getByRole('heading', { name: 'Python essentials notebook', exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Python essentials question', exact: true }),
  ).toBeVisible()
  await openNotebook(page, hybrid.title)
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Unsaved Hybrid draft')
  await expect(
    page
      .getByLabel('Notebook section', { exact: true })
      .getByRole('option', { name: 'Python essentials section', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Study & export', exact: true })).toHaveAttribute(
    'href',
    `/?screen=session&path=${hybrid.id}`,
  )
  await page.getByRole('link', { name: 'Study & export', exact: true }).click()
  await expect(page.getByLabel('Study selection', { exact: true })).toHaveValue(
    `${hybrid.id}-study`,
  )
  await expect(page.getByRole('checkbox', { name: /Python essentials question/ })).toHaveCount(0)
  await openNotebook(page, python.title)
  await page
    .getByRole('navigation', { name: 'Journey sections' })
    .getByRole('button', { name: 'Study', exact: true })
    .click()
  await expect(page.getByLabel('Study selection', { exact: true })).toHaveValue(
    `${python.id}-study`,
  )
  await expect(page.getByRole('checkbox', { name: /Hybrid RAG question/ })).toHaveCount(0)
  await openNotebook(page, hybrid.title)
  await page
    .getByRole('navigation', { name: 'Journey sections' })
    .getByRole('button', { name: 'Study', exact: true })
    .click()
  await page.getByRole('button', { name: 'New study selection', exact: true }).click()
  await page.getByLabel('Selection title').fill('Hybrid source review')
  await page.getByRole('button', { name: 'Create selection', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(createdSelection).toEqual({
    title: 'Hybrid source review',
    item_ids: [],
    path_id: hybrid.id,
  })
  await page.getByRole('checkbox', { name: /Hybrid RAG question/ }).click()
  await expect(page.getByRole('checkbox', { name: /Hybrid RAG question/ })).toBeChecked()
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Download prepared PDF', exact: true })).toBeVisible()
  expect(exports[0]).toMatchObject({
    path_id: hybrid.id,
    item_ids: [`${hybrid.id}-note`],
    study_session_id: 'new-hybrid-selection',
  })
  await openNotebook(page, python.title)
  await page
    .getByRole('navigation', { name: 'Journey sections' })
    .getByRole('button', { name: 'Study', exact: true })
    .click()
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0)
  expect(locationWrites).toEqual([])
  await page
    .locator('.workspace-sidebar')
    .getByRole('button', { name: 'Home', exact: true })
    .click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  expect(locationWrites.at(-1)).toEqual(savedLocation)
})

test('an empty workspace opens the notebook collection without requesting a global notebook', async ({
  page,
}) => {
  const requests: string[] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    requests.push(url)
    return route.fulfill({
      json: {
        ...workspace,
        paths: [],
        location: { path_id: null, node_id: null, thread_id: null },
      },
    })
  })
  await page.goto('/?screen=notebook')
  await expect(page.getByRole('heading', { name: 'Notebooks', exact: true })).toBeVisible()
  await expect(
    page.getByText('Your notebooks begin with a journey.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'New note', exact: true })).toHaveCount(0)
  await page.goto('/?screen=session')
  await expect(page.getByRole('heading', { name: 'Notebooks', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Create your first journey', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export PDF', exact: true })).toHaveCount(0)
  expect(requests.every((url) => url === '/api/workspace')).toBe(true)
})

for (const scenario of [
  {
    name: 'clears an unchanged question after success',
    quickAction: false,
    nextDraft: null,
    fails: false,
  },
  {
    name: 'keeps a follow-up typed before the answer arrives',
    quickAction: false,
    nextDraft: 'What about acceleration?',
    fails: false,
  },
  {
    name: 'keeps a prepared question when a quick action finishes',
    quickAction: true,
    nextDraft: null,
    fails: false,
  },
  {
    name: 'keeps the submitted question after a failed answer',
    quickAction: false,
    nextDraft: null,
    fails: true,
  },
  {
    name: 'keeps a newer question after a failed answer',
    quickAction: false,
    nextDraft: 'What about acceleration?',
    fails: true,
  },
]) {
  test(`question composer ${scenario.name}`, async ({ page }) => {
    const interactions = [answer]
    // Matching the quick-action text also checks that it cannot consume an unsent draft.
    const submitted = scenario.quickAction
      ? 'Go deeper into the answer to: Explain motion'
      : 'How is speed different?'
    let request: { prompt: string; action: string; reply_to_interaction_id?: string } | undefined
    let release!: () => void
    const pendingResponse = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url()).pathname
      if (url === '/api/workspace') return route.fulfill({ json: workspace })
      if (url === '/api/location') return route.fulfill({ json: workspace.location })
      if (url === `/api/nodes/${node.id}`)
        return route.fulfill({ json: { node, path, nodes: [node], interactions, threads: [] } })
      if (url === `/api/nodes/${node.id}/interactions`) {
        request = route.request().postDataJSON()
        await pendingResponse
        if (scenario.fails)
          return route.fulfill({
            status: 503,
            json: { detail: 'The model is temporarily unavailable.' },
          })
        const accepted = { ...answer, id: 'delayed-answer', prompt: request!.prompt }
        interactions.push(accepted)
        return route.fulfill({ json: accepted })
      }
      return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
    })
    await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
    const composer = page.getByLabel('Ask about this topic', { exact: true })
    await composer.fill(submitted)
    await page
      .getByRole('button', {
        name: scenario.quickAction ? 'Go deeper' : 'Ask Trellis',
        exact: true,
      })
      .click()
    await expect(page.getByRole('button', { name: 'Thinking…', exact: true })).toBeDisabled()
    await expect(composer).toBeEnabled()
    await expect
      .poll(() => request)
      .toEqual({
        prompt: submitted,
        action: scenario.quickAction ? 'deeper' : 'question',
        ...(scenario.quickAction ? { reply_to_interaction_id: answer.id } : {}),
      })
    if (scenario.nextDraft) await composer.fill(scenario.nextDraft)
    release()
    if (scenario.fails)
      await expect(
        page.getByRole('alert').filter({ hasText: 'The model is temporarily unavailable.' }),
      ).toBeVisible()
    else await expect(page.getByRole('heading', { name: submitted, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Ask Trellis', exact: true })).toBeVisible()
    const expectedDraft =
      scenario.nextDraft ?? (scenario.fails || scenario.quickAction ? submitted : '')
    await expect(composer).toHaveValue(expectedDraft)
  })
}

test('new thread describes the primary topic when opened inside an existing thread', async ({
  page,
}) => {
  const thread = {
    id: 'motion-thread',
    path_id: path.id,
    node_id: node.id,
    title: 'Circular motion',
    status: 'open',
    seed_context: '',
    created_at: answer.created_at,
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace') return route.fulfill({ json: workspace })
    if (url === '/api/location') return route.fulfill({ json: workspace.location })
    if (url === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { node, path, nodes: [node], interactions: [answer], threads: [thread] },
      })
    if (url === `/api/threads/${thread.id}`)
      return route.fulfill({
        json: {
          thread,
          node,
          path,
          interactions: [{ ...answer, id: 'thread-answer', thread_id: thread.id }],
        },
      })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}`)
  await page.getByRole('button', { name: 'New exploratory thread', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('this topic and the selected response')
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.goto(`/?screen=node&path=${path.id}&node=${node.id}&thread=${thread.id}`)
  await page.getByRole('button', { name: 'New exploratory thread', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('starts from the primary topic, Motion.')
  await expect(page.getByRole('dialog')).not.toContainText('selected response')
})
