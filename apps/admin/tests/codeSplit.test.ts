import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A source-level guard on the code split. Every screen must stay a dynamic
 * import. A static import puts it in the entry chunk, and nothing else fails.
 */
// From the working directory: under jsdom, import.meta.url is an http:// URL.
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
 * Reachability. A unit-tested screen can still be mounted on no route and
 * linked from nowhere, so these check the wiring.
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
    // The door is a full navigation, not a tab: its own chunk and password.
    expect(layoutSource).toContain('/door')
  })

  it('lets an officer reach registration from the landing screen', () => {
    const landing = readFileSync(resolve(process.cwd(), 'src/screens/Landing.tsx'), 'utf8')
    expect(landing).toContain('to="/new"')
  })

  it('builds officer links from the slug, because the routes are /b/:slug', () => {
    // the result link must use the slug; no route matches the batch id
    for (const source of [appSource, layoutSource]) {
      const links = [...source.matchAll(/(?:to|href)=\{`([^`]+)`\}/g)].map((m) => m[1]!)
      for (const link of links.filter((l) => l.startsWith('/b/'))) {
        expect(link, `${link} should interpolate a slug`).toMatch(/^\/b\/\$\{[^}]*slug[^}]*\}/)
      }
    }
  })
})

/**
 * The inverse, for the one screen that must stay unreachable. `/operator`
 * deletes societies. The API key is the control, but a link would show the
 * screen to every officer. The route exists and nothing navigates to it.
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
