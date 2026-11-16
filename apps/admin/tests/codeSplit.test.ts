import { it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// From the working directory: under jsdom, import.meta.url is an http:// URL.
const read = (file: string) => readFileSync(resolve(process.cwd(), 'src', file), 'utf8')

/**
 * A source-level guard on the code split. A static import puts a screen in
 * the entry chunk, and nothing else fails.
 */
it('loads every screen dynamically, never as a static import', () => {
  // The two files the entry chunk routes from.
  const offenders = ['App.tsx', 'OfficerLayout.tsx'].flatMap((file) =>
    [...read(file).matchAll(/^import\s[^']*'(\.[^']+)'/gm)]
      .map((match) => match[1]!)
      .filter((specifier) => specifier.includes('/screens/') || specifier.includes('/door/'))
      .map((specifier) => `${file}: ${specifier}`))
  expect(offenders, `static imports pull these into the entry chunk: ${offenders.join(', ')}`)
    .toEqual([])
})

/**
 * `/operator` deletes societies. The API key is the control, but a link would
 * show the screen to every officer. The route exists and nothing navigates to it.
 */
it('routes the operator screen, and links to it from nowhere', () => {
  expect(read('App.tsx')).toMatch(/path="\/operator"/)
  const offenders = readdirSync(resolve(process.cwd(), 'src'), { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && /\.tsx?$/.test(entry))
    .filter((file) => /(?:to|href)=\{?["'`]\/operator/.test(read(file)))
  expect(offenders, `these link to the operator screen: ${offenders.join(', ')}`).toEqual([])
})
