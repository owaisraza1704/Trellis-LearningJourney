import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Check,
  ChevronRight,
  CornerUpRight,
  Plus,
  RotateCcw,
  Send,
} from 'lucide-react'
import {
  api,
  date,
  streamInteraction,
  type Evidence,
  type Interaction,
  type Navigate,
  type NodeDetail,
  type NotebookPage,
  type Thread,
  type ThreadDetail,
} from '../lib/api'
import { Empty, ErrorNotice, Loading, Markdown, Modal, Status } from '../components/ui'
import SaveToNotebook from '../components/SaveToNotebook'
import GeneralKnowledgeNotice from '../components/GeneralKnowledgeNotice'
import StudyPanels from '../components/StudyPanels'
import { assessmentText, responseFeedback } from '../lib/response'
import { sourceOriginLabel } from '../lib/source'

const answerStages: Record<string, string> = {
  understanding: 'Understanding your question…',
  finding_sources: 'Finding relevant sources…',
  searching_web: 'Searching the web for stronger evidence…',
  writing: 'Writing an explanation…',
  checking: 'Checking claims and citations…',
  saving: 'Saving the checked answer…',
  presenting: 'Showing the checked answer…',
}

export default function LearningNode(props: {
  nodeId?: string
  threadId?: string
  interactionId?: string
  onNavigate: Navigate
}) {
  if (!props.nodeId)
    return (
      <div className="p-8">
        <Empty title="Choose a topic to start learning">
          <button className="btn mt-3" onClick={() => props.onNavigate('journeys')}>
            Open your curriculum
          </button>
        </Empty>
      </div>
    )
  return (
    <NodeWorkspace
      key={`${props.nodeId}:${props.threadId || 'primary'}`}
      {...props}
      nodeId={props.nodeId}
    />
  )
}

