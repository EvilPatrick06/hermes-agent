import { beforeEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from './client'
import {
  cancelCronJobRun,
  deleteCronJob,
  getCronJob,
  getCronJobRuns,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from './cron'

beforeEach((): void => {
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { api: vi.fn().mockResolvedValue({ runs: [{ id: 'run-1' }] }) }
  })
  setApiRequestConnection('my-hermes')
  setApiRequestProfile('default')
})

const listedElsewhere = { connection_id: 'thornswood-bots', id: 'review/1', profile: 'bramble' }

const perJobCalls = [
  ['getCronJob', () => getCronJob(listedElsewhere)],
  ['getCronJobRuns', () => getCronJobRuns(listedElsewhere)],
  ['updateCronJob', () => updateCronJob(listedElsewhere, { enabled: false } as never)],
  ['pauseCronJob', () => pauseCronJob(listedElsewhere)],
  ['resumeCronJob', () => resumeCronJob(listedElsewhere)],
  ['triggerCronJob', () => triggerCronJob(listedElsewhere)],
  ['cancelCronJobRun', () => cancelCronJobRun(listedElsewhere)],
  ['deleteCronJob', () => deleteCronJob(listedElsewhere)]
] as const

it.each(perJobCalls)(
  "%s goes to the gateway that listed the job, under the job's own profile",
  async (_name: string, call: () => Promise<unknown>): Promise<void> => {
    await call()
    const [request] = vi.mocked(window.hermesDesktop.api).mock.calls[0]
    expect(request).toMatchObject({ connectionId: 'thornswood-bots', profile: 'bramble' })
    expect(request.path).toContain('/api/cron/jobs/review%2F1')
  }
)

it('an untagged job still belongs to the connection in front', async (): Promise<void> => {
  await pauseCronJob({ id: 'mine', profile: 'default' })
  await triggerCronJob('mine')

  for (const [request] of vi.mocked(window.hermesDesktop.api).mock.calls) {
    expect(request).toMatchObject({ connectionId: 'my-hermes', profile: 'default' })
  }
})

it("a listed job's runs are stamped with the job's connection, not the front one", async (): Promise<void> => {
  const runs = await getCronJobRuns(listedElsewhere)
  expect(runs[0]).toMatchObject({ connection_id: 'thornswood-bots', id: 'run-1' })

  const ownRuns = await getCronJobRuns('mine')
  expect(ownRuns[0]).toMatchObject({ connection_id: 'my-hermes', id: 'run-1' })
})
