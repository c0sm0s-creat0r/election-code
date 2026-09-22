import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-level guard on the code split.
 *
 * The door desk and the officer screens are lazy so that a volunteer's phone
 * fetches the door chunk and not the rounds table, and the officer's laptop does
 * not fetch the door. That split is invisible at runtime and silently undone by a
 * single static import — someone adds `import { Result } from './screens/Result'`
 * to fix a type, and every route loads everything again with no test failing and
 * no error anywhere.
 *
 * Verified against the built output while writing this: with only the door lazy,
 * the entry chunk still carried the officer screens, so the door phone parsed them
 * anyway. This test pins the fix.
 */
// Resolved from the working directory, not from import.meta.url: under the jsdom
// environment that is an http:// URL and readFileSync rejects it.
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')

const staticImportsFrom = (source: string): string[] =>
  [...source.matchAll(/^import\s[^']*'(\.[^']+)'/gm)].map((match) => match[1]!)

describe('code splitting', () => {
  it('loads every screen dynamically, never as a static import', () => {
    const offenders = staticImportsFrom(appSource).filter(
      (specifier) => specifier.includes('/screens/') || specifier.includes('/door/'),
    )
    expect(offenders, `static imports pull these back into the entry chunk: ${offenders.join(', ')}`)
      .toEqual([])
  })

  it('keeps the door behind its own dynamic import', () => {
    expect(appSource).toMatch(/import\(['"]\.\/door\/index\.js['"]\)/)
  })

  it('wraps the lazy routes in a Suspense boundary', () => {
    // Without one, React throws as soon as a lazy route is reached.
    expect(appSource).toMatch(/<Suspense/)
  })
})

/**
 * Reachability, as a test.
 *
 * Elections management was once written, fully tested, and wired to nothing: no
 * route mounted it and the officer's menu never linked to it, so an officer could
 * not create an election at all. Every unit test passed, because each rendered its
 * screen directly. These assertions are the cheapest thing that would have caught
 * it, and they moved with the nav when it moved into OfficerLayout.
 */
describe('officer screens are reachable', () => {
  const layoutSource = readFileSync(resolve(process.cwd(), 'src/OfficerLayout.tsx'), 'utf8')

  it('mounts every officer screen on a route', () => {
    for (const screenName of ['Elections', 'RollImport', 'Exports', 'Settings', 'Result']) {
      expect(appSource, `${screenName} is never rendered`).toMatch(new RegExp(`<${screenName}\\b`))
    }
    for (const screenName of ['Landing', 'SignUp']) {
      expect(appSource, `${screenName} is never rendered`).toMatch(new RegExp(`<${screenName}\\b`))
    }
  })

  it('offers every destination in the always-visible nav', () => {
    for (const to of ['elections', 'roll', 'exports', 'settings']) {
      expect(layoutSource, `nav has no entry for ${to}`).toContain(`to: '${to}'`)
    }
    // The door is a full navigation, not a tab: separate chunk, separate password.
    expect(layoutSource).toContain('/door')
  })

  it('lets an officer reach registration from the landing screen', () => {
    const landing = readFileSync(resolve(process.cwd(), 'src/screens/Landing.tsx'), 'utf8')
    expect(landing).toContain('to="/new"')
  })

  it('builds officer links from the slug, because the routes are /b/:slug', () => {
    // An earlier version built the result link from the batch id, which no route
    // matches — the sort of thing only an integration test or a human notices.
    for (const source of [appSource, layoutSource]) {
      const links = [...source.matchAll(/(?:to|href)=\{`([^`]+)`\}/g)].map((m) => m[1]!)
      for (const link of links.filter((l) => l.startsWith('/b/'))) {
        expect(link, `${link} should interpolate a slug`).toMatch(/^\/b\/\$\{[^}]*slug[^}]*\}/)
      }
    }
  })
})

/**
 * The inverse of reachability, for the one screen that must stay unreachable.
 *
 * `/operator` deletes societies, including their sealed results. The API gate is
 * `SUPER_ADMIN_KEY` and that is the real control — but a link on the landing page
 * or in the officer nav would put the most destructive screen in the system in
 * front of every officer, and adding one would look like a tidy-up rather than a
 * regression. So it is asserted: the route exists, and nothing navigates to it.
 */
describe('the operator screen is deliberately unlinked', () => {
  const sourceFiles = readdirSync(resolve(process.cwd(), 'src'), { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && /\.tsx?$/.test(entry))

  it('is mounted on a route', () => {
    expect(appSource).toMatch(/path="\/operator"/)
    expect(appSource).toMatch(/<Operator\b/)
  })

  it('is loaded dynamically, like every other screen', () => {
    expect(appSource).toMatch(/import\(['"]\.\/screens\/Operator\.js['"]\)/)
  })

  it('is linked from nowhere', () => {
    const offenders = sourceFiles.filter((file) => {
      const source = readFileSync(resolve(process.cwd(), 'src', file), 'utf8')
      return /(?:to|href)=\{?["'`]\/operator/.test(source)
    })
    expect(offenders, `these link to the operator screen: ${offenders.join(', ')}`).toEqual([])
  })
})
