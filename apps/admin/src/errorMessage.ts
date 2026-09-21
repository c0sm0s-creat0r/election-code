import { ApiError } from './api.js'

/**
 * One mapping, so every screen answers the same status the same way.
 *
 * Nothing here prints a 5xx message: those are about configuration and an
 * operator reads them in the Worker's logs, not in a dialog during an AGM.
 */
export function staffMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.'
  if (error.status === 0) return 'We could not reach the server. Check your connection and try again.'
  if (error.status === 401) return 'That password was not recognised. Check it and try again.'
  if (error.status === 403) return 'That session does not have permission to do this.'
  if (error.status === 429) return 'Too many attempts. Please try again in a few minutes.'
  // A 409 is a rule, not a failure, and the API's wording states the rule.
  if (error.status === 409 || error.status === 400) return error.message
  return 'Something went wrong. Please try again.'
}
