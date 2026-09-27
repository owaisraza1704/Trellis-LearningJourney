import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Background, Controls, MarkerType, Position, ReactFlow } from '@xyflow/react'
import {
  ArrowDown,
  ArrowUp,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  List,
  Network,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import '@xyflow/react/dist/style.css'
import {
  api,
  date,
  type LearningNode,
  type Navigate,
  type PathDetail,
  type Workspace,
} from '../lib/api'
import { Empty, ErrorNotice, Loading, Modal, Status } from '../components/ui'
import { assessmentText } from '../lib/response'

function NodeEditor({
  node,
  nodes,
  pathId,
  onDone,
}: {
  node?: LearningNode
  nodes: LearningNode[]
  pathId: string
  onDone: () => void
}) {
  const client = useQueryClient()
  const [title, setTitle] = useState(node?.title || '')
  const [description, setDescription] = useState(node?.description || '')
  const [parent, setParent] = useState(node?.parent_id || '')
  const save = useMutation({
    mutationFn: () =>
      api(node ? `/nodes/${node.id}` : `/paths/${pathId}/nodes`, node ? 'PATCH' : 'POST', {
        title,
        description,
        parent_id: parent || null,
      }),
    onSuccess: () => {
      client.invalidateQueries()
      onDone()
    },
  })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <label className="field-label" htmlFor="node-title">
        Title
      </label>
      <input
        id="node-title"
        maxLength={200}
        className="field"
        required
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className="field-label" htmlFor="node-description">
        What this topic covers
      </label>
      <textarea
        id="node-description"
        className="field min-h-24"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <label className="field-label" htmlFor="node-parent">
        Parent topic
      </label>
      <select
        id="node-parent"
        className="field"
        value={parent}
        onChange={(event) => setParent(event.target.value)}
      >
        <option value="">Top level</option>
        {nodes
          .filter((item) => item.id !== node?.id)
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
      </select>
      <ErrorNotice error={save.error} />
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onDone}>
          Cancel
        </button>
        <button className="btn" disabled={save.isPending || !title.trim()}>
          {save.isPending ? 'Saving…' : node ? 'Save topic' : 'Add Topic'}
        </button>
      </div>
    </form>
  )
}

