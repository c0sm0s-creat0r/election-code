/**
 * A society's own logo, or nothing at all — never a placeholder.
 *
 * `alt=""` on purpose: the society's name is always rendered beside it, so a
 * screen reader that announced the image would read the name twice. `logoSrc`
 * is what makes it load at all — a stored `logo_url` is root-relative to the
 * *API*, not to this app.
 */
import { logoSrc, type Branding } from '../api.js'

export function SocietyLogo({ branding }: { branding: Branding }) {
  const src = logoSrc(branding.logo_url)
  if (src === '') return null
  return <img className="society-logo" src={src} alt="" />
}
