import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('package scaffold', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('1.0.0')
  })

  it('has crypto.subtle available without an import', () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
  })
})
