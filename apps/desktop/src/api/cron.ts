import { stampRowsWithOwningConnection } from '@/lib/session-owner-stamp'
import type {
  AutomationBlueprint,
  CronCancelResult,
  CronDeliveryTarget,
  CronJob,
  CronJobCreatePayload,
  CronJobUpdates,
  SessionInfo
} from '@/types/hermes'

import {
  connectionScoped,
  getApiRequestConnection,
  hermesApi,
  ownerScoped,
  profileScoped,
  STARTUP_REQUEST_TIMEOUT_MS
} from './client'

// The cron trigger endpoint intentionally waits for the whole job so its
// response reflects the persisted execution result. Agent jobs can run far
// longer than the Electron fetch default; keep this override local to the one
// synchronous long-operation endpoint rather than weakening all API timeouts.
const CRON_TRIGGER_REQUEST_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** A job the caller holds: its id alone (the connection in front owns it), or
 *  the listed row, whose `connection_id` names the registry gateway that
 *  serves it when the unified list spliced it in from another connection. */
export type CronJobRef = Pick<CronJob, 'connection_id' | 'id' | 'profile'> | string

const cronJobId = (job: CronJobRef): string => (typeof job === 'string' ? job : job.id)

/** The registry connection that listed `job`; empty for the connection in front. */
const listedConnection = (job: CronJobRef): string =>
  typeof job === 'string' ? '' : String(job.connection_id ?? '').trim()

/** The connection a job's runs belong to, for stamping their rows. */
function cronJobConnection(job: CronJobRef): null | string {
  return listedConnection(job) || getApiRequestConnection()
}

/** Every per-job call goes to the backend that listed the job. A job spliced
 *  in from another connection carries that connection and its own profile; an
 *  untagged one belongs to the connection in front, as before. */
function cronJobScope(job: CronJobRef): { connectionId?: string; priority?: 'foreground'; profile?: string } {
  const connectionId = listedConnection(job)

  if (!connectionId || typeof job === 'string') {
    return { ...profileScoped(), ...connectionScoped() }
  }

  return ownerScoped({ connectionId, profile: job.profile || undefined })
}

// Cron jobs are stored per-profile (<HERMES_HOME>/cron/jobs.json), and the
// backend's list endpoint defaults to 'all'. Pass a concrete profile key to
// list just that profile's jobs, or 'all' for the unified cross-profile view.
// Omitting the arg keeps the legacy 'all' default for non-profile callers.
// profileScoped() still rides along for backend-process routing.
export function getCronJobs(profile?: string): Promise<CronJob[]> {
  const suffix = profile ? `?profile=${encodeURIComponent(profile)}` : ''

  return hermesApi<CronJob[]>({
    ...profileScoped(),
    ...connectionScoped(),
    path: `/api/cron/jobs${suffix}`,
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })
}

export function getCronJob(job: CronJobRef): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}`
  })
}

export async function getCronJobRuns(job: CronJobRef, limit = 20): Promise<SessionInfo[]> {
  const { runs } = await hermesApi<{ runs: SessionInfo[] }>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}/runs?limit=${limit}`
  })

  // Run rows are backend-returned sessions like any other page, so they carry
  // the same ownership contract: tag each with the registry connection that
  // served it so a later resume can name the backend that actually holds the
  // run. Without the tag the row's bare (or backend-only) profile is not an
  // exact owner, and clicking a run — especially over SSH/remote, where the
  // run lives on a host the local pool has never seen — fell to the ambient
  // id-only resume and the transcript never loaded (#82527). The backend
  // stamps `profile` (the job's owning profile); this adds the connection
  // half, exactly as /api/sessions and the sidebar slices do.
  return stampRowsWithOwningConnection(runs ?? [], cronJobConnection(job))
}

// The single source of truth for cron delivery targets (local + configured
// gateways). Both the manual cron editor and the blueprint dialog use this so
// they never offer a platform that isn't connected. Mirrors the dashboard.
export async function getCronDeliveryTargets(): Promise<CronDeliveryTarget[]> {
  const { targets } = await hermesApi<{ targets: CronDeliveryTarget[] }>({
    ...profileScoped(),
    ...connectionScoped(),
    path: '/api/cron/delivery-targets'
  })

  return targets ?? []
}

export function createCronJob(body: CronJobCreatePayload): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...profileScoped(),
    ...connectionScoped(),
    path: '/api/cron/jobs',
    method: 'POST',
    body
  })
}

export function updateCronJob(job: CronJobRef, updates: CronJobUpdates): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}`,
    method: 'PUT',
    body: { updates }
  })
}

export function pauseCronJob(job: CronJobRef): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}/pause`,
    method: 'POST'
  })
}

export function resumeCronJob(job: CronJobRef): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}/resume`,
    method: 'POST'
  })
}

export function triggerCronJob(job: CronJobRef): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}/trigger`,
    method: 'POST',
    timeoutMs: CRON_TRIGGER_REQUEST_TIMEOUT_MS
  })
}

// Asks the job's live run to stop; the run books a 'cancelled' attempt at its next cancel
// check (a second or two), so callers poll the job list for the ledger to settle.
export function cancelCronJobRun(job: CronJobRef): Promise<CronCancelResult> {
  return hermesApi<CronCancelResult>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}/cancel`,
    method: 'POST'
  })
}

export function deleteCronJob(job: CronJobRef): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...cronJobScope(job),
    path: `/api/cron/jobs/${encodeURIComponent(cronJobId(job))}`,
    method: 'DELETE'
  })
}

// Automation Blueprints — parameterized cron templates the backend serves from
// cron/blueprint_catalog.py. getAutomationBlueprints returns the gallery
// (deliver options already rewritten to this machine's configured gateways);
// instantiateAutomationBlueprint fills the slots and creates a real cron job via
// the same create_job path as createCronJob.
//
// Both calls name the target profile via ?profile=: the catalog is per profile
// (built-ins plus that profile's plugin-registered blueprints, deliver options
// from its gateways), and instantiate creates the job in that profile. Fetch the
// catalog for the same profile you instantiate into. Mirrors the dashboard's api.ts.
export function getAutomationBlueprints(profile: string): Promise<{ blueprints: AutomationBlueprint[] }> {
  return hermesApi<{ blueprints: AutomationBlueprint[] }>({
    ...profileScoped(),
    ...connectionScoped(),
    path: `/api/cron/blueprints?profile=${encodeURIComponent(profile)}`,
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })
}

export function instantiateAutomationBlueprint(
  body: { blueprint: string; values: Record<string, string> },
  profile: string
): Promise<CronJob> {
  return hermesApi<CronJob>({
    ...profileScoped(),
    ...connectionScoped(),
    path: `/api/cron/blueprints/instantiate?profile=${encodeURIComponent(profile)}`,
    method: 'POST',
    body
  })
}
