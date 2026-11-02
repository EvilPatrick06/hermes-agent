import { beforeEach, describe, expect, it } from 'vitest'

import {
  $cronJobs,
  beginCronJobsRequest,
  commitCronJobsRequest,
  cronJobKey,
  setCronJobs,
  updateCronJobs,
  withListedConnection
} from './cron'

const oldJob = { id: 'old' } as never
const newJob = { id: 'new' } as never

describe('cron jobs request fencing', () => {
  beforeEach(() => {
    setCronJobs([])
  })

  it('rejects an older refresh after a newer refresh commits', () => {
    const older = beginCronJobsRequest('all')
    const newer = beginCronJobsRequest('all')

    expect(commitCronJobsRequest(newer, [newJob])).toBe(true)
    expect(commitCronJobsRequest(older, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([newJob])
  })

  it('rejects a refresh from the previous profile scope', () => {
    const work = beginCronJobsRequest('work')

    beginCronJobsRequest('personal')

    expect(commitCronJobsRequest(work, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([])
  })

  it('rejects an in-flight poll after a local mutation', () => {
    const poll = beginCronJobsRequest('all')

    updateCronJobs(() => [newJob])

    expect(commitCronJobsRequest(poll, [oldJob])).toBe(false)
    expect($cronJobs.get()).toEqual([newJob])
  })
})

describe('jobs from more than one gateway', () => {
  it('keeps two gateways\' jobs with one id apart', () => {
    expect(cronJobKey({ id: 'review' })).not.toBe(cronJobKey({ connection_id: 'thornswood-bots', id: 'review' }))
    expect(cronJobKey({ connection_id: 'a', id: 'review' })).toBe(cronJobKey({ connection_id: 'a', id: 'review' }))
  })

  it("keeps the listing's connection on a row its own backend sent back", () => {
    const updated = { id: 'review', state: 'paused' } as never

    expect(withListedConnection({ connection_id: 'thornswood-bots' }, updated)).toEqual({
      connection_id: 'thornswood-bots',
      id: 'review',
      state: 'paused'
    })
    expect(withListedConnection({}, updated)).toBe(updated)
  })
})
