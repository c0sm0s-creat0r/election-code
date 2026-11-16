import { ApiError } from './api.js'

/**
 * One mapping, so every screen answers a status the same way. A 5xx message
 * is never shown.
 */
export function staffMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.'
  if (error.status === 0) return 'We could not reach the server. Check your connection and try again.'
  // On a gated screen a 401 or 403 means the session ended or has the wrong
  // role. The sign-in forms use signInMessage below.
  if (error.status === 401 || error.status === 403) {
    return 'Your session has ended. Please sign in again.'
  }
  if (error.status === 429) return 'Too many attempts. Please try again in a few minutes.'
  // Configuration. Retrying will not fix it.
  if (error.status === 503) {
    return 'This server is not fully set up yet. Contact whoever deployed it.'
  }
  // A 409 is a rule, not a failure. The API's wording states the rule.
  if (error.status === 409 || error.status === 400) return error.message
  return 'Something went wrong. Please try again.'
}

/** For the password forms, where a 401 means a wrong password. */
export function signInMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'That password was not recognised. Check it and try again.'
  }
  return staffMessage(error)
}
