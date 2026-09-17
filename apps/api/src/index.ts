import { Hono } from 'hono'

export type Env = {
  DB: D1Database
  SUPER_ADMIN_KEY: string
  SESSION_SECRET: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.notFound((c) => c.json({ error: 'not found' }, 404))

export default app