function NodeWorkspace({
  nodeId,
  threadId,
  interactionId,
  onNavigate,
}: {
  nodeId: string
  threadId?: string
  interactionId?: string
  onNavigate: Navigate
}) {
  const client = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [sourcesOnly, setSourcesOnly] = useState(false)
  const [answerStage, setAnswerStage] = useState('understanding')
  const [streamedText, setStreamedText] = useState('')
  const [rightPanel, setRightPanel] = useState('ai')
  const [focusedCitation, setFocusedCitation] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const readingKey = `trellis:reading:${nodeId}:${threadId || 'primary'}`
  useEffect(() => {
    setSelected(interactionId || localStorage.getItem(readingKey))
  }, [readingKey, interactionId])
  useEffect(() => {
    if (selected) localStorage.setItem(readingKey, selected)
  }, [readingKey, selected])
  const [threadTitle, setThreadTitle] = useState('')
  const [creatingThread, setCreatingThread] = useState(false)
  const [savePayload, setSavePayload] = useState<{
    interaction_id?: string
    evidence_id?: string
    title?: string
  } | null>(null)
  const [saved, setSaved] = useState(false)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const node = useQuery({
    queryKey: ['node', nodeId],
    queryFn: () => api<NodeDetail>(`/nodes/${nodeId}`),
  })
  const thread = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api<ThreadDetail>(`/threads/${threadId}`),
    enabled: !!threadId,
  })
  const notebook = useQuery({
    queryKey: ['notebook', node.data?.path.id],
    queryFn: () =>
      api<NotebookPage[]>(`/notebook/pages?path_id=${encodeURIComponent(node.data!.path.id)}`),
    enabled: rightPanel === 'notebook' && !!node.data?.path.id,
  })
  const interactions = threadId ? thread.data?.interactions || [] : node.data?.interactions || []
  const active =
    interactions.find((item) => item.id === selected) || interactions[interactions.length - 1]
  const send = useMutation({
    mutationFn: ({
      text,
      action = 'question',
      sourcesOnly: onlySources = sourcesOnly,
    }: {
      text: string
      action?: string
      fromComposer?: boolean
      sourcesOnly?: boolean
    }) =>
      streamInteraction(
        threadId ? `/threads/${threadId}/interactions` : `/nodes/${nodeId}/interactions`,
        { prompt: text, action, ...(onlySources ? { sources_only: true } : {}) },
        setAnswerStage,
        (chunk) => {
          setAnswerStage('presenting')
          setStreamedText((current) => current + chunk)
        },
      ),
    onMutate: () => {
      setAnswerStage('understanding')
      setStreamedText('')
    },
    onSuccess: (data, variables) => {
      if (variables.fromComposer) {
        setPrompt((current) => (current === variables.text ? '' : current))
      }
      if (threadId) {
        client.setQueryData<ThreadDetail>(['thread', threadId], (current) =>
          current && !current.interactions.some((item) => item.id === data.id)
            ? { ...current, interactions: [...current.interactions, data] }
            : current,
        )
      } else {
        client.setQueryData<NodeDetail>(['node', nodeId], (current) =>
          current && !current.interactions.some((item) => item.id === data.id)
            ? { ...current, interactions: [...current.interactions, data] }
            : current,
        )
      }
      setSelected(data.id)
      setStreamedText('')
      client.invalidateQueries({
        queryKey: [threadId ? 'thread' : 'node', threadId || nodeId],
      })
      client.invalidateQueries({ queryKey: ['history'] })
      client.invalidateQueries({ queryKey: ['workspace'] })
      client.invalidateQueries({ queryKey: ['sources'] })
    },
  })
  const update = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(path, 'PATCH', body),
    onSuccess: () => client.invalidateQueries(),
  })
  const createThread = useMutation({
    mutationFn: () =>
      api<Thread>(`/nodes/${nodeId}/threads`, 'POST', {
        title: threadTitle,
        interaction_id: threadId ? undefined : active?.id,
      }),
    onSuccess: (data) => {
      setCreatingThread(false)
      client.invalidateQueries({ queryKey: ['node', nodeId] })
      onNavigate('node', {
        path_id: data.path_id,
        node_id: nodeId,
        thread_id: data.id,
      })
    },
  })
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    })
  }, [interactions.length, send.isPending])
  if (node.isPending || (threadId && thread.isPending))
    return (
      <div className="p-8">
        <Loading />
      </div>
    )
  if (!node.data || (threadId && !thread.data))
    return (
      <div className="p-8">
        <ErrorNotice error={node.error || thread.error} />
        <button
          className="btn"
          disabled={node.isFetching || thread.isFetching}
          onClick={() => {
            if (!node.data) void node.refetch()
            if (threadId && !thread.data) void thread.refetch()
          }}
        >
          <RotateCcw size={14} /> Retry
        </button>
      </div>
    )
  const { path, nodes, threads } = node.data
  const current = node.data.node
  const ancestors = []
  let parent = nodes.find((item) => item.id === current.parent_id)
  while (parent) {
    ancestors.unshift(parent)
    parent = nodes.find((item) => item.id === parent!.parent_id)
  }
  const closed = thread.data?.thread.status === 'closed'
  const title = threadId ? thread.data!.thread.title : current.title
  const groupIds = new Set(nodes.map((item) => item.parent_id).filter(Boolean))
  const learningNodes = nodes.filter((item) => !groupIds.has(item.id))
  const next = learningNodes.find(
    (item) => item.id !== nodeId && item.position > current.position && item.status !== 'completed',
  )
  const threadOrigin = { path_id: path.id, node_id: nodeId }
  const abstained = active?.status === 'abstained'
  const unverified = active?.status === 'unverified'
  const searchedWeb = active?.evaluation.web_search_performed === true
  const usesWebEvidence = !abstained && active?.evidence.some((item) => item.kind === 'web')
  const warnings = Array.isArray(active?.evaluation?.retrieval_warnings)
    ? active.evaluation.retrieval_warnings.filter(
        (warning): warning is string =>
          typeof warning === 'string' &&
          warning !==
            'This response also uses web sources because the supplied material was unavailable or insufficient.' &&
          warning !==
            'No usable supplied passages matched this question; available web sources may be used.',
      )
    : []
  function showEvidence(number?: number) {
    setFocusedCitation(number || null)
    setRightPanel('evidence')
    if (number) {
      const card = document.getElementById(`trellis-evidence-${number}`)
      card?.focus({ preventScroll: true })
      card?.scrollIntoView({ block: 'nearest' })
    }
  }
  return (
    <div className="screen-enter flex min-h-full min-w-0 flex-col xl:h-full xl:min-h-0 xl:flex-row">
      <aside className="w-full flex-shrink-0 border-b border-[#E3E0D8] p-4 xl:w-52 xl:overflow-y-auto xl:border-b-0 xl:border-r">
        <p className="mb-3 text-[10px] uppercase tracking-widest text-[#A8A5A0]">Current path</p>
        <button
          className="mb-2 text-left text-xs text-[#7A7870] hover:text-[#5B7A58]"
          onClick={() => onNavigate('graph', { path_id: path.id })}
        >
          {path.title}
        </button>
        {ancestors.map((item) => (
          <button
            key={item.id}
            className="mb-2 block text-left text-xs text-[#A8A5A0]"
            onClick={() => onNavigate('graph', { path_id: path.id })}
          >
            › {item.title}
          </button>
        ))}
        <button
          className={`mb-5 block text-left text-sm font-medium ${
            !threadId ? 'text-[#4A5FA5]' : 'text-[#7A7870]'
          }`}
          onClick={() => onNavigate('node', threadOrigin)}
        >
          {current.title}
        </button>
        <div className="mb-5">
          <Status value={current.status} />
        </div>
        <div className="border-t border-[#E3E0D8] pt-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-[#A8A5A0]">
              Exploratory threads
            </p>
            <button
              aria-label="New exploratory thread"
              className="icon-button"
              onClick={() => {
                setThreadTitle('')
                setCreatingThread(true)
              }}
            >
              <Plus size={14} />
            </button>
          </div>
          {threads.length === 0 && (
            <p className="text-xs leading-relaxed text-[#A8A5A0]">
              Explore a related thought while keeping this node focused.
            </p>
          )}
          {threads.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate('node', { ...threadOrigin, thread_id: item.id })}
              className={`mb-2 w-full rounded-lg border p-3 text-left ${
                threadId === item.id
                  ? 'border-[#D4DBF0] bg-[#EEF0F9]'
                  : 'border-transparent hover:bg-[#F0EEE9]'
              }`}
            >
              <p className="text-xs font-medium">↗ {item.title}</p>
              <p className="mt-1 text-[10px] text-[#A8A5A0]">{item.status}</p>
            </button>
          ))}
        </div>
      </aside>
      <StudyPanels
        lesson={
          <section
            aria-label="Lesson"
            className="h-full min-w-0 overflow-y-auto px-6 py-6 [overflow-wrap:anywhere] lg:px-9"
          >
            <div className="mb-5 flex items-center gap-2 text-xs text-[#A8A5A0]">
              <button onClick={() => onNavigate('graph', { path_id: path.id })}>
                {path.title}
              </button>
              <ChevronRight size={12} />
              <span className="text-[#7A7870]">
                {threadId ? 'Exploratory thread' : 'Learning node'}
              </span>
            </div>
            <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="font-display text-3xl font-light">{title}</h1>
                <p className="mt-2 text-sm text-[#7A7870]">
                  {threadId ? `Exploring from ${current.title}` : current.description}
                </p>
              </div>
              {threadId ? (
                <button
                  className="btn-secondary"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      path: `/threads/${threadId}`,
                      body: { status: closed ? 'open' : 'closed' },
                    })
                  }
                >
                  {closed ? 'Reopen thread' : 'Close thread'}
                </button>
              ) : (
                <select
                  aria-label="Learning progress"
                  className="rounded-lg border border-[#E3E0D8] bg-white p-2 text-xs"
                  value={current.status}
                  disabled={update.isPending}
                  onChange={(event) =>
                    update.mutate({
                      path: `/nodes/${nodeId}/progress`,
                      body: { status: event.target.value },
                    })
                  }
                >
                  <option value="not_started">Not started</option>
                  <option value="in_progress">In progress</option>
                  <option value="completed">Completed</option>
                </select>
              )}
            </div>
            {threadId && (
              <div className="mb-6 rounded-lg border border-[#D4DBF0] bg-[#EEF0F9] p-4">
                <p className="text-sm text-[#4A5FA5]">
                  This thread has its own conversation. Your primary node and progress stay intact.
                </p>
                <button
                  className="mt-2 inline-flex items-center gap-1 text-xs text-[#4A5FA5]"
                  onClick={() => onNavigate('node', threadOrigin)}
                >
                  <ArrowLeft size={13} /> Return to Learning Node
                </button>
              </div>
            )}
            <ErrorNotice error={send.error || update.error} />
            {send.isPending && (
              <section
                role="region"
                aria-label="Answer in progress"
                className="mb-5 rounded-xl border border-[#E3E0D8] bg-[#FAF9F6] p-5"
              >
                <p className="text-xs font-medium text-[#5B7A58]">
                  {answerStages[answerStage] || 'Preparing your answer…'}
                </p>
                <h2 className="mt-2 font-display text-lg">{send.variables?.text}</h2>
                {streamedText && (
                  <div className="mt-4">
                    <Markdown>{streamedText}</Markdown>
                  </div>
                )}
              </section>
            )}
            {saved && (
              <div
                role="status"
                className="mb-4 flex items-center justify-between rounded-lg bg-[#EFF4EE] p-3 text-sm text-[#5B7A58]"
              >
                <span>Saved to Notebook</span>
                <button onClick={() => onNavigate('notebook', { path_id: path.id })}>
                  Open Notebook →
                </button>
              </div>
            )}
            {interactions.length === 0 ? (
              <Empty title={threadId ? 'Follow this thought.' : 'Build your understanding.'}>
                <p className="mb-4">
                  Ask a question or request an introduction. Trellis checks your journey’s sources
                  first and searches the web when more evidence is needed.
                </p>
                <button
                  className="btn"
                  disabled={send.isPending || closed}
                  onClick={() =>
                    send.mutate({
                      text: `Introduce ${title} and explain its main ideas.`,
                      action: 'foundation',
                    })
                  }
                >
                  {send.isPending ? 'Preparing an introduction…' : 'Explain this topic'}
                </button>
              </Empty>
            ) : (
              active && (
                <article>
                  <div className="mb-4 flex items-center justify-between gap-2">
                    <p className="text-xs text-[#A8A5A0]">
                      {active.action.replaceAll('_', ' ')} · {date(active.created_at)}
                    </p>
                    <Status value={active.status} label={responseFeedback(active).label} />
                  </div>
                  <h2 className="mb-5 font-display text-xl">{active.prompt}</h2>
                  {abstained ? (
                    <div className="rounded-xl border border-[#E6DCC8] bg-[#FBF7ED] p-5">
                      <p className="text-sm leading-relaxed text-[#6F6047]">
                        {responseFeedback(active).message}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          className="btn-secondary"
                          disabled={send.isPending || closed}
                          onClick={() =>
                            send.mutate({
                              text: active.prompt,
                              action: active.action,
                              sourcesOnly,
                            })
                          }
                        >
                          <RotateCcw size={14} /> {send.isPending ? 'Trying again…' : 'Try again'}
                        </button>
                        <button
                          className="btn-secondary"
                          onClick={() => onNavigate('sources', { path_id: path.id })}
                        >
                          Review sources
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {unverified && <GeneralKnowledgeNotice />}
                      <Markdown
                        citationCount={unverified ? 0 : active.evidence?.length || 0}
                        onCitation={unverified ? undefined : showEvidence}
                      >
                        {active.content}
                      </Markdown>
                    </>
                  )}
                  {(searchedWeb || usesWebEvidence) && (
                    <div className="mt-4 rounded-lg border border-[#DDE5DA] bg-[#EFF4EE] p-3 text-xs text-[#5B7A58]">
                      <p className="font-medium">
                        {searchedWeb ? 'Web research' : 'Using saved web evidence'}
                      </p>
                      <p className="mt-1 leading-relaxed">
                        {searchedWeb
                          ? unverified
                            ? 'Trellis searched the web, but could not find sufficient support. This answer uses general AI knowledge.'
                            : abstained
                              ? 'Trellis looked for additional web evidence, but could not verify an answer.'
                              : usesWebEvidence
                                ? 'Trellis searched the web for this question. Cited web sources are saved with this journey for reuse.'
                                : 'Trellis looked for additional web evidence. This answer uses your existing materials.'
                          : 'This answer cites web sources already saved with this journey.'}
                      </p>
                      <button
                        className="mt-2 underline"
                        onClick={() => onNavigate('sources', { path_id: path.id })}
                      >
                        View journey sources
                      </button>
                    </div>
                  )}
                  {warnings.length > 0 && (
                    <div className="mt-4 rounded-lg border border-[#E6DCC8] bg-[#FBF7ED] p-3 text-xs text-[#6F6047]">
                      <p className="font-medium">Some sources need attention</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {warnings.map((warning, index) => (
                          <li key={index}>{assessmentText(warning, active.evidence)}</li>
                        ))}
                      </ul>
                      <button
                        className="mt-2 underline"
                        onClick={() => onNavigate('sources', { path_id: path.id })}
                      >
                        Review source status
                      </button>
                    </div>
                  )}
                  <div className="mt-6 flex flex-wrap gap-2">
                    {!abstained && (
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setSaved(false)
                          setSavePayload({
                            interaction_id: active.id,
                            title: active.prompt,
                          })
                        }}
                      >
                        <Bookmark size={14} /> Save to Notebook
                      </button>
                    )}
                    {!unverified && (
                      <button className="btn-secondary" onClick={() => showEvidence()}>
                        {active.evidence?.length || 0} {abstained ? 'consulted' : 'cited'}{' '}
                        {active.evidence?.length === 1 ? 'passage' : 'passages'}
                      </button>
                    )}
                    {!threadId && (
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setThreadTitle('')
                          setCreatingThread(true)
                        }}
                      >
                        <CornerUpRight size={14} /> Explore Further
                      </button>
                    )}
                  </div>
                  <GroundingAssessment interaction={active} />
                </article>
              )
            )}
            <div className="mt-8 flex flex-wrap gap-2 border-t border-[#E3E0D8] pt-5">
              {[
                {
                  action: 'example',
                  label: 'Show example',
                  text: `Give a practical example of ${title}.`,
                },
                {
                  action: 'deeper',
                  label: 'Go deeper',
                  text: `Explain ${title} in more depth.`,
                },
                {
                  action: 'comparison',
                  label: 'Compare ideas',
                  text: `Compare ${title} with a closely related concept.`,
                },
                {
                  action: 'application',
                  label: 'Apply it',
                  text: `Explain how to apply ${title} in practice.`,
                },
              ].map((item) => (
                <button
                  key={item.action}
                  className="btn-secondary"
                  disabled={send.isPending || closed}
                  onClick={() => send.mutate(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {!threadId && (
              <div className="mt-8 flex justify-between gap-3 border-t border-[#E3E0D8] pt-5">
                <button
                  className="btn-secondary"
                  onClick={() => onNavigate('graph', { path_id: path.id })}
                >
                  <ArrowLeft size={14} /> Curriculum
                </button>
                {current.status === 'completed' && next ? (
                  <button
                    className="btn"
                    onClick={() => onNavigate('node', { path_id: path.id, node_id: next.id })}
                  >
                    Next topic <ArrowRight size={14} />
                  </button>
                ) : current.status === 'completed' &&
                  learningNodes.some((item) => item.status !== 'completed') ? (
                  <button className="btn" onClick={() => onNavigate('graph', { path_id: path.id })}>
                    Return to remaining topics <ArrowRight size={14} />
                  </button>
                ) : (
                  <button
                    className="btn"
                    disabled={update.isPending || current.status === 'completed'}
                    onClick={() =>
                      update.mutate({
                        path: `/nodes/${nodeId}/progress`,
                        body: { status: 'completed' },
                      })
                    }
                  >
                    <Check size={14} />{' '}
                    {current.status === 'completed' ? 'Completed' : 'Mark complete'}
                  </button>
                )}
              </div>
            )}
          </section>
        }
        tools={
          <aside
            aria-label="Study tools"
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-t border-[#E3E0D8] bg-[#FCFBF8] [overflow-wrap:anywhere] xl:border-t-0"
          >
            <div className="flex shrink-0 border-b border-[#E3E0D8]">
              {['ai', 'notebook', 'evidence'].map((tab) => (
                <button
                  key={tab}
                  className={`flex-1 py-4 text-xs capitalize ${
                    rightPanel === tab
                      ? 'border-b-2 border-[#5B7A58] text-[#1A1916]'
                      : 'text-[#A8A5A0]'
                  }`}
                  onClick={() => setRightPanel(tab)}
                >
                  {tab === 'ai' ? 'AI' : tab}
                </button>
              ))}
            </div>
            {rightPanel === 'ai' && (
              <div className="flex min-h-[400px] min-w-0 flex-1 flex-col overflow-hidden p-4 xl:min-h-0">
                <div className="mb-4 rounded-lg border border-[#E3E0D8] bg-[#F0EEE9] p-3">
                  <p className="text-[10px] uppercase tracking-widest text-[#A8A5A0]">AI Context</p>
                  <p className="mt-1 text-xs font-medium text-[#4A5FA5]">{title}</p>
                  <p className="mt-1 text-[10px] text-[#7A7870]">
                    {threadId
                      ? 'Isolated exploratory thread'
                      : ancestors.length
                        ? 'Current topic, conversation, and parent topic summaries'
                        : 'Current topic and conversation'}
                  </p>
                </div>
                <div className="min-h-0 min-w-0 max-h-[50vh] flex-1 space-y-4 overflow-y-auto xl:max-h-none">
                  {interactions.map((item) => (
                    <div key={item.id}>
                      <button
                        className="ml-auto block max-w-[95%] rounded-xl rounded-br-sm bg-[#2D2C28] px-3 py-2 text-left text-xs text-white"
                        onClick={() => setSelected(item.id)}
                      >
                        {item.prompt}
                      </button>
                      <button
                        aria-label={`Read response to ${item.prompt}`}
                        className={`mt-2 w-full rounded-lg p-2 text-left text-xs leading-relaxed ${
                          active?.id === item.id ? 'bg-[#F0EEE9]' : 'hover:bg-[#F0EEE9]'
                        }`}
                        onClick={() => setSelected(item.id)}
                      >
                        {item.status === 'unverified' && <GeneralKnowledgeNotice compact />}
                        <div className="text-[#5A5850]">
                          <Markdown compact>{responseFeedback(item).message}</Markdown>
                        </div>
                        <span className="mt-2 block text-[10px] text-[#5B7A58]">
                          {item.status === 'unverified' ? (
                            'Read unverified response'
                          ) : (
                            <>
                              {item.status === 'abstained' ? 'Answer withheld' : 'Read response'} ·{' '}
                              {item.evidence?.length || 0}{' '}
                              {item.status === 'abstained' ? 'consulted' : 'cited'}{' '}
                              {item.evidence?.length === 1 ? 'passage' : 'passages'}
                            </>
                          )}
                        </span>
                      </button>
                    </div>
                  ))}
                  {send.isPending && (
                    <div>
                      <Loading label={answerStages[answerStage] || 'Preparing your answer…'} />
                      {!(send.variables?.sourcesOnly ?? sourcesOnly) && (
                        <p className="mt-1 text-[10px] text-[#7A7870]">
                          If evidence is insufficient, Trellis may provide a labelled general AI
                          explanation.
                        </p>
                      )}
                    </div>
                  )}
                  <div ref={messagesEnd} />
                </div>
                <form
                  className="mt-4 border-t border-[#E3E0D8] pt-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (prompt.trim() && !send.isPending && !closed)
                      send.mutate({ text: prompt, fromComposer: true })
                  }}
                >
                  <label className="sr-only" htmlFor="node-question">
                    Ask about this topic
                  </label>
                  <textarea
                    id="node-question"
                    className="field !text-xs"
                    rows={3}
                    placeholder={
                      closed ? 'Reopen this thread to continue' : 'Ask about this topic…'
                    }
                    value={prompt}
                    disabled={closed}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                        return
                      event.preventDefault()
                      if (!event.repeat) event.currentTarget.form?.requestSubmit()
                    }}
                  />
                  <p className="mt-1 text-[10px] text-[#7A7870]">
                    Enter to send · Shift+Enter for a new line
                  </p>
                  <label className="mt-3 flex items-center gap-2 text-xs text-[#5A5850]">
                    <input
                      type="checkbox"
                      checked={sourcesOnly}
                      disabled={send.isPending || closed}
                      onChange={(event) => setSourcesOnly(event.target.checked)}
                    />
                    Sources only
                  </label>
                  <p className="mt-1 text-[10px] leading-relaxed text-[#7A7870]">
                    {sourcesOnly
                      ? 'Only show answers supported by your materials or web sources.'
                      : 'Uses sources first; may fall back to labelled general AI knowledge.'}
                  </p>
                  <button
                    className="btn mt-2 w-full"
                    disabled={!prompt.trim() || send.isPending || closed}
                  >
                    <Send size={13} />
                    {send.isPending ? 'Thinking…' : 'Ask Trellis'}
                  </button>
                </form>
              </div>
            )}
            {rightPanel === 'evidence' && (
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
                <p className="mb-4 text-xs text-[#7A7870]">
                  {unverified
                    ? 'This response uses general AI knowledge and has no verified source references.'
                    : abstained
                      ? 'Passages consulted for this question. They did not provide enough verified support for an answer.'
                      : 'Source passages cited in the selected response.'}
                </p>
                {!active?.evidence?.length && (
                  <Empty title={abstained ? 'No usable passages' : 'No cited evidence'}>
                    <p>
                      {unverified
                        ? 'Add a relevant source or ask again with Sources only to request a supported answer.'
                        : abstained
                          ? 'Add a relevant source and try the question again.'
                          : 'This response has no supporting source references.'}
                    </p>
                  </Empty>
                )}
                {active?.evidence?.map((evidence, index) => (
                  <EvidenceCard
                    key={`${active.id}:${evidence.id}:${index}`}
                    evidence={evidence}
                    number={index + 1}
                    focused={focusedCitation === index + 1}
                    onSave={() => {
                      setSaved(false)
                      setSavePayload({
                        interaction_id: active.id,
                        evidence_id: evidence.id,
                        title: evidence.title,
                      })
                    }}
                  />
                ))}
              </div>
            )}
            {rightPanel === 'notebook' && (
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
                <button
                  className="btn-secondary mb-4 w-full"
                  onClick={() => {
                    setSaved(false)
                    setSavePayload({ title: '' })
                  }}
                >
                  <Plus size={13} /> Write a note
                </button>
                <ErrorNotice error={notebook.error} />
                {notebook.data?.flatMap((page) =>
                  page.items
                    .filter((item) => item.node_id === nodeId)
                    .map((item) => (
                      <button
                        className="mb-3 block w-full rounded-lg border border-[#E3E0D8] bg-white p-3 text-left"
                        key={item.id}
                        onClick={() =>
                          onNavigate('notebook', { path_id: path.id, notebook_item_id: item.id })
                        }
                      >
                        <p className="text-xs font-medium">{item.title}</p>
                        {item.origin?.status === 'unverified' && <GeneralKnowledgeNotice compact />}
                        <p className="mt-1 text-[10px] text-[#A8A5A0]">{page.title}</p>
                      </button>
                    )),
                )}
                <button
                  className="mt-3 text-xs text-[#5B7A58]"
                  onClick={() => onNavigate('notebook', { path_id: path.id })}
                >
                  Open full notebook →
                </button>
              </div>
            )}
          </aside>
        }
      />
      {creatingThread && (
        <Modal title="Start an exploratory thread" onClose={() => setCreatingThread(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              createThread.mutate()
            }}
          >
            <p className="mb-4 text-sm text-[#7A7870]">
              {threadId
                ? `A separate conversation starts from the primary topic, ${current.title}.`
                : `A separate conversation starts from this topic${active ? ' and the selected response' : ''}.`}{' '}
              It will not change your primary learning progress.
            </p>
            <label htmlFor="thread-title" className="field-label">
              What would you like to explore?
            </label>
            <input
              id="thread-title"
              maxLength={200}
              className="field"
              required
              value={threadTitle}
              onChange={(event) => setThreadTitle(event.target.value)}
            />
            <ErrorNotice error={createThread.error} />
            <button className="btn mt-5" disabled={createThread.isPending || !threadTitle.trim()}>
              {createThread.isPending ? 'Creating…' : 'Create thread'}
            </button>
          </form>
        </Modal>
      )}
      {savePayload && (
        <SaveToNotebook
          pathId={path.id}
          journeyTitle={path.title}
          payload={{ ...savePayload, node_id: nodeId, thread_id: threadId }}
          scopeLabel={[path.title, current.title, ...(threadId ? [title] : [])].join(' › ')}
          unverified={
            !savePayload.evidence_id &&
            interactions.find((item) => item.id === savePayload.interaction_id)?.status ===
              'unverified'
          }
          onClose={() => setSavePayload(null)}
          onSaved={() => {
            setSavePayload(null)
            setSaved(true)
          }}
        />
      )}
    </div>
  )
}

