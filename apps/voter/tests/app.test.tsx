import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'
import { App } from '../src/App.js'
import { json, stub, stubFetch, stubStorage } from './helpers.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.documentElement.style.removeProperty('--accent')
  document.title = ''
  setVisibility('visible')
})

/** jsdom's page is always visible. This simulates a locked phone. */
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

const BATCH = {
  id: 'b1', slug: 's', name: 'Soc',
  branding: { title: 'AGM 2026', org_name: 'Soc', accent_color: '#ff0000', logo_url: '' },
}

const election = (id: string, name: string) => ({
  id, name, seats: 1, status: 'open' as const,
  candidates: [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Bo' }],
})
const president = election('e1', 'President')
const secretary = election('e2', 'Secretary')

/**
 * Routes stubbed responses by URL: the society, a sign-in that always works,
 * and the election list. Assign `open` to change what the next poll sees.
 */
const stubRoutes = (open: unknown[], extra: (url: string) => Response | undefined = () => undefined) => {
  const api = { open }
  const spy = stubFetch((url) => extra(url) ?? json(200,
    url.includes('by-slug') ? BATCH : url.includes('voter/session') ? { first_name: 'Ada' } : api.open))
  return Object.assign(api, { spy })
}

/** The ballot and receipt routes, for a vote that is accepted. */
const voteAccepted = (url: string) =>
  url.includes('/ballots') ? json(200, { receipt_token: 'tok-1' })
    : url.includes('/receipts/') ? json(200, { status: 'recorded', election_name: 'President' })
      : undefined

const show = (slug = 's') => {
  window.history.pushState({}, '', `/${slug}`)
  render(<App />)
}

/**
 * Preact flushes effects on an animation frame, which the fake clock also
 * fakes. Three frames: fetch the society, start the poll, render the list.
 * Well under POLL_MS, so this is never a poll tick.
 */
const settle = async () => {
  for (let frame = 0; frame < 3; frame++) await vi.advanceTimersByTimeAsync(20)
}

const usuId = () => screen.getByLabelText(/usu id/i)

const fillSignIn = () => {
  fireEvent.input(usuId(), { target: { value: '2400001' } })
  fireEvent.input(screen.getByLabelText(/surname/i), { target: { value: 'Lovelace' } })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
}

const signIn = async () => {
  await waitFor(() => expect(usuId()).toBeTruthy())
  fillSignIn()
}

const voteButtons = () => screen.queryAllByRole('button', { name: 'Vote' })

/** From the agenda: open the first ballot, rank Bo and submit. */
const voteForBo = async () => {
  await waitFor(() => expect(voteButtons().length).toBeGreaterThan(0))
  fireEvent.click(voteButtons()[0]!)
  fireEvent.click(await screen.findByRole('button', { name: 'Add Bo' }))
  fireEvent.click(screen.getByRole('button', { name: /submit/i }))
}

describe('App', () => {
  it('LISTS SOCIETIES when the path has no slug, without repeating a name as its own subtitle', async () => {
    stub(200, [
      { slug: 's', name: 'Soc', branding: BATCH.branding },
      { slug: 't', name: 'Other', branding: { ...BATCH.branding, org_name: 'Other Inc' } },
    ])
    show('')
    // The whole card is one link. org_name usually equals name; showing both looks like a bug.
    const card = await screen.findByRole('link', { name: 'Soc' })
    expect(card.getAttribute('href')).toBe('/s')
    expect(screen.getByRole('link', { name: 'Other Other Inc' })).toBeTruthy()
  })

  it('SHOWS THE SOCIETY LOGO, resolved against the API and not this app', async () => {
    // A stored logo_url is root-relative to the API, a different origin.
    const branding = { ...BATCH.branding, logo_url: '/api/logos/batches/b1/abc.png' }
    stubRoutes([], (url) => (url.includes('by-slug') ? json(200, { ...BATCH, branding }) : undefined))
    show()
    await waitFor(() => expect(document.querySelector('img.society-logo')).toBeTruthy())
    expect(document.querySelector('img.society-logo')!.getAttribute('src'))
      .toBe('http://localhost:8787/api/logos/batches/b1/abc.png')
  })

  it('titles and colours the page from the society, with no image when it has no logo', async () => {
    stubRoutes([])
    show()
    await waitFor(() => expect(document.title).toBe('AGM 2026'))
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff0000')
    expect(document.querySelector('img.society-logo')).toBeNull()
  })

  it('says nothing is open yet, and does not ask the voter to reload', async () => {
    stubRoutes([])
    show()
    expect(await screen.findByText(/nothing is open for voting yet/i)).toBeTruthy()
    expect(screen.getByText(/auto refresh/i)).toBeTruthy()
  })

  it('lands on the agenda after sign-in, opens the ballot the voter picks, and lets them back out', async () => {
    stubRoutes([president, secretary])
    show()
    await signIn()
    await waitFor(() => expect(voteButtons()).toHaveLength(2))
    expect(screen.getByText('President')).toBeTruthy()
    expect(screen.getByText(/Ada/)).toBeTruthy()

    fireEvent.click(voteButtons()[1]!)
    expect(screen.getByRole('heading', { name: 'Secretary' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /all elections/i }))
    expect(voteButtons()).toHaveLength(2)
  })

  it('KEEPS THE DRAFT when a session lapses mid-ballot, and returns to it', async () => {
    const { spy } = stubRoutes([president, secretary], (url) =>
      url.includes('/ballots') ? json(401, { error: 'unauthenticated', code: 'no_session' }) : undefined)
    show()
    await signIn()
    await voteForBo()

    // thrown back to sign-in by the 401, then straight back into the ballot
    await signIn()
    await waitFor(() => expect(screen.getByTestId('ranked-0').textContent).toContain('Bo'))
    expect(spy.mock.calls.filter(([url]) => url.includes('voter/session'))).toHaveLength(2)
  })

  it('NEVER TELLS A VOTER THE MEETING IS OVER, only that nothing is open now', async () => {
    // Elections open one at a time. No open elections is not the end of the AGM.
    stubRoutes([president], voteAccepted)
    show()
    await signIn()
    await voteForBo()
    await screen.findByText('tok-1')
    fireEvent.click(screen.getByRole('button', { name: /back to elections/i }))

    expect(screen.getByText(/keep this page open/i)).toBeTruthy()
    expect(screen.queryByText(/that is every election/i)).toBeNull()
    expect(screen.queryByText(/thank you for voting/i)).toBeNull()
  })

  it('SHOWS AN ELECTION OPENED AFTER LOAD, without a reload', async () => {
    // A draft is hidden from voters, so the next item arrives only by polling.
    vi.useFakeTimers()
    const api = stubRoutes([president])
    show()
    await settle()
    fillSignIn()
    await settle()
    expect(screen.queryByText('Secretary')).toBeNull()

    // The chair opens the next item.
    api.open = [president, secretary]
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByText('Secretary')).toBeTruthy()
  })

  it('KEEPS THE LAST LIST when a poll fails, rather than emptying the agenda', async () => {
    // one timed-out request must not show "nothing is open"
    vi.useFakeTimers()
    let failing = false
    stubRoutes([president], (url) => {
      if (failing && url.endsWith('/elections')) throw new TypeError('network down')
      return undefined
    })
    show()
    await settle()
    fillSignIn()
    await settle()
    expect(screen.getByText('President')).toBeTruthy()

    failing = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(screen.getByText('President')).toBeTruthy()
    expect(screen.queryByText(/nothing is open/i)).toBeNull()
    expect(screen.getByText(/could not check for new elections/i)).toBeTruthy()
  })

  it('STOPS CHECKING while the screen is off, and CHECKS AT ONCE when the voter comes back', async () => {
    // locked phones must not keep polling
    vi.useFakeTimers()
    const api = stubRoutes([])
    show()
    await settle()
    expect(screen.getByText(/nothing is open for voting yet/i)).toBeTruthy()

    const polls = () => api.spy.mock.calls.filter(([url]) => url.endsWith('/elections')).length
    setVisibility('hidden')
    const before = polls()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(polls()).toBe(before)

    // Opened while the phone was locked: the waiting notice becomes sign-in on unlock.
    api.open = [president]
    setVisibility('visible')
    await settle()
    expect(usuId()).toBeTruthy()
  })

  it('MARKS AN ELECTION VOTED ACROSS A RELOAD, and still offers the receipt', async () => {
    // The stored token is how the app knows this voter has voted.
    stubStorage({ 'election:receipts:b1': JSON.stringify({ e1: 'tok-1' }) })
    stubRoutes([president], voteAccepted)
    show()
    await signIn()
    const voted = await screen.findByRole('button', { name: /voted/i })
    expect(voteButtons()).toHaveLength(0)
    fireEvent.click(voted)
    expect(await screen.findByText('tok-1')).toBeTruthy()
  })

  it('reports a society that does not exist', async () => {
    stub(404, { error: 'not found' })
    show('nope')
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not find/i)
  })
})
