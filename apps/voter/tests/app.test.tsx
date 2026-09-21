import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/preact'
import { App } from '../src/App.js'

describe('App', () => {
  it('renders without a batch slug in the path', () => {
    render(<App />)
    expect(screen.getByRole('heading')).toBeTruthy()
  })
})