function GroundingAssessment({ interaction }: { interaction: Interaction }) {
  const evaluation = interaction.evaluation
  if (interaction.status === 'unverified' || !evaluation || Object.keys(evaluation).length === 0)
    return null
  const explanation =
    evaluation.status === 'evaluation_failed'
      ? ''
      : assessmentText(evaluation.explanation || evaluation.reason, interaction.evidence)
  return (
    <details className="mt-5 border-t border-[#E3E0D8] pt-4">
      <summary className="cursor-pointer text-xs text-[#7A7870]">Grounding assessment</summary>
      <p className="my-3 text-xs text-[#7A7870]">
        {interaction.status === 'abstained'
          ? responseFeedback(interaction).label
          : 'Source checks passed'}
        {evaluation.correction_attempted === true ? ' · A revised draft was also checked.' : ''}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        {[
          ['relevance', 'Question relevance'],
          ['completeness', 'Answer coverage'],
          ['consistency', 'Source consistency'],
          ['grounding', 'Support from sources'],
        ].map(([key, label]) => {
          const score = evaluation[key]
          if (typeof score !== 'number' || !Number.isFinite(score)) return null
          return (
            <div key={key}>
              <dt className="text-[#7A7870]">{label}</dt>
              <dd className="mt-1 font-medium text-[#3D3C38]">{Math.round(score * 100)}%</dd>
            </div>
          )
        })}
      </dl>
      {explanation && <p className="mt-3 text-xs leading-relaxed text-[#7A7870]">{explanation}</p>}
      <p className="mt-3 text-[11px] text-[#A8A5A0]">
        Automated checks describe the draft’s support in these passages; they do not guarantee
        factual correctness.
      </p>
    </details>
  )
}

