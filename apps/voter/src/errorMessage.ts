import { ApiError } from './api.js'

/**
 * Turns an `ApiError` into a message a voter can act on. A 401 is vague on
 * purpose: a wrong surname and an unknown id look the same. A 403 says what
 * to do. A 5xx message is never shown.
 */
export function signInMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.'
  if (error.status === 0) return 'We could not reach the server. Check your connection and try again.'
  if (error.status === 401) return 'Check your USU id and surname and try again.'
  if (error.status === 403 && error.code === 'not_checked_in') {
    return 'You are not checked in yet. Please see the check-in desk.'
  }
  if (error.status === 403 && error.code === 'ineligible') {
    return 'Our records show your membership has ended. Please see the check-in desk.'
  }
  if (error.status === 429) return 'Too many attempts. Please try again in a few minutes.'
  if (error.status === 503) return 'Voting is not available right now. Please tell an officer.'
  return 'Something went wrong. Please try again.'
}
