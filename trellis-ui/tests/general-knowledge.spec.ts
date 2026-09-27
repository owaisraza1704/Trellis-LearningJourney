import { expect, test, type Page } from '@playwright/test'
import type { Interaction, NodeDetail, NotebookPage } from '../src/lib/api'

const label = 'General AI knowledge — not verified against sources'
const createdAt = '2026-09-26T04:00:00Z'
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
  id: 'scaling-node',
  path_id: journey.id,
  parent_id: null,
  title: 'Horizontal scaling',
  description: 'Understand throughput.',
  position: 0,
  status: 'in_progress',
}
const generalAnswer: Interaction = {
  id: 'general-answer',
  path_id: journey.id,
  node_id: node.id,
  thread_id: null,
  prompt: 'Explain QPS',
  action: 'question',
  status: 'unverified',
  content: '**Queries per second** describes how many queries a system processes in one second.',
  evidence: [],
  evaluation: {
    status: 'unverified',
    method: 'model_knowledge',
    fallback_reason: 'evidence_unavailable',
    sources_only: false,
    web_search_performed: true,
  },
  provider: 'fixture',
  model: 'fixture',
  created_at: createdAt,
}

async function mockJourney(page: Page, interactions = [generalAnswer]) {
  const state = {
    interactions: structuredClone(interactions),
    questions: [] as Array<{
      prompt: string
      action: string
      sources_only?: boolean
      reply_to_interaction_id?: string
    }>,
    pages: [
      { id: 'working-notes', path_id: journey.id, title: 'Working notes', position: 0, items: [] },
    ] as NotebookPage[],
    saves: [] as Array<Record<string, unknown>>,
    clears: 0,
  }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/workspace')
      return route.fulfill({
        json: {
          paths: [journey],
          location: { path_id: journey.id, node_id: node.id, thread_id: null },
          stats: { paths: 1, nodes: 1, completed: 0, notebook_items: state.saves.length },
        },
      })
    if (url.pathname === '/api/location')
      return route.fulfill({ json: route.request().postDataJSON() })
    if (url.pathname === `/api/nodes/${node.id}`)
      return route.fulfill({
        json: { path: journey, node, nodes: [node], threads: [], interactions: state.interactions },
      })
    if (url.pathname === `/api/nodes/${node.id}/interactions`) {
      if (route.request().method() === 'DELETE') {
        state.clears += 1
        state.interactions.splice(0)
        return route.fulfill({ status: 204, body: '' })
      }
      const body = route.request().postDataJSON()
      state.questions.push(body)
      const answer: Interaction = {
        ...generalAnswer,
        id: `response-${state.questions.length}`,
        prompt: body.prompt,
        action: body.action,
        reply_to_interaction_id: body.reply_to_interaction_id || null,
        status: body.sources_only ? 'abstained' : 'unverified',
        evaluation: {
          ...generalAnswer.evaluation,
          sources_only: body.sources_only === true,
          status: body.sources_only ? 'evidence_unavailable' : 'unverified',
        },
      }
      state.interactions.push(answer)
      return route.fulfill({ json: answer })
    }
    if (url.pathname === '/api/notebook/pages') return route.fulfill({ json: state.pages })
    if (url.pathname === '/api/notebook/items' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      state.saves.push(body)
      const saved = {
        id: 'saved-answer',
        page_id: body.page_id,
        title: body.title,
        content: generalAnswer.content,
        position: 0,
        node_id: node.id,
        created_at: createdAt,
        evidence: [],
        origin: { ...generalAnswer, interaction_id: generalAnswer.id },
      }
      state.pages[0].items.push(saved)
      return route.fulfill({ json: saved })
    }
    if (url.pathname === '/api/study-sessions')
      return route.fulfill({
        json: [
          {
            id: 'study-selection',
            path_id: journey.id,
            title: 'QPS revision',
            item_ids: ['saved-answer'],
            created_at: createdAt,
          },
        ],
      })
    if (url.pathname === '/api/exports') return route.fulfill({ json: [] })
    return route.fulfill({ status: 404, json: { detail: `Unexpected ${url.pathname}` } })
  })
  return state
}

