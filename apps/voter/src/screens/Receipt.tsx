/**
 * The receipt: confirmation that a ballot of yours is recorded.
 *
 * **It never shows preferences**, and there is nothing to show — the API does not
 * return them. Australia deliberately has no voter receipt, because one that
 * proves *how* you voted lets you be paid or pressured for it, and society
 * elections with factions are not immune (spec §4). Confirming inclusion keeps
 * the "my vote wasn't counted" dispute solvable while remaining useless to a
 * coercer.
 */
import { useEffect, useState } from 'preact/hooks'
import { ApiError, getReceipt, voidReceipt } from '../api.js'

export type ReceiptProps = {
  token: string
  onVoided: () => void
}

type Loaded = { status: 'recorded' | 'voided'; election_name: string }

export function Receipt({ token, onVoided }: ReceiptProps) {
  const [receipt, setReceipt] = useState<Loaded | undefined>(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    getReceipt(token)
      .then((loaded) => { if (live) setReceipt(loaded) })
      .catch((caught: unknown) => {
        if (!live) return
        setError(
          caught instanceof ApiError && caught.status === 404
            ? 'We could not find that receipt. Check the code and try again.'
            : 'We could not check that receipt. Please try again.',
        )
      })
    return () => { live = false }
  }, [token])

  const voidBallot = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await voidReceipt(token)
      onVoided()
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 409
          ? 'That ballot can no longer be changed — voting has closed.'
          : 'We could not cancel that ballot. Please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="stack">
      <h2>Your receipt</h2>

      {error !== '' && (
        <p class="error" role="alert">
          {error}
        </p>
      )}

      {receipt && (
        <>
          <p>
            {receipt.status === 'recorded'
              ? `Your ballot for ${receipt.election_name} is recorded.`
              : `Your ballot for ${receipt.election_name} was cancelled (voided).`}
          </p>
          <p class="muted">
            The below is a unique key designed to serve as proof of your vote for largely contested elections (hopefully not this one).
          </p>
          <p class="receipt-token figures">{token}</p>

          {receipt.status === 'recorded' && (
            <button type="button" disabled={busy} onClick={voidBallot}>
              {busy ? 'Cancelling…' : 'Cancel this ballot and vote again'}
            </button>
          )}
        </>
      )}
    </section>
  )
}