export default function CurriculumGraph({
  pathId,
  onNavigate,
}: {
  pathId?: string
  onNavigate: Navigate
}) {
  const client = useQueryClient()
  const [view, setView] = useState<'graph' | 'list'>('graph')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<LearningNode | 'new' | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<Workspace>('/workspace'),
  })
  const path = useQuery({
    queryKey: ['path', pathId],
    queryFn: () => api<PathDetail>(`/paths/${pathId}`),
    enabled: !!pathId,
  })
  const mutate = useMutation({
    mutationFn: ({ route, method, body }: { route: string; method: string; body?: unknown }) =>
      api(route, method, body),
    onSuccess: () => {
      client.invalidateQueries()
      setEditingPath(false)
    },
  })
  const nodes = path.data?.nodes || []
  const savedResume = workspace.data?.paths.find((item) => item.id === pathId)?.resume
  const activeNodeId =
    savedResume?.node_id ||
    (workspace.data?.location.path_id === pathId ? workspace.data?.location.node_id : null)
  const selected =
    nodes.find((node) => node.id === selectedId) ||
    nodes.find((node) => node.id === activeNodeId) ||
    nodes[0]
  const generation = path.data?.generation?.created_at ? path.data.generation : null
  const assessment = generation?.evaluation || {}
  const incompleteRequest =
    (typeof assessment.completeness === 'number' && assessment.completeness < 0.9) ||
    (Array.isArray(assessment.missing_topics) && assessment.missing_topics.length > 0) ||
    assessment.hierarchy_preserved === false
  const nodeSources =
    generation?.evidence.filter((source) => selected?.evidence_ids?.includes(source.id)) || []
  const isSequence = nodes.length > 1 && nodes.every((node) => !node.parent_id)
  const childrenByParent = new Map<string | null, LearningNode[]>()
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parent_id) || []
    siblings.push(node)
    childrenByParent.set(node.parent_id, siblings)
  }
  const isGroup = (nodeId: string) => (childrenByParent.get(nodeId)?.length || 0) > 0
  const outlineRows: { node: LearningNode; depth: number }[] = []
  function addOutlineRows(parentId: string | null, depth: number) {
    for (const node of childrenByParent.get(parentId) || []) {
      outlineRows.push({ node, depth })
      if (!collapsedIds.has(node.id)) addOutlineRows(node.id, depth + 1)
    }
  }
  addOutlineRows(null, 0)
  const graph = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>()
    if (!isSequence) {
      const widths = new Map<string, number>()
      function measure(node: LearningNode): number {
        const children = childrenByParent.get(node.id) || []
        const childrenWidth = children.reduce((total, child) => total + measure(child), 0)
        const width = Math.max(230, childrenWidth + Math.max(0, children.length - 1) * 40)
        widths.set(node.id, width)
        return width
      }
      function place(node: LearningNode, left: number, depth: number) {
        const width = widths.get(node.id)!
        positions.set(node.id, { x: left + width / 2, y: 60 + depth * 195 })
        const children = childrenByParent.get(node.id) || []
        const childrenWidth =
          children.reduce((total, child) => total + widths.get(child.id)!, 0) +
          Math.max(0, children.length - 1) * 40
        let childLeft = left + (width - childrenWidth) / 2
        for (const child of children) {
          place(child, childLeft, depth + 1)
          childLeft += widths.get(child.id)! + 40
        }
      }
      let left = 0
      for (const root of childrenByParent.get(null) || []) {
        const width = measure(root)
        place(root, left, 0)
        left += width + 40
      }
    }
    return {
      nodes: nodes.map((node, index) => {
        const row = Math.floor(index / 2)
        const column = row % 2 === 0 ? index % 2 : 1 - (index % 2)
        const point = isSequence
          ? { x: column * 300 + 115, y: row * 180 + 60 }
          : positions.get(node.id)!
        return {
          id: node.id,
          position: { x: point.x - 115, y: point.y - 60 },
          sourcePosition:
            isSequence && index % 2 === 0
              ? column === 0
                ? Position.Right
                : Position.Left
              : Position.Bottom,
          targetPosition:
            isSequence && index % 2 === 1
              ? column === 0
                ? Position.Right
                : Position.Left
              : Position.Top,
          data: {
            label: (
              <div className="text-center">
                {isSequence && <p className="mb-1 text-[11px] opacity-70">Step {index + 1}</p>}
                <p className="text-sm font-medium">{node.title}</p>
                <p className="mt-1 text-xs opacity-70">{node.status.replaceAll('_', ' ')}</p>
                {node.id === activeNodeId && (
                  <p className="mt-1 text-xs font-medium">
                    {node.status === 'not_started' ? 'Current topic' : 'Last studied'}
                  </p>
                )}
              </div>
            ),
          },
          style: {
            width: 230,
            minHeight: 120,
            borderRadius: 12,
            border: `1.5px solid ${
              selected?.id === node.id
                ? '#4A5FA5'
                : node.status === 'completed'
                  ? '#5B7A58'
                  : '#D4D0C8'
            }`,
            background: node.status === 'completed' ? '#5B7A58' : '#FFFFFF',
            color: node.status === 'completed' ? '#FFFFFF' : '#3D3C38',
          },
        }
      }),
      edges: isSequence
        ? nodes.slice(1).map((node, index) => ({
            id: `sequence-${nodes[index].id}-${node.id}`,
            source: nodes[index].id,
            target: node.id,
            type: 'smoothstep',
            ariaLabel: `Learning sequence: ${nodes[index].title} to ${node.title}`,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#7B87AF' },
            style: { stroke: '#7B87AF', strokeWidth: 1.5, strokeDasharray: '6 4' },
          }))
        : nodes
            .filter((node) => node.parent_id)
            .map((node) => ({
              id: `${node.parent_id}-${node.id}`,
              source: node.parent_id!,
              target: node.id,
              ariaLabel: `Topic hierarchy: ${nodes.find((parent) => parent.id === node.parent_id)?.title} to ${node.title}`,
              style: { stroke: '#B8C8B6', strokeWidth: 1.5 },
            })),
    }
  }, [nodes, selected?.id, activeNodeId, isSequence])
  function reorder(node: LearningNode, delta: number) {
    const siblings = [...(childrenByParent.get(node.parent_id) || [])]
    const index = siblings.findIndex((item) => item.id === node.id)
    ;[siblings[index], siblings[index + delta]] = [siblings[index + delta], siblings[index]]
    childrenByParent.set(node.parent_id, siblings)
    const ordered: string[] = []
    function appendBranch(parentId: string | null) {
      for (const item of childrenByParent.get(parentId) || []) {
        ordered.push(item.id)
        appendBranch(item.id)
      }
    }
    appendBranch(null)
    mutate.mutate({
      route: `/paths/${pathId}/reorder`,
      method: 'POST',
      body: { node_ids: ordered },
    })
  }
  if (!pathId)
    return (
      <Empty title="Choose a journey">
        <button className="btn mt-3" onClick={() => onNavigate('journeys')}>
          Browse My Journeys
        </button>
      </Empty>
    )
  if (path.isPending) return <Loading />
  if (!path.data) return <ErrorNotice error={path.error} />
  return (
    <div className="screen-enter flex min-h-[calc(100vh-4rem)] flex-col">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="font-display text-3xl font-light">{path.data.title}</h1>
          <p className="mt-2 text-sm text-[#7A7870]">{path.data.description}</p>
          <p className="mt-3 text-xs text-[#5B7A58]">
            {path.data.completed_count} of {path.data.node_count} learning topics complete ·{' '}
            {Math.round(path.data.progress)}%
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary"
            onClick={() => {
              setTitle(path.data!.title)
              setDescription(path.data!.description)
              setEditingPath(true)
            }}
          >
            <Pencil size={13} /> Edit journey
          </button>
          <button className="btn" onClick={() => setEditor('new')}>
            <Plus size={14} /> Add Topic
          </button>
        </div>
      </div>
      {incompleteRequest && (
        <div
          role="note"
          aria-label="Saved curriculum coverage"
          className="mb-5 rounded-xl border border-[#E9DCB7] bg-[#FFFAEF] px-5 py-4 text-sm text-[#825C28]"
        >
          <p>
            Some requested topics may be missing. Review the original request alongside this
            curriculum.
          </p>
          {typeof assessment.completeness === 'number' && (
            <p className="mt-2 text-xs">
              Saved completeness assessment: {Math.round(assessment.completeness * 100)}%.
            </p>
          )}
        </div>
      )}
      {assessment.status === 'plan_only' && (
        <div
          role="note"
          aria-label="Learning outline source status"
          className="mb-5 rounded-xl border border-[#D9E1D7] bg-[#F2F6F0] px-5 py-4 text-sm text-[#3D5D40]"
        >
          <p className="font-medium">This is a learning outline from your goal.</p>
          <p className="mt-1">
            The detailed curriculum draft did not pass review, so these topics have neutral
            descriptions. Trellis checks evidence when you study each one.
          </p>
        </div>
      )}
      <details className="mb-5 rounded-xl border border-[#E3E0D8] bg-white px-5 py-4">
        <summary className="cursor-pointer text-sm font-medium text-[#5B7A58]">
          Original request
        </summary>
        <dl className="mt-4 text-xs">
          <dt className="text-[#7A7870]">Input type</dt>
          <dd className="mt-1 font-medium">
            {path.data.generation?.mode === 'goal'
              ? 'Learning goal'
              : path.data.generation?.mode === 'outline'
                ? 'Existing curriculum'
                : 'Not recorded for this journey'}
          </dd>
        </dl>
        <div
          role="region"
          aria-label="Original request text"
          className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#3D3C38]"
        >
          {path.data.input}
        </div>
      </details>
      <details className="mb-5 rounded-xl border border-[#E3E0D8] bg-white px-5 py-4">
        <summary className="cursor-pointer text-sm font-medium text-[#5B7A58]">
          Original curriculum sources and assessment
        </summary>
        {!generation ? (
          <p className="mt-3 text-sm text-[#7A7870]">
            Source assessment not recorded for this journey.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-[#7A7870]">
              Recorded when this journey was created. Later edits have not been reassessed.
            </p>
            <p className="text-xs text-[#7A7870]">
              {generation.basis === 'source_roadmap'
                ? 'Imported source roadmap'
                : generation.mode === 'outline'
                  ? 'Imported outline'
                  : 'Generated learning path'}
              {' · '}
              {generation.provider} / {generation.model}
              {' · '}
              {date(generation.created_at)}
            </p>
            {typeof assessment.status === 'string' && (
              <div className="flex items-center gap-2 text-xs text-[#7A7870]">
                <span>Originally recorded result:</span>
                <Status value={assessment.status} />
              </div>
            )}
            {typeof assessment.explanation === 'string' && (
              <p className="text-sm text-[#3D3C38]">
                {assessmentText(assessment.explanation, generation.evidence)}
              </p>
            )}
            <dl className="flex flex-wrap gap-x-6 gap-y-3 text-xs">
              {['relevance', 'completeness', 'consistency', 'grounding'].map((criterion) =>
                typeof assessment[criterion] === 'number' ? (
                  <div key={criterion}>
                    <dt className="capitalize text-[#7A7870]">{criterion}</dt>
                    <dd className="mt-1 font-medium">
                      {Math.round((assessment[criterion] as number) * 100)}%
                    </dd>
                  </div>
                ) : null,
              )}
            </dl>
            <p className="text-xs text-[#7A7870]">
              {generation.basis === 'source_roadmap'
                ? 'Sections were extracted from the selected source. Review that source to confirm its structure.'
                : 'Automated assessment can make mistakes. Review the retained sources when checking a topic.'}
            </p>
            {generation.evidence.length === 0 ? (
              <p className="text-sm text-[#7A7870]">
                {generation.basis === 'source_roadmap'
                  ? 'The selected source is the recorded curriculum basis.'
                  : generation.mode === 'outline'
                    ? 'The supplied outline is the recorded curriculum basis.'
                    : 'No source excerpts were recorded.'}
              </p>
            ) : (
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {generation.evidence.map((source, index) => (
                  <article key={source.id} className="rounded-lg bg-[#F7F6F2] p-4 text-xs">
                    <p className="font-medium">
                      [{index + 1}] {source.title}
                    </p>
                    {source.location && <p className="mt-1 text-[#7A7870]">{source.location}</p>}
                    <blockquote className="my-3 whitespace-pre-wrap border-l-2 border-[#C5D9C4] pl-3 leading-relaxed text-[#7A7870]">
                      {source.excerpt}
                    </blockquote>
                    {source.url && (
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-[#4A5FA5]"
                      >
                        {source.url}
                      </a>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
      </details>
      <div className="mb-4 flex gap-2">
        <button
          className={view === 'graph' ? 'btn' : 'btn-secondary'}
          onClick={() => setView('graph')}
        >
          <Network size={14} /> Graph
        </button>
        <button
          className={view === 'list' ? 'btn' : 'btn-secondary'}
          onClick={() => setView('list')}
        >
          <List size={14} /> Outline
        </button>
      </div>
      <ErrorNotice error={mutate.error || workspace.error} />
      <div className="flex flex-1 flex-col gap-4 xl:flex-row">
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-[#E3E0D8] bg-white">
          {nodes.length === 0 ? (
            <Empty title="Add your first topic" />
          ) : view === 'graph' ? (
            <>
              <div className="border-b border-[#F0EEE9] px-5 py-3 text-xs text-[#7A7870]">
                <p className="font-medium text-[#3D3C38]">
                  {isSequence ? 'Learning sequence' : 'Topic hierarchy'}
                </p>
                <p className="mt-1">
                  {isSequence
                    ? 'Dashed arrows follow your topic order. They do not indicate prerequisites.'
                    : 'Solid lines connect parent topics to their subtopics.'}{' '}
                  Pan or zoom to explore, or use Outline to see every topic.
                </p>
              </div>
              <div className="h-[560px]" aria-label="Curriculum graph">
                <ReactFlow
                  key={pathId}
                  nodes={graph.nodes}
                  edges={graph.edges}
                  fitView
                  fitViewOptions={{ padding: 0.12, minZoom: 0.8, maxZoom: 1 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_, node) => setSelectedId(node.id)}
                  onNodeDoubleClick={(_, node) => {
                    if (isGroup(node.id)) setSelectedId(node.id)
                    else onNavigate('node', { path_id: pathId, node_id: node.id })
                  }}
                >
                  <Background color="#E3E0D8" gap={22} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
            </>
          ) : (
            <div className="divide-y divide-[#F0EEE9]">
              {outlineRows.map(({ node, depth }) => {
                const siblings = childrenByParent.get(node.parent_id) || []
                const siblingIndex = siblings.findIndex((item) => item.id === node.id)
                const hasChildren = (childrenByParent.get(node.id)?.length || 0) > 0
                const collapsed = collapsedIds.has(node.id)
                return (
                  <div
                    key={node.id}
                    className={`flex items-center gap-3 py-4 pr-4 ${
                      selected?.id === node.id ? 'bg-[#F7F8FC]' : ''
                    }`}
                    style={{ paddingLeft: 16 + depth * 24 }}
                  >
                    {hasChildren ? (
                      <button
                        className="icon-button flex h-7 w-7 flex-shrink-0 items-center justify-center !p-0"
                        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.title}`}
                        aria-expanded={!collapsed}
                        onClick={() => {
                          setCollapsedIds((current) => {
                            const next = new Set(current)
                            if (collapsed) next.delete(node.id)
                            else next.add(node.id)
                            return next
                          })
                          if (!collapsed) setSelectedId(node.id)
                        }}
                      >
                        {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                      </button>
                    ) : (
                      <span className="w-7 flex-shrink-0" aria-hidden="true" />
                    )}
                    <button
                      className="min-w-0 flex-1 text-left"
                      aria-current={node.id === activeNodeId ? 'step' : undefined}
                      onClick={() => setSelectedId(node.id)}
                    >
                      <p className="text-sm font-medium">{node.title}</p>
                      {node.id === activeNodeId && (
                        <p className="mt-1 text-xs text-[#4A5FA5]">
                          {node.status === 'not_started' ? 'Current topic' : 'Last studied'}
                        </p>
                      )}
                      {node.parent_id && (
                        <p className="mt-1 text-xs text-[#A8A5A0]">
                          Under {nodes.find((parent) => parent.id === node.parent_id)?.title}
                        </p>
                      )}
                    </button>
                    <Status value={node.status} />
                    <button
                      aria-label={`Move ${node.title} up`}
                      className="icon-button"
                      disabled={siblingIndex === 0 || mutate.isPending}
                      onClick={() => reorder(node, -1)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      aria-label={`Move ${node.title} down`}
                      className="icon-button"
                      disabled={siblingIndex === siblings.length - 1 || mutate.isPending}
                      onClick={() => reorder(node, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      aria-label={`Edit ${node.title}`}
                      className="icon-button"
                      onClick={() => setEditor(node)}
                    >
                      <Pencil size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {selected && (
          <aside className="w-full self-start rounded-xl border border-[#E3E0D8] bg-white p-5 xl:w-72">
            <p className="mb-3 text-xs uppercase tracking-widest text-[#A8A5A0]">
              {isGroup(selected.id) ? 'Selected topic group' : 'Selected learning node'}
            </p>
            <h2 className="font-display text-xl">{selected.title}</h2>
            <div className="my-3">
              <Status value={selected.status} />
            </div>
            <p className="text-sm text-[#7A7870]">
              {selected.description || 'Add a description to guide this topic.'}
            </p>
            {isGroup(selected.id) && (
              <p className="mt-3 text-xs text-[#5B7A58]">
                This group organizes its subtopics. Select a learning topic inside it to study.
              </p>
            )}
            {nodeSources.length > 0 && (
              <div className="mt-4 border-t border-[#E3E0D8] pt-4 text-xs">
                <p className="mb-2 font-medium text-[#7A7870]">Original sources for this topic</p>
                <ul className="space-y-2">
                  {nodeSources.map((source) => (
                    <li key={source.id}>
                      [{generation!.evidence.findIndex((entry) => entry.id === source.id) + 1}]{' '}
                      {source.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!isGroup(selected.id) && (
              <button
                className="btn mt-5 w-full"
                onClick={() => onNavigate('node', { path_id: pathId, node_id: selected.id })}
              >
                Open learning node <ArrowRight size={14} />
              </button>
            )}
            <div className="mt-3 flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setEditor(selected)}>
                <Pencil size={13} /> Edit
              </button>
              {!isGroup(selected.id) && (
                <button
                  className="btn-secondary"
                  aria-label="Delete selected topic"
                  disabled={mutate.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        'Delete this topic? Only empty topics without learning history can be removed.',
                      )
                    )
                      mutate.mutate({
                        route: `/nodes/${selected.id}`,
                        method: 'DELETE',
                      })
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
      {editor && (
        <Modal
          title={editor === 'new' ? 'Add to Learning Path' : 'Edit learning topic'}
          onClose={() => setEditor(null)}
        >
          <NodeEditor
            pathId={pathId}
            nodes={nodes}
            node={editor === 'new' ? undefined : editor}
            onDone={() => setEditor(null)}
          />
        </Modal>
      )}
      {editingPath && (
        <Modal title="Edit journey" onClose={() => setEditingPath(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              mutate.mutate({
                route: `/paths/${pathId}`,
                method: 'PATCH',
                body: { title, description },
              })
            }}
          >
            <label className="field-label" htmlFor="path-title">
              Title
            </label>
            <input
              id="path-title"
              maxLength={200}
              className="field"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
            <label className="field-label" htmlFor="path-description">
              Description
            </label>
            <textarea
              id="path-description"
              className="field"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <ErrorNotice error={mutate.error} />
            <button className="btn mt-5" disabled={mutate.isPending}>
              Save journey
            </button>
          </form>
        </Modal>
      )}
    </div>
  )
}
