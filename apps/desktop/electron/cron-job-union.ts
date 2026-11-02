/**
 * The unified Scheduled jobs list: the jobs of the connection in front plus
 * every CONNECTED registry gateway's jobs, the way the unified Sessions list
 * already splices every connected gateway's chats in (#88880).
 *
 * Cron jobs live in each backend's own profile tree. The renderer's list call
 * names only the connection in front, so a job on another registered
 * connection (a Bot's schedule on an SSH host while you read a chat on This
 * device) never reached the sidebar's Cron jobs section or the Scheduled jobs
 * page. Every job read here is tagged with the `connection_id` that serves it,
 * so its per-job calls (pause, trigger, edit, runs) go to that backend.
 *
 * Only already-pooled backends are read (the caller passes the same sources
 * the Sessions list uses): a list refresh must never dial or spawn a backend.
 * A dead or erroring gateway contributes nothing rather than breaking the list.
 */

type GetJson = (descriptor: unknown, path: string) => Promise<unknown>

export interface CronUnionSource {
  backends: Array<{ descriptor: unknown }>
  connectionId: string
  /** The gateway's install_id, when known. Two sources with one install_id are
   *  one backend (one profile tree), so its jobs are listed once. */
  backendId?: string
}

/** The connection in front: its registry id (null for the unpinned primary)
 *  and its gateway install_id when known. */
export interface CronUnionFront {
  backendId?: null | string
  connectionId: null | string
}

const ALL_PROFILES_CRON_PATH = '/api/cron/jobs?profile=all'

/** A GET of the cross-profile job list: `/api/cron/jobs` with no profile or `profile=all`. */
export function isAllProfilesCronListRequest(method: string | undefined, path: string | undefined): boolean {
  if ((method || 'GET').toUpperCase() !== 'GET' || typeof path !== 'string') {
    return false
  }

  let url: URL

  try {
    url = new URL(path, 'http://x')
  } catch {
    return false
  }

  if (url.pathname.replace(/\/+$/, '') !== '/api/cron/jobs') {
    return false
  }

  return (url.searchParams.get('profile') || 'all').trim().toLowerCase() === 'all'
}

function jobIdentity(connectionId: string, job: Record<string, unknown>): null | string {
  const id = String(job.id ?? job.job_id ?? '').trim()

  // cron.jobs fills a missing id with the sentinel "unknown"; never merge on it.
  if (!id || id === 'unknown') {
    return null
  }

  return `${connectionId}\u0000${String(job.profile ?? '').trim() || 'default'}\u0000${id}`
}

/** One source's jobs from the first of its backends that answers. Every
 *  backend of a connection serves the same profile tree (an SSH source runs one
 *  backend per profile over one HERMES_HOME), so one answer covers it. */
async function readSourceJobs(source: CronUnionSource, getJson: GetJson): Promise<Record<string, unknown>[]> {
  for (const { descriptor } of source.backends) {
    try {
      const jobs = await getJson(descriptor, ALL_PROFILES_CRON_PATH)

      if (Array.isArray(jobs)) {
        return jobs.filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === 'object')
      }
    } catch {
      // Dead or still-starting backend: try the source's next backend.
    }
  }

  return []
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The sources that are another backend than the front and than each other:
 *  a source is skipped when it IS the front connection, or when its install_id
 *  is the front's or an earlier source's (the same gateway registered twice,
 *  or the unpinned primary that is also a registry connection). */
export function otherCronSources(sources: readonly CronUnionSource[], front: CronUnionFront): CronUnionSource[] {
  const frontConnection = trimmed(front.connectionId)
  const seenBackends = new Set<string>()
  const frontBackend = trimmed(front.backendId)

  if (frontBackend) {
    seenBackends.add(frontBackend)
  }

  const others: CronUnionSource[] = []

  for (const source of sources) {
    if (!source.connectionId || source.connectionId === frontConnection) {
      continue
    }

    const backendId = trimmed(source.backendId)

    if (backendId) {
      if (seenBackends.has(backendId)) {
        continue
      }

      seenBackends.add(backendId)
    }

    others.push(source)
  }

  return others
}

/**
 * `base` is the front connection's own answer and is returned first and
 * untagged (its rows already belong to the connection the renderer named).
 * A non-array `base` (an error body) is returned unchanged: the union never
 * hides the front connection's failure.
 */
export async function mergeRegistryCronJobs(
  base: unknown,
  sources: readonly CronUnionSource[],
  getJson: GetJson,
  front: CronUnionFront
): Promise<unknown> {
  if (!Array.isArray(base)) {
    return base
  }

  const others = otherCronSources(sources, front)

  if (others.length === 0) {
    return base
  }

  const merged: unknown[] = [...base]
  const seen = new Set<string>()
  const reads = await Promise.all(others.map(source => readSourceJobs(source, getJson)))

  others.forEach((source, index) => {
    for (const job of reads[index]) {
      const identity = jobIdentity(source.connectionId, job)

      if (identity) {
        if (seen.has(identity)) {
          continue
        }

        seen.add(identity)
      }

      merged.push({ ...job, connection_id: source.connectionId })
    }
  })

  return merged
}