test('clearing a node chat requires confirmation and leaves the lesson ready to restart', async ({
  page,
}) => {
  const state = await mockJourney(page)
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  const lesson = page.getByRole('region', { name: 'Lesson', exact: true })
  await expect(lesson).toContainText('Queries per second')

  await page.getByRole('button', { name: 'Clear chat' }).click()
  const dialog = page.getByRole('dialog', { name: 'Clear node chat?' })
  await expect(dialog).toContainText(
    'Exploratory threads, saved notebook copies, progress, and sources remain',
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(state.clears).toBe(0)
  await expect(lesson).toContainText('Queries per second')

  await page.getByRole('button', { name: 'Clear chat' }).click()
  await dialog.getByRole('button', { name: 'Clear chat' }).click()
  await expect.poll(() => state.clears).toBe(1)
  await expect(dialog).toHaveCount(0)
  await expect(lesson).toContainText('Build your understanding')
  await expect(page.getByRole('button', { name: 'Read response to Explain QPS' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Clear chat' })).toHaveCount(0)

  await page.reload()
  await expect(lesson).toContainText('Build your understanding')
})

test('general AI answers are visibly unverified in the lesson, preview and evidence panel', async ({
  page,
}) => {
  await mockJourney(page)
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  const lesson = page.getByRole('region', { name: 'Lesson', exact: true })
  const preview = page.getByRole('button', { name: `Read response to ${generalAnswer.prompt}` })
  await expect(lesson.getByText(label, { exact: true })).toBeVisible()
  await expect(lesson).toContainText('may contain inaccuracies')
  await expect(lesson.getByText('Unverified', { exact: true })).toBeVisible()
  await expect(lesson).toContainText('Queries per second')
  await expect(preview).toContainText(label)
  await expect(preview).toContainText('Read unverified response')
  await expect(preview).not.toContainText('cited passages')
  await expect(lesson.getByText('Grounding assessment')).toHaveCount(0)
  await expect(lesson.getByText('Answered', { exact: true })).toHaveCount(0)
  await expect(lesson.getByRole('button', { name: /cited passage/ })).toHaveCount(0)
  await expect(lesson.getByText(/This answer uses your existing materials/)).toHaveCount(0)
  await page.getByRole('button', { name: 'evidence', exact: true }).click()
  await expect(
    page.getByText(
      'This response uses general AI knowledge and has no verified source references.',
    ),
  ).toBeVisible()
})

test('the unverified label follows saved responses into notebook and study views', async ({
  page,
}) => {
  const state = await mockJourney(page)
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await page.getByRole('button', { name: 'Save to Notebook', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(label, { exact: true })).toBeVisible()
  await expect(dialog).toContainText('keeps its unverified label')
  await dialog.getByLabel('Notebook section').selectOption('working-notes')
  await dialog.getByRole('button', { name: 'Save to Notebook', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(state.saves[0].interaction_id).toBe(generalAnswer.id)
  await page.getByRole('button', { name: 'notebook', exact: true }).click()
  await expect(
    page.getByRole('complementary', { name: 'Study tools' }).getByText(label),
  ).toBeVisible()
  await page.goto(`/?screen=notebook&path=${journey.id}`)
  const article = page.locator('article')
  await expect(article.getByText(label, { exact: true })).toBeVisible()
  await expect(article).toContainText('may contain inaccuracies')
  await page.getByRole('link', { name: 'Study & export' }).click()
  const reading = page.getByRole('region', { name: 'Reading preview', exact: true })
  await expect(reading.getByText(label, { exact: true })).toBeVisible()
  await expect(reading).toContainText('may contain inaccuracies')
  await expect(reading.getByText('Saved sources', { exact: true })).toHaveCount(0)
})

test('follow-up buttons use the selected answer rather than the node topic', async ({ page }) => {
  const state = await mockJourney(page)
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByRole('button', { name: 'Compare ideas' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Apply it' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Explain simply' })).toHaveCount(0)

  for (const [index, label, action] of [
    [0, 'Show example', 'example'],
    [1, 'Go deeper', 'deeper'],
    [2, 'Key takeaways', 'recap'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => state.questions.length).toBe(index + 1)
    expect(state.questions[index].action).toBe(action)
    expect(state.questions[index].reply_to_interaction_id).toBe(generalAnswer.id)
    if (action === 'deeper') {
      expect(state.questions[index].prompt).toBe('Go deeper from this answer')
    } else {
      expect(state.questions[index].prompt).toContain(generalAnswer.prompt)
    }
    expect(state.questions[index].prompt).not.toContain(node.title)
    await expect(
      page.getByRole('heading', { name: state.questions[index].prompt, exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: `Read response to ${generalAnswer.prompt}` }).click()
  }
})

test('follow-up buttons target the answer currently open in the lesson', async ({ page }) => {
  const laterAnswer: Interaction = {
    ...generalAnswer,
    id: 'later-answer',
    prompt: 'Go deeper into the answer to: Explain QPS',
    action: 'deeper',
    content: 'A cache miss can increase request latency while the database loads the item.',
    evaluation: {
      ...generalAnswer.evaluation,
      resolved_question: 'How does a cache miss affect request latency?',
    },
  }
  const state = await mockJourney(page, [generalAnswer, laterAnswer])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  for (const [index, label] of ['Show example', 'Go deeper', 'Key takeaways'].entries()) {
    await page.getByRole('button', { name: `Read response to ${laterAnswer.prompt}` }).click()
    await expect(
      page.getByRole('heading', {
        name: 'Go deeper: How does a cache miss affect request latency?',
        exact: true,
      }),
    ).toBeVisible()
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => state.questions.length).toBe(index + 1)
    expect(state.questions[index].reply_to_interaction_id).toBe(laterAnswer.id)
    if (label === 'Go deeper') {
      expect(state.questions[index].prompt).toBe('Go deeper from this answer')
    } else {
      expect(state.questions[index].prompt).toContain(laterAnswer.evaluation.resolved_question)
    }
    expect(state.questions[index].prompt).not.toContain(generalAnswer.prompt)
  }
})

test('a covered lesson offers the curriculum instead of another deeper click', async ({ page }) => {
  const completedAnswer: Interaction = {
    ...generalAnswer,
    action: 'deeper',
    evaluation: {
      ...generalAnswer.evaluation,
      resolved_question: 'What has this RAG lesson covered, and what should come next?',
      lesson_complete: true,
    },
  }
  await mockJourney(page, [completedAnswer])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)

  await expect(
    page.getByRole('heading', { name: 'What we covered and what to study next' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Go deeper', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show example', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue in curriculum' }).click()
  await expect(page).toHaveURL(new RegExp('screen=graph'))
})

test('retrying a failed follow-up keeps its selected answer', async ({ page }) => {
  const failedFollowUp: Interaction = {
    ...generalAnswer,
    id: 'failed-follow-up',
    prompt: 'Go deeper into the answer to: Explain QPS',
    action: 'deeper',
    status: 'abstained',
    reply_to_interaction_id: generalAnswer.id,
    content: 'No answer shown.',
  }
  const state = await mockJourney(page, [generalAnswer, failedFollowUp])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)

  await page.getByRole('button', { name: 'Try again', exact: true }).click()

  await expect.poll(() => state.questions.length).toBe(1)
  expect(state.questions[0].reply_to_interaction_id).toBe(generalAnswer.id)
  expect(state.questions[0].prompt).toBe(failedFollowUp.prompt)
})

test('a withheld follow-up can return to the answer it was extending', async ({ page }) => {
  const previousDeeper: Interaction = {
    ...generalAnswer,
    prompt: 'Go deeper into the answer to: Introduce QPS',
    action: 'deeper',
    evaluation: {
      ...generalAnswer.evaluation,
      resolved_question: 'How do cache misses affect QPS?',
    },
  }
  const failedFollowUp: Interaction = {
    ...generalAnswer,
    id: 'failed-follow-up',
    prompt: 'Go deeper into the answer to: Explain QPS',
    action: 'deeper',
    status: 'abstained',
    reply_to_interaction_id: previousDeeper.id,
    content: 'No answer shown.',
  }
  const state = await mockJourney(page, [previousDeeper, failedFollowUp])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByRole('button', { name: 'Go deeper', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Read previous answer' }).click()
  await expect(
    page.getByRole('heading', { name: 'Go deeper: How do cache misses affect QPS?' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Go deeper', exact: true }).click()

  await expect.poll(() => state.questions.length).toBe(1)
  expect(state.questions[0].reply_to_interaction_id).toBe(previousDeeper.id)
})

test('Sources only is optional and applies to questions and quick actions', async ({ page }) => {
  const state = await mockJourney(page)
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByLabel('Sources only', { exact: true })).not.toBeChecked()
  await page.getByLabel('Ask about this topic', { exact: true }).fill('What is throughput?')
  await page.getByRole('button', { name: 'Ask Trellis', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'What is throughput?', exact: true }),
  ).toBeVisible()
  expect(state.questions[0]).toEqual({ prompt: 'What is throughput?', action: 'question' })
  await page.getByLabel('Sources only', { exact: true }).check()
  await page
    .getByLabel('Ask about this topic', { exact: true })
    .fill('Define throughput from sources')
  await page.getByRole('button', { name: 'Ask Trellis', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Define throughput from sources', exact: true }),
  ).toBeVisible()
  expect(state.questions[1]).toEqual({
    prompt: 'Define throughput from sources',
    action: 'question',
    sources_only: true,
  })
  await page.getByRole('button', { name: 'Read response to What is throughput?' }).click()
  await page.getByRole('button', { name: 'Go deeper', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Go deeper from this answer' }),
  ).toBeVisible()
  expect(state.questions[2].sources_only).toBe(true)
  expect(state.questions[2].action).toBe('deeper')
  expect(state.questions[2].reply_to_interaction_id).toBe('response-1')
})

test('retrying a saved question respects the current Sources only choice', async ({ page }) => {
  const state = await mockJourney(page, [
    {
      ...generalAnswer,
      status: 'abstained',
      content: 'This must not appear as an answer.',
      evaluation: { status: 'evidence_unavailable', sources_only: true },
    },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  await expect(page.getByLabel('Sources only', { exact: true })).not.toBeChecked()
  await page.getByLabel('Sources only', { exact: true }).check()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(() => state.questions.length).toBe(1)
  expect(state.questions[0]).toEqual({
    prompt: generalAnswer.prompt,
    action: 'question',
    sources_only: true,
  })
  await expect(page.getByRole('region', { name: 'Lesson', exact: true })).not.toContainText(
    'This must not appear as an answer.',
  )
  await expect(page.getByRole('button', { name: 'Save to Notebook', exact: true })).toHaveCount(0)
  await page.getByLabel('Sources only', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(() => state.questions.length).toBe(2)
  expect(state.questions[1]).toEqual({ prompt: generalAnswer.prompt, action: 'question' })
  await expect(
    page.getByRole('region', { name: 'Lesson', exact: true }).getByText(label, { exact: true }),
  ).toBeVisible()
})

test('an unavailable AI provider explains the connection problem without claiming sources are missing', async ({
  page,
}) => {
  await mockJourney(page, [
    {
      ...generalAnswer,
      status: 'abstained',
      content: 'Internal provider diagnostics must not be shown.',
      evaluation: { status: 'general_knowledge_failed', sources_only: false },
    },
  ])
  await page.goto(`/?screen=node&path=${journey.id}&node=${node.id}`)
  const lesson = page.getByRole('region', { name: 'Lesson', exact: true })
  await expect(lesson.getByText('AI response unavailable', { exact: true }).first()).toBeVisible()
  await expect(lesson).toContainText('check your model connection in Settings')
  await expect(lesson).not.toContainText('Add a relevant source')
  await expect(lesson).not.toContainText('Internal provider diagnostics')
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled()
})
