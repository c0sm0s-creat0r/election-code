/**
 * A society's logo, or nothing. `alt=""`: the name is always beside it.
 * `logoSrc` resolves the stored URL against the API.
 */
import { logoSrc, type Branding } from '../api.js'

export function SocietyLogo({ branding }: { branding: Branding }) {
  const src = logoSrc(branding.logo_url)
  if (src === '') return null
  return <img className="society-logo" src={src} alt="" />
}
