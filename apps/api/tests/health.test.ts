import { describe, it, expect } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import worker from '../src/index.js'
import { api } from './helpers.js'

describe('health and the error contract', () => {
  it('reports ok', async () => {
    const res = await api('GET', '/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('404s an unknown route as JSON, not HTML', async () => {
    const res = await api('GET', '/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
  })

  it('answers an unhandled error as JSON that says nothing about it', async () => {
    // No database: the handler throws. The frontend must still be able to
    // res.json() the response.
    const ctx = createExecutionContext()
    const res = await worker.fetch(
      new Request('https://example.com/api/batches'), { ...env, DB: undefined as unknown as D1Database }, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal' })
  })
})
