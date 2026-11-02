/**
 * Tests for electron/cron-job-union.ts: the Scheduled jobs list across every
 * connected gateway, each job tagged with the connection that serves it.
 *
 * Run with: npx vitest run electron/cron-job-union.test.ts
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import { type CronUnionSource, isAllProfilesCronListRequest, mergeRegistryCronJobs, otherCronSources } from './cron-job-union'

const source = (connectionId: string, backendId?: string, descriptors = [connectionId]): CronUnionSource => ({
  backendId,
  backends: descriptors.map(descriptor => ({ descriptor })),
  connectionId
})

function jsonFrom(answers: Record<string, unknown>) {
  const calls: Array<{ descriptor: unknown; path: string }> = []

  const getJson = async (descriptor: unknown, path: string) => {
    calls.push({ descriptor, path })
    const answer = answers[String(descriptor)]

    if (answer instanceof Error) {
      throw answer
    }

    return answer
  }

  return { calls, getJson }
}

test('only a GET of the cross-profile list is the unified list', () => {
  assert.equal(isAllProfilesCronListRequest('GET', '/api/cron/jobs'), true)
  assert.equal(isAllProfilesCronListRequest(undefined, '/api/cron/jobs?profile=all'), true)
  assert.equal(isAllProfilesCronListRequest('get', '/api/cron/jobs/?profile=ALL'), true)
  assert.equal(isAllProfilesCronListRequest('GET', '/api/cron/jobs?profile=bramble'), false)
  assert.equal(isAllProfilesCronListRequest('POST', '/api/cron/jobs'), false)
  assert.equal(isAllProfilesCronListRequest('GET', '/api/cron/jobs/abc'), false)
  assert.equal(isAllProfilesCronListRequest('GET', '/api/cron/jobs/abc/runs'), false)
  assert.equal(isAllProfilesCronListRequest('GET', undefined), false)
})

test("another gateway's jobs join the front's, tagged with their connection", async () => {
  const front = [{ id: 'mine', profile: 'default' }]

  const { calls, getJson } = jsonFrom({
    'thornswood-bots': [
      { id: 'review-1', profile: 'bramble' },
      { id: 'review-2', profile: 'bramble' }
    ]
  })

  const merged = await mergeRegistryCronJobs(front, [source('thornswood-bots', 'b')], getJson, {
    backendId: 'a',
    connectionId: null
  })

  assert.deepEqual(merged, [
    { id: 'mine', profile: 'default' },
    { connection_id: 'thornswood-bots', id: 'review-1', profile: 'bramble' },
    { connection_id: 'thornswood-bots', id: 'review-2', profile: 'bramble' }
  ])
  assert.deepEqual(calls, [{ descriptor: 'thornswood-bots', path: '/api/cron/jobs?profile=all' }])
})

test('the front connection and backends already listed are not read again', () => {
  const sources = [
    source('my-hermes', 'vm-1'),
    source('thornswood-bots', 'vm-2'),
    source('same-gateway-again', 'vm-2'),
    source('local', 'one'),
    source('no-install-id')
  ]

  assert.deepEqual(
    otherCronSources(sources, { backendId: 'one', connectionId: 'my-hermes' }).map(s => s.connectionId),
    ['thornswood-bots', 'no-install-id']
  )
  assert.deepEqual(
    otherCronSources(sources, { backendId: null, connectionId: null }).map(s => s.connectionId),
    ['my-hermes', 'thornswood-bots', 'local', 'no-install-id']
  )
})

test('with no other gateway the front answer is returned as it is', async () => {
  const front = [{ id: 'mine' }]
  const { calls, getJson } = jsonFrom({})

  assert.equal(await mergeRegistryCronJobs(front, [], getJson, { connectionId: null }), front)
  assert.equal(await mergeRegistryCronJobs(front, [source('local')], getJson, { connectionId: 'local' }), front)
  assert.equal(calls.length, 0)
})

test("an error body from the front is never hidden behind other gateways' jobs", async () => {
  const failure = { detail: 'boom' }
  const { calls, getJson } = jsonFrom({ other: [{ id: 'x' }] })

  assert.equal(await mergeRegistryCronJobs(failure, [source('other')], getJson, { connectionId: null }), failure)
  assert.equal(calls.length, 0)
})

test("a dead backend falls to the source's next one, and a dead source adds nothing", async () => {
  const { getJson } = jsonFrom({
    'bots-a': new Error('ECONNREFUSED'),
    'bots-b': [{ id: 'review', profile: 'bramble' }],
    gone: new Error('timeout')
  })

  const merged = await mergeRegistryCronJobs(
    [],
    [source('thornswood-bots', undefined, ['bots-a', 'bots-b']), source('gone')],
    getJson,
    { connectionId: null }
  )

  assert.deepEqual(merged, [{ connection_id: 'thornswood-bots', id: 'review', profile: 'bramble' }])
})

test('each job is listed once per (connection, profile, id); "unknown" ids are never merged', async () => {
  const { getJson } = jsonFrom({
    bots: [
      { id: 'review', profile: 'bramble' },
      { id: 'review', profile: 'bramble' },
      { id: 'review', profile: 'rift' },
      { id: 'unknown' },
      { id: 'unknown' },
      null,
      'junk'
    ]
  })

  const merged = (await mergeRegistryCronJobs([], [source('bots')], getJson, { connectionId: null })) as unknown[]

  assert.deepEqual(merged, [
    { connection_id: 'bots', id: 'review', profile: 'bramble' },
    { connection_id: 'bots', id: 'review', profile: 'rift' },
    { connection_id: 'bots', id: 'unknown' },
    { connection_id: 'bots', id: 'unknown' }
  ])
})
