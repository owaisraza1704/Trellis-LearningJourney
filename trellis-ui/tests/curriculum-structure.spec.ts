import { test, expect, type Page } from '@playwright/test'
import type { PathDetail } from '../src/lib/api'

const systemDesign: PathDetail = {
  id: 'system-design',
  title: 'Learning System Design',
  description: 'Six connected topics for designing scalable systems.',
  input: 'Learn system design',
  progress: 0,
  node_count: 6,
  completed_count: 0,
  updated_at: '2026-09-25T10:00:00Z',
  nodes: [
    'Horizontal Scaling and Bottleneck Analysis',
    'Stateless Services and Independent Components',
    'Load Distribution and Traffic Routing',
    'Cache-Aside for Read Performance',
    'Asynchronous Work and Flow Control',
    'Reliability, Elasticity, and Trade-offs',
  ].map((title, index) => ({
    id: `topic-${index + 1}`,
    path_id: 'system-design',
    parent_id: null,
    title,
    description: '',
    position: index,
    status: 'not_started',
  })),
}

async function mockCurriculum(page: Page, initial: PathDetail, activeId: string) {
  const path = structuredClone(initial)
  const location = { path_id: path.id, node_id: activeId, thread_id: null }
  const reordered: string[][] = []
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()).pathname
    if (url === '/api/workspace')
      return route.fulfill({
        json: {
          paths: [path],
          location,
          stats: { paths: 1, nodes: path.nodes.length, completed: 0, notebook_items: 0 },
        },
      })
    if (url === '/api/location') return route.fulfill({ json: location })
    if (url === '/api/paths') return route.fulfill({ json: [path] })
    if (url === `/api/paths/${path.id}`) return route.fulfill({ json: path })
    if (url === `/api/paths/${path.id}/reorder`) {
      const ids: string[] = route.request().postDataJSON().node_ids
      reordered.push(ids)
      path.nodes = ids.map((id, position) => ({
        ...path.nodes.find((node) => node.id === id)!,
        position,
      }))
      return route.fulfill({ json: path })
    }
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url}` } })
  })
  return { path, reordered }
}

test('flat topics form a readable learning sequence without changing their hierarchy', async ({
  page,
}) => {
  const state = await mockCurriculum(page, systemDesign, 'topic-1')
  await page.goto('/?screen=graph&path=system-design')
  await expect(page.getByText('Learning sequence', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Dashed arrows follow your topic order.', { exact: false }),
  ).toContainText('They do not indicate prerequisites.')
  const graph = page.getByLabel('Curriculum graph', { exact: true })
  await expect(graph.locator('.react-flow__node')).toHaveCount(6)
  await expect(graph.locator('.react-flow__edge')).toHaveCount(5)
  await expect(graph.locator('[data-id="topic-1"]')).toContainText('Current topic')
  await expect(graph).not.toContainText('Last studied')
  for (let index = 1; index < 6; index++) {
    await expect(
      graph.getByLabel(
        `Learning sequence: ${systemDesign.nodes[index - 1].title} to ${systemDesign.nodes[index].title}`,
        { exact: true },
      ),
    ).toBeAttached()
  }

  // Six topics should fit as two readable columns instead of one shrunken row.
  await expect
    .poll(async () => {
      const box = await graph.locator('[data-id="topic-1"]').boundingBox()
      return box?.width || 0
    })
    .toBeGreaterThanOrEqual(184)
  const boxes = await graph.locator('.react-flow__node').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.x), y: Math.round(box.y), width: box.width }
    }),
  )
  expect(new Set(boxes.map((box) => box.x)).size).toBe(2)
  expect(new Set(boxes.map((box) => box.y)).size).toBe(3)
  expect(boxes.every((box) => box.width >= 184)).toBe(true)
  await page.screenshot({
    path: test.info().outputPath('system-design-sequence.png'),
    animations: 'disabled',
  })

  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(page.getByRole('main').getByRole('button', { name: /^Collapse / })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: `${systemDesign.nodes[0].title} Current topic`, exact: true }),
  ).toHaveAttribute('aria-current', 'step')
  await page
    .getByRole('button', { name: `Move ${systemDesign.nodes[0].title} down`, exact: true })
    .click()
  await expect
    .poll(() => state.reordered)
    .toEqual([['topic-2', 'topic-1', 'topic-3', 'topic-4', 'topic-5', 'topic-6']])
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(
    graph.getByLabel(
      `Learning sequence: ${systemDesign.nodes[1].title} to ${systemDesign.nodes[0].title}`,
      { exact: true },
    ),
  ).toBeAttached()
  expect(state.path.nodes.every((node) => node.parent_id === null)).toBe(true)
})

test('hierarchy graph follows curriculum order from left to right at every depth', async ({
  page,
}) => {
  const hierarchy: PathDetail = {
    ...systemDesign,
    id: 'interview-preparation',
    title: 'AI Interview Preparation',
    nodes: [
      { id: 'fundamentals', title: 'Fundamentals', parent_id: null },
      { id: 'llms', title: 'LLMs', parent_id: 'fundamentals' },
      { id: 'embeddings', title: 'Embeddings', parent_id: 'fundamentals' },
      { id: 'retrieval', title: 'Retrieval', parent_id: 'fundamentals' },
      { id: 'vector', title: 'Vector Retrieval', parent_id: 'retrieval' },
      { id: 'keyword', title: 'Keyword Retrieval', parent_id: 'retrieval' },
      { id: 'prompting', title: 'Prompting', parent_id: 'fundamentals' },
      { id: 'fine-tuning', title: 'Fine-Tuning', parent_id: 'fundamentals' },
      { id: 'system-design', title: 'System Design', parent_id: null },
      { id: 'rag', title: 'RAG Architectures', parent_id: 'system-design' },
      { id: 'agents', title: 'Agent Workflows', parent_id: 'system-design' },
    ].map((node, position) => ({
      ...node,
      path_id: 'interview-preparation',
      description: '',
      position,
      status: 'not_started',
    })),
  }
  await mockCurriculum(page, hierarchy, 'llms')
  await page.goto('/?screen=graph&path=interview-preparation')
  const graph = page.getByLabel('Curriculum graph', { exact: true })
  await expect(graph.locator('.react-flow__node')).toHaveCount(hierarchy.nodes.length)

  const positions = await graph
    .locator('.react-flow__node')
    .evaluateAll((elements) =>
      Object.fromEntries(
        elements.map((element) => [
          element.getAttribute('data-id'),
          element.getBoundingClientRect().x,
        ]),
      ),
    )
  for (const ids of [
    ['fundamentals', 'system-design'],
    ['llms', 'embeddings', 'retrieval', 'prompting', 'fine-tuning'],
    ['vector', 'keyword'],
    ['rag', 'agents'],
  ]) {
    for (let index = 1; index < ids.length; index++) {
      expect(positions[ids[index - 1]]).toBeLessThan(positions[ids[index]])
    }
  }
})

test('a Python topic hierarchy keeps parent relationships and distinguishes studied topics', async ({
  page,
}) => {
  const python: PathDetail = {
    ...systemDesign,
    id: 'python',
    title: 'Python Lists',
    node_count: 2,
    nodes: [
      { id: 'lists', title: 'Python Lists', parent_id: null },
      { id: 'append', title: 'Adding Values with append()', parent_id: 'lists' },
      { id: 'pop', title: 'Removing Values with pop()', parent_id: 'lists' },
      { id: 'stacks', title: 'Lists as Stacks', parent_id: 'pop' },
    ].map((node, position) => ({
      ...node,
      path_id: 'python',
      description: '',
      position,
      status: node.id === 'append' || node.id === 'lists' ? 'in_progress' : 'not_started',
    })),
  }
  const state = await mockCurriculum(page, python, 'append')
  await page.goto('/?screen=graph&path=python')
  await expect(page.getByText('Topic hierarchy', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Solid lines connect parent topics to their subtopics.', { exact: false }),
  ).toBeVisible()
  const graph = page.getByLabel('Curriculum graph', { exact: true })
  await expect(graph.locator('.react-flow__node')).toHaveCount(4)
  await expect(graph.locator('.react-flow__edge')).toHaveCount(3)
  await expect(
    graph.getByLabel('Topic hierarchy: Python Lists to Adding Values with append()', {
      exact: true,
    }),
  ).toBeAttached()
  await expect(
    graph.getByLabel('Topic hierarchy: Python Lists to Removing Values with pop()', {
      exact: true,
    }),
  ).toBeAttached()
  await expect(
    graph.getByLabel('Topic hierarchy: Removing Values with pop() to Lists as Stacks', {
      exact: true,
    }),
  ).toBeAttached()
  await expect(graph.locator('[data-id="append"]')).toContainText('Last studied')
  await expect(graph).not.toContainText('Current topic')
  await expect(graph).not.toContainText('Step 1')
  await graph.locator('[data-id="lists"]').dblclick()
  await expect(page).toHaveURL(/screen=graph/)
  await expect(page.getByText('Selected topic group')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open learning node' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await expect(
    page.getByRole('button', {
      name: 'Adding Values with append() Last studied Under Python Lists',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'step')
  const root = page.getByRole('button', { name: 'Python Lists', exact: true })
  const child = page.getByRole('button', {
    name: 'Removing Values with pop() Under Python Lists',
    exact: true,
  })
  const grandchild = page.getByRole('button', {
    name: 'Lists as Stacks Under Removing Values with pop()',
    exact: true,
  })
  const rootX = await root.evaluate((element) => element.getBoundingClientRect().x)
  const childX = await child.evaluate((element) => element.getBoundingClientRect().x)
  const grandchildX = await grandchild.evaluate((element) => element.getBoundingClientRect().x)
  expect(childX - rootX).toBeGreaterThanOrEqual(20)
  expect(grandchildX - childX).toBeGreaterThanOrEqual(20)

  await page.getByRole('button', { name: 'Collapse Removing Values with pop()' }).click()
  await expect(grandchild).toHaveCount(0)
  await expect(root).toBeVisible()
  await page.getByRole('button', { name: 'Expand Removing Values with pop()' }).click()
  await expect(grandchild).toBeVisible()
  await page.getByRole('button', { name: 'Collapse Python Lists' }).click()
  await expect(child).toHaveCount(0)
  await page.getByRole('button', { name: 'Expand Python Lists' }).click()
  await expect(child).toBeVisible()

  await child.click()
  await expect(page.getByText('Selected topic group')).toBeVisible()
  await grandchild.click()
  await expect(page.getByText('Selected learning node')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open learning node' })).toBeVisible()

  await page.getByRole('button', { name: 'Move Removing Values with pop() up' }).click()
  await expect.poll(() => state.reordered).toEqual([['lists', 'pop', 'stacks', 'append']])
  expect(Object.fromEntries(state.path.nodes.map((node) => [node.id, node.parent_id]))).toEqual({
    lists: null,
    append: 'lists',
    pop: 'lists',
    stacks: 'pop',
  })
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  const reorderedX = await graph
    .locator('.react-flow__node')
    .evaluateAll((elements) =>
      Object.fromEntries(
        elements.map((element) => [
          element.getAttribute('data-id'),
          element.getBoundingClientRect().x,
        ]),
      ),
    )
  expect(reorderedX.pop).toBeLessThan(reorderedX.append)
})
