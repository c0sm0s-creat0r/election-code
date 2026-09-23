/**
 * "Help", beside sign out: the whole AGM, in order, for an officer who has never
 * run one here before. The order is the part that is not obvious — the roll has
 * to exist before anyone can be checked in, and a member has to be checked in
 * before they can vote.
 *
 * Out of the nav for the same reason sign out is: it is not a destination.
 *
 * A toggled panel rather than the `popover` attribute or a `<dialog>`: it needs
 * no focus trap (it is reading matter, not a form), and it keeps the nav usable
 * while it is open, so an officer can follow a step to its screen.
 */
import { useEffect, useId, useRef, useState } from 'react'

export function ElectionHelp({ base }: { base: string }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const wrapper = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onPointer = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div className="help" ref={wrapper}>
      <button
        type="button"
        className="help-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        Help
      </button>
      {open && (
        <div className="help-panel stack" id={panelId} role="region" aria-label="How to run an election">
          <h2>Running an election</h2>
          <ol className="help-steps">
            <li>
              Download the member roll from MyUSU.
            </li>
            <li>
              Upload the member roll in <strong>member roll</strong> tab here.
            </li>
            <li>
              Create the election.
            </li>
            <li>
              Set up the <strong>check-in desk.</strong> Give an exec volunteer the check-in desk link and password,
              where they can search each member by name or USU number and check them in.
            </li>
            <li>
              <strong>Open voting and run the AGM.</strong> Members sign in on their own phones with their USU number
              and surname. Only checked-in members can vote.
            </li>
            <li>
              <strong>Close voting.</strong> Closing is final: the count runs and the result is
              sealed.
            </li>
            <li>
              Share the result. Open the result from the election, and download
              records from <strong>exports</strong> tab, including attendance.
            </li>
          </ol>
          <button type="button" onClick={close}>Close</button>
        </div>
      )}
    </div>
  )
}