function EvidenceCard({
  evidence,
  number,
  focused,
  onSave,
}: {
  evidence: Evidence
  number: number
  focused: boolean
  onSave: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    if (focused) {
      setExpanded(true)
      card.current?.focus({ preventScroll: true })
      card.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [focused])
  const long = evidence.excerpt.length > 360
  return (
    <article
      ref={card}
      id={`trellis-evidence-${number}`}
      tabIndex={-1}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setExpanded(true)
      }}
      aria-label={`Cited passage ${number}`}
      className={`mb-4 rounded-lg border bg-white p-4 focus:outline-2 focus:outline-[#5B7A58] ${focused ? 'border-[#5B7A58]' : 'border-[#E3E0D8]'}`}
    >
      <p className="text-xs font-medium">
        [{number}] {evidence.title}
      </p>
      <p className="mt-1 text-[10px] text-[#A8A5A0]">
        {sourceOriginLabel(evidence.kind)}
        {evidence.location ? ` · ${evidence.location}` : ''}
      </p>
      <blockquote className="my-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 border-[#C5D9C4] pl-3 text-xs leading-relaxed text-[#7A7870]">
        {long && !expanded ? `${evidence.excerpt.slice(0, 360)}…` : evidence.excerpt}
      </blockquote>
      {long && (
        <button
          className="mb-3 text-xs text-[#5B7A58] underline"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Read full passage'}
        </button>
      )}
      <div className="flex items-center justify-between gap-2">
        {evidence.url && (
          <a
            href={evidence.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-[#4A5FA5]"
          >
            Open source ↗
          </a>
        )}
        <button className="text-xs text-[#5B7A58]" onClick={onSave}>
          Save excerpt
        </button>
      </div>
    </article>
  )
}
