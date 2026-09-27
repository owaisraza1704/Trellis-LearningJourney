export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData
  const response = await fetch(`/api${path}`, {
    method,
    headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? (form ? body : JSON.stringify(body)) : undefined,
  }).catch(() => {
    throw new ApiError('Could not reach Trellis. Please try again.', 0)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    const detail = data?.detail
    throw new ApiError(
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((item: { msg: string }) => item.msg).join('; ')
          : `Request failed (${response.status}). Please try again.`,
      response.status,
    )
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

export async function streamInteraction(
  path: string,
  body: unknown,
  onProgress: (stage: string) => void,
  onText: (text: string) => void,
): Promise<Interaction> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new ApiError('Could not reach Trellis. Please try again.', 0)
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new ApiError(
      data?.detail || `Request failed (${response.status}). Please try again.`,
      response.status,
    )
  }
  // Existing JSON responses remain usable by older servers and local browser fixtures.
  if (response.headers.get('content-type')?.includes('application/json')) {
    return response.json()
  }
  if (!response.body)
    throw new ApiError('The answer stream could not be opened. Please try again.', 0)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let completed: Interaction | undefined
  const readEvent = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line)
    if (event.type === 'progress') onProgress(event.stage)
    if (event.type === 'answer_delta') onText(event.text)
    if (event.type === 'done') completed = event.interaction
    if (event.type === 'error') throw new ApiError(event.message, event.status)
  }

  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })
    const lines = pending.split('\n')
    pending = lines.pop() || ''
    for (const line of lines) readEvent(line)
    if (done) break
  }
  readEvent(pending)
  if (!completed) throw new ApiError('The answer stream ended early. Please refresh this topic.', 0)
  return completed
}

export interface LearningNode {
  id: string
  path_id: string
  parent_id: string | null
  title: string
  description: string
  position: number
  status: 'not_started' | 'in_progress' | 'completed'
  evidence_ids?: string[]
}
export interface PathSummary {
  id: string
  title: string
  description: string
  progress: number
  node_count: number
  completed_count: number
  updated_at: string
  resume?: Location | null
  last_studied_at?: string | null
  notebook_item_count?: number
  notebook_updated_at?: string | null
}
export interface PathDetail extends PathSummary {
  input: string
  nodes: LearningNode[]
  generation?: {
    mode: string
    basis?: string
    provider: string
    model: string
    evidence: Evidence[]
    evaluation: Record<string, unknown>
    created_at: string
  } | null
}
export interface Location {
  path_id: string | null
  node_id?: string | null
  thread_id?: string | null
}
export interface Workspace {
  paths: PathSummary[]
  location: Location
  location_detail?: {
    path_title: string | null
    node_title: string | null
    thread_title: string | null
  }
  stats: {
    paths: number
    nodes: number
    completed: number
    notebook_items: number
  }
}
export interface Evidence {
  id: string
  source_id?: string
  title: string
  url?: string
  excerpt: string
  location?: string
  kind?: string
}
export interface Interaction {
  id: string
  path_id: string
  node_id: string
  thread_id: string | null
  reply_to_interaction_id?: string | null
  prompt: string
  content: string
  action: string
  status: string
  evidence: Evidence[]
  evaluation: Record<string, unknown>
  provider: string
  model: string
  created_at: string
}
export interface Thread {
  id: string
  path_id: string
  node_id: string
  title: string
  status: 'open' | 'closed'
  seed_context: string
  created_at: string
}
export interface NodeDetail {
  node: LearningNode
  path: PathSummary
  nodes: LearningNode[]
  interactions: Interaction[]
  threads: Thread[]
}
export interface ThreadDetail {
  thread: Thread
  node: LearningNode
  path: PathSummary
  interactions: Interaction[]
}
export interface Source {
  id: string
  path_id: string | null
  title: string
  kind: string
  url?: string
  status: string
  error?: string
  chunk_count: number
  created_at: string
  needs_reindex?: boolean
  embedding_profile?: string | null
  excerpts?: Array<{
    content?: string
    text?: string
    excerpt?: string
    location?: string
  }>
}
export interface NotebookItem {
  id: string
  page_id: string
  title: string
  content: string
  position: number
  node_id?: string
  thread_id?: string
  origin?: Record<string, unknown>
  evidence?: Evidence[]
  created_at: string
}
export interface NotebookPage {
  id: string
  path_id: string
  title: string
  position: number
  items: NotebookItem[]
}
export interface StudySet {
  id: string
  path_id: string
  title: string
  item_ids: string[]
  created_at: string
}
export interface ExportRecord {
  id: string
  path_id: string
  title: string
  status: string
  error?: string
  download_url?: string
  created_at: string
}
export interface Activity {
  id: string
  path_id: string
  node_id?: string
  thread_id?: string
  interaction_id?: string | null
  notebook_item_id?: string | null
  kind: string
  label: string
  created_at: string
}
export interface Settings {
  provider: string
  model: string
  providers: Array<{
    id: string
    label: string
    configured: boolean
    model: string
    base_url?: string
  }>
  embedding: { provider: string; model: string; dimensions: number }
  evidence_policy: string
}
export type Screen =
  | 'landing'
  | 'dashboard'
  | 'journeys'
  | 'notebooks'
  | 'graph'
  | 'node'
  | 'create'
  | 'notebook'
  | 'history'
  | 'settings'
  | 'session'
  | 'sources'
export type Navigate = (
  screen: Screen,
  location?: Partial<Location> & {
    interaction_id?: string | null
    notebook_item_id?: string | null
  },
) => void
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
