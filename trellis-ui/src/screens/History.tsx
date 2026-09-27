import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Clock } from 'lucide-react'
import { api, date, type Activity, type Navigate } from '../lib/api'
import { Empty, ErrorNotice, Loading, Status } from '../components/ui'

interface LearningSession {
  id: string
  path_id: string
  node_id?: string
  thread_id?: string
  path_title?: string | null
  node_title?: string | null
  thread_title?: string | null
  started_at: string
  last_active_at: string
  ended_at?: string
}
export default function History({ onNavigate }: { onNavigate: Navigate }) {
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const activityStart = useRef<HTMLDivElement>(null)
  const pageSize = 12
  const history = useQuery({
    queryKey: ['history', page],
    queryFn: () =>
      api<Activity[]>(`/history?limit=${pageSize + 1}&offset=${(page - 1) * pageSize}`),
  })
  const sessions = useQuery({
    queryKey: ['learning-sessions'],
    queryFn: () => api<LearningSession[]>('/learning-sessions'),
  })
  const endSession = useMutation({
    mutationFn: () => api('/learning-sessions/end', 'POST'),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['learning-sessions'] })
      client.invalidateQueries({ queryKey: ['history'] })
    },
  })
  const active = sessions.data?.find((session) => !session.ended_at)
  const hasNextPage = (history.data?.length || 0) > pageSize
  const changePage = (nextPage: number) => {
    setPage(nextPage)
    activityStart.current?.scrollIntoView({ block: 'start' })
  }
  return (
    <div className="screen-enter mx-auto max-w-3xl">
      <div className="mb-7">
        <h1 className="font-display text-3xl font-light">Learning history</h1>
        <p className="mt-1 text-sm text-[#7A7870]">
          Your learning activity, connected to where it happened.
        </p>
      </div>
      <ErrorNotice error={history.error || sessions.error || endSession.error} />
      {active && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#C5D9C4] bg-[#EFF4EE] p-5">
          <div>
            <p className="text-sm font-medium text-[#5B7A58]">Current study session</p>
            <p className="mt-1 text-sm">
              {[active.path_title, active.node_title, active.thread_title]
                .filter(Boolean)
                .join(' › ')}
            </p>
            <p className="mt-1 text-xs text-[#7A7870]">Started {date(active.started_at)}</p>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              disabled={endSession.isPending}
              onClick={() => endSession.mutate()}
            >
              End session
            </button>
            <button
              className="btn"
              onClick={() => onNavigate(active.node_id ? 'node' : 'graph', active)}
            >
              Resume <ArrowRight size={13} />
            </button>
          </div>
        </div>
      )}
      <div ref={activityStart} />
      {history.isPending ? (
        <Loading />
      ) : history.data?.length === 0 ? (
        <Empty title="Your journey starts here">
          <p>Open a learning node, ask a question or save an insight to begin your history.</p>
        </Empty>
      ) : (
        <div className="space-y-3">
          {history.data?.slice(0, pageSize).map((item) => (
            <button
              key={item.id}
              className="flex w-full items-center gap-4 rounded-xl border border-[#E3E0D8] bg-white p-4 text-left hover:border-[#B8B5AD]"
              onClick={() =>
                onNavigate(
                  item.kind.startsWith('notebook_') ? 'notebook' : item.node_id ? 'node' : 'graph',
                  item,
                )
              }
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[#F0EEE9] text-[#5B7A58]">
                <Clock size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="mt-1 block text-xs text-[#A8A5A0]">
                  {date(item.created_at)} · {item.kind.replaceAll('_', ' ')}
                </span>
              </span>
              <ArrowRight size={14} className="text-[#A8A5A0]" />
            </button>
          ))}
        </div>
      )}
      {(page > 1 || hasNextPage) && (
        <nav aria-label="History pages" className="mt-6 flex items-center justify-between gap-3">
          <button
            className="btn-secondary"
            disabled={page === 1}
            onClick={() => changePage(page - 1)}
          >
            Previous
          </button>
          <p className="text-sm text-[#7A7870]">Page {page}</p>
          <button
            className="btn-secondary"
            disabled={!hasNextPage}
            onClick={() => changePage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
      {!!sessions.data?.length && (
        <section className="mt-8">
          <h2 className="mb-4 font-display text-xl">Study sessions</h2>
          <div className="space-y-2">
            {sessions.data.map((session) => (
              <div
                key={session.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[#E3E0D8] bg-white p-4"
              >
                <div>
                  <p className="text-sm">{date(session.started_at)}</p>
                  <p className="mt-1 text-sm">
                    {[session.path_title, session.node_title, session.thread_title]
                      .filter(Boolean)
                      .join(' › ')}
                  </p>
                  <p className="mt-1 text-xs text-[#A8A5A0]">
                    {session.ended_at
                      ? `Ended ${date(session.ended_at)}`
                      : `Last activity ${date(session.last_active_at)}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Status value={session.ended_at ? 'closed' : 'open'} />
                  <button
                    className="btn-secondary"
                    aria-label={`Resume session from ${date(session.started_at)}`}
                    onClick={() => onNavigate(session.node_id ? 'node' : 'graph', session)}
                  >
                    Resume <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
