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
  // On a gated screen a 401 or 403 means the session ended or is the wrong role,
  // never that a password was mistyped — there is no password field in sight. The
  // sign-in forms use signInMessage below, where 401 does mean the password.
  if (error.status === 401 || error.status === 403) {
    return 'Your session has ended. Please sign in again.'
  }
  if (error.status === 429) return 'Too many attempts. Please try again in a few minutes.'
  // Configuration, not something the officer can fix by retrying.
  if (error.status === 503) {
    return 'This server is not fully set up yet. Contact whoever deployed it.'
  }
  // A 409 is a rule, not a failure, and the API's wording states the rule.
  if (error.status === 409 || error.status === 400) return error.message
  return 'Something went wrong. Please try again.'
}

/** For the password forms, where a 401 genuinely is the password. */
export function signInMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'That password was not recognised. Check it and try again.'
  }
  return staffMessage(error)
}
