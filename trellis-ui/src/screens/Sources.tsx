import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Link as LinkIcon, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react'
import { api, date, type Source, type Workspace } from '../lib/api'
import { sourceOriginLabel } from '../lib/source'
import { SourcePreview } from '../components/SourcePreview'
import { Empty, ErrorNotice, Loading, Modal, Status } from '../components/ui'

export function SourceForm({
  pathId,
  onDone,
  submitLabel = 'Add Source',
}: {
  pathId?: string
  onDone: (source: Source) => void
  submitLabel?: string
}) {
  const client = useQueryClient()
  const [kind, setKind] = useState('file')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const submit = useMutation({
    mutationFn: async () => {
      if (kind === 'file') {
        const form = new FormData()
        form.append('file', file!)
        if (pathId) form.append('path_id', pathId)
        return api<Source>('/sources/upload', 'POST', form)
      }
      return api<Source>(
        `/sources/${kind}`,
        'POST',
        kind === 'url'
          ? { url, path_id: pathId || null }
          : { title, content, path_id: pathId || null },
      )
    },
    onSuccess: (source) => {
      client.invalidateQueries({ queryKey: ['sources'] })
      onDone(source)
    },
  })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit.mutate()
      }}
    >
      <div className="mb-5 flex gap-2">
        {[
          { id: 'file', label: 'Upload file', Icon: Upload },
          { id: 'url', label: 'Web page', Icon: LinkIcon },
          { id: 'text', label: 'Paste text', Icon: FileText },
        ].map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={kind === id ? 'btn' : 'btn-secondary'}
            onClick={() => setKind(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      {kind === 'file' ? (
        <>
          <label className="field-label" htmlFor="source-file">
            PDF, Markdown or text
          </label>
          <input
            id="source-file"
            type="file"
            accept=".pdf,.md,.txt"
            className="field"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
        </>
      ) : kind === 'url' ? (
        <>
          <label htmlFor="source-url" className="field-label">
            Source URL
          </label>
          <input
            id="source-url"
            type="url"
            required
            className="field"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
          />
          <p className="mt-2 text-xs text-[#A8A5A0]">
            Use a publicly readable article or documentation page.
          </p>
        </>
      ) : (
        <>
          <label htmlFor="source-title" className="field-label">
            Source title
          </label>
          <input
            id="source-title"
            className="field"
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="source-content" className="field-label">
            Source text
          </label>
          <textarea
            id="source-content"
            className="field min-h-48"
            required
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </>
      )}
      <ErrorNotice error={submit.error} />
      <button
        className="btn mt-5"
        disabled={
          submit.isPending ||
          (kind === 'file'
            ? !file
            : kind === 'url'
              ? !url.trim()
              : !title.trim() || !content.trim())
        }
      >
        {submit.isPending ? 'Adding source…' : submitLabel}
      </button>
    </form>
  )
}

export default function Sources({ pathId }: { pathId?: string }) {
  const client = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [group, setGroup] = useState('all')
  const workspace = useQuery({
    queryKey: ['workspace'],
    queryFn: () => api<Workspace>('/workspace'),
  })
  const sources = useQuery({
    queryKey: ['sources', pathId],
    queryFn: () => api<Source[]>(`/sources${pathId ? `?path_id=${pathId}` : ''}`),
    refetchInterval: (query) =>
      query.state.data?.some((source) =>
        ['processing', 'pending', 'queued'].includes(source.status),
      )
        ? 2000
        : false,
  })
  const action = useMutation({
    mutationFn: ({ id, remove }: { id: string; remove: boolean }) =>
      api(`/sources/${id}${remove ? '' : '/retry'}`, remove ? 'DELETE' : 'POST'),
    onSuccess: (_, { id, remove }) => {
      if (remove && selected === id) setSelected(null)
      client.invalidateQueries({ queryKey: ['sources'] })
      client.invalidateQueries({ queryKey: ['source'] })
    },
  })
  const journeyNames = new Map(workspace.data?.paths.map((path) => [path.id, path.title]))
  const journeyTitle = pathId ? journeyNames.get(pathId) : undefined
  const selectedJourneyId = !pathId && journeyNames.has(group) ? group : undefined
  const addPathId = pathId || selectedJourneyId
  const addLabel = addPathId ? 'Add source to this journey' : 'Add to library'
  const allSources = sources.data || []
  const groups = [
    { id: 'all', label: 'All sources', count: allSources.length },
    {
      id: 'unallocated',
      label: 'Unallocated',
      count: allSources.filter((source) => !source.path_id).length,
    },
  ]
  const journeyGroups = (workspace.data?.paths || []).map((path) => ({
    id: path.id,
    label: path.title,
    count: allSources.filter((source) => source.path_id === path.id).length,
  }))
  const groupedSources =
    !pathId && group !== 'all'
      ? allSources.filter((source) =>
          group === 'unallocated' ? !source.path_id : source.path_id === group,
        )
      : allSources
  const query = search.trim().toLocaleLowerCase()
  const matchingSources = groupedSources.filter((source) =>
    [source.title, source.url, source.path_id && journeyNames.get(source.path_id)]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(query),
  )
  const pageSize = 12
  const pageCount = Math.max(1, Math.ceil(matchingSources.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visibleSources = matchingSources.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  return (
    <div className="screen-enter max-w-5xl mx-auto">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-light">
            {pathId ? `Sources for ${journeyTitle || 'this journey'}` : 'Source Library'}
          </h1>
          <p className="mt-1 text-sm text-[#7A7870]">
            {pathId
              ? 'Documents and links attached to this journey.'
              : 'Your saved documents and links across all journeys.'}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-[#7A7870]">
            Your material comes first. Trellis adds useful web sources to each journey when your
            questions need more evidence.
          </p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          <Plus size={15} /> {addLabel}
        </button>
      </div>
      {!pathId && sources.data && (
        <nav aria-label="Source groups" className="mb-5 flex gap-1 border-b border-[#E3E0D8]">
          {groups.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              aria-pressed={group === item.id}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors ${
                group === item.id
                  ? 'border-[#5B7A58] font-medium text-[#425E40]'
                  : 'border-transparent text-[#7A7870] hover:text-[#2D2C28]'
              }`}
              onClick={() => {
                setGroup(item.id)
                setPage(1)
              }}
            >
              {item.label}
              <span aria-hidden="true" className="text-xs text-[#A8A5A0]">
                {item.count}
              </span>
            </button>
          ))}
        </nav>
      )}
      {!pathId && journeyGroups.length > 0 && (
        <section aria-label="Journey source groups" className="mb-6">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-[#A8A5A0]">Journeys</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {journeyGroups.map((journey) => (
              <button
                key={journey.id}
                type="button"
                aria-label={journey.label}
                aria-pressed={group === journey.id}
                className={`rounded-xl border p-4 text-left transition-colors ${
                  group === journey.id
                    ? 'border-[#5B7A58] bg-[#EFF4EE]'
                    : 'border-[#E3E0D8] bg-white hover:border-[#B8B5AD]'
                }`}
                onClick={() => {
                  setGroup(journey.id)
                  setPage(1)
                }}
              >
                <span className="block text-sm font-medium text-[#2D2C28]">{journey.label}</span>
                <span className="mt-2 block text-xs text-[#7A7870]">
                  {journey.count} {journey.count === 1 ? 'source' : 'sources'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search size={16} className="absolute left-3 top-3 text-[#A8A5A0]" />
          <input
            type="search"
            aria-label="Search sources"
            placeholder={pathId ? 'Search titles or URLs' : 'Search titles, URLs or journeys'}
            className="field !pl-9"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
          />
        </div>
        {sources.data && (
          <p role="status" className="text-sm text-[#7A7870]">
            {matchingSources.length} {matchingSources.length === 1 ? 'source' : 'sources'}
          </p>
        )}
      </div>
      <ErrorNotice error={workspace.error || sources.error || action.error} />
      {sources.isPending && <Loading />}
      {sources.data?.length === 0 && (
        <Empty title="Bring your learning material">
          <p>
            Upload a document, paste text or add a link. Source text and locations stay attached to
            saved evidence.
          </p>
        </Empty>
      )}
      {!!sources.data?.length && groupedSources.length === 0 && (
        <Empty
          title={group === 'unallocated' ? 'No unallocated sources' : 'No sources in this journey'}
        >
          <p>Add a source here, or choose another group.</p>
        </Empty>
      )}
      {groupedSources.length > 0 && matchingSources.length === 0 && (
        <Empty title="No sources match your search">
          <p>Try a different title, URL or journey name.</p>
        </Empty>
      )}
      <div className="space-y-3">
        {visibleSources.map((source) => (
          <article key={source.id} className="rounded-xl border border-[#E3E0D8] bg-white p-5">
            <div className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-3 sm:flex">
              <FileText size={20} className="mt-1 flex-shrink-0 text-[#5B7A58]" />
              <div className="min-w-0 flex-1">
                <button
                  className="text-left font-medium hover:text-[#5B7A58]"
                  onClick={() => setSelected(source.id)}
                >
                  {source.title}
                </button>
                <p className="mt-1 text-xs text-[#A8A5A0]">
                  <span>{source.kind === 'web' ? 'Found by Trellis' : 'Added by you'}</span> ·{' '}
                  <span>{sourceOriginLabel(source.kind)}</span> · {source.chunk_count} passages ·{' '}
                  {date(source.created_at)}
                </p>
                <p className="mt-1 text-xs text-[#7A7870]">
                  {source.path_id
                    ? `Attached to: ${journeyNames.get(source.path_id) || 'Journey unavailable'}`
                    : 'Not attached to a journey'}
                </p>
                {source.url && (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block truncate text-xs text-[#4A5FA5]"
                  >
                    {source.url}
                  </a>
                )}
                <ErrorNotice error={source.error} />
                {source.needs_reindex && (
                  <p className="mt-2 text-xs text-[#946B32]">
                    Reindex needed to match the current embedding settings.
                  </p>
                )}
              </div>
              <div className="col-start-2 flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
                <Status value={source.status} />
                {['ready', 'failed'].includes(source.status) && (
                  <button
                    title={source.status === 'failed' ? 'Retry source' : 'Reindex source'}
                    aria-label={`${source.status === 'failed' ? 'Retry' : 'Reindex'} ${source.title}`}
                    className="btn-secondary"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ id: source.id, remove: false })}
                  >
                    <RefreshCw size={16} />
                    {source.status === 'failed' ? 'Retry' : 'Reindex'}
                  </button>
                )}
                <button
                  aria-label={`Delete ${source.title} permanently`}
                  title="Delete permanently"
                  className="icon-button"
                  disabled={action.isPending || ['pending', 'processing'].includes(source.status)}
                  onClick={() => {
                    if (
                      confirm(
                        'Delete this source permanently? Its stored file and indexed passages will be removed. Evidence already saved in answers and notebooks will remain.',
                      )
                    )
                      action.mutate({ id: source.id, remove: true })
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {pageCount > 1 && (
        <nav aria-label="Source pages" className="mt-6 flex items-center justify-between gap-3">
          <button
            className="btn-secondary"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <p className="text-sm text-[#7A7870]">
            Page {currentPage} of {pageCount}
          </p>
          <button
            className="btn-secondary"
            disabled={currentPage === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </nav>
      )}
      {adding && (
        <Modal title={addLabel} onClose={() => setAdding(false)}>
          <p className="mb-4 text-sm text-[#7A7870]">
            {addPathId
              ? `This source will be attached to ${journeyNames.get(addPathId) || 'this journey'}.`
              : 'This source will be saved in your library. Choose it when creating a journey.'}
          </p>
          <SourceForm pathId={addPathId} submitLabel={addLabel} onDone={() => setAdding(false)} />
        </Modal>
      )}
      {selected && <SourcePreview sourceId={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
