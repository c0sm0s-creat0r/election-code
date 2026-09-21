import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
