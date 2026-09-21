import { ApiError } from './api.js'

/**
 * Turns an `ApiError` into something a voter can act on.
 *
 * The API distinguishes its refusals with a `code` precisely so this mapping can
 * exist (spec §3): a 401 is deliberately vague, because a wrong surname and an
 * unknown id must be indistinguishable, while a 403 says what to do, because both
 * of its causes are fixable at the door and "unauthorized" in a queue tells a
 * volunteer nothing.
 *
 * Nothing here prints the server's message for a 5xx. Those messages are about
 * configuration and a caller has no business reading them.
 */
export function signInMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.'
  if (error.status === 0) return 'We could not reach the server. Check your connection and try again.'
  if (error.status === 401) return 'Check your USU id and surname and try again.'
  if (error.status === 403 && error.code === 'not_checked_in') {
    return 'You are not checked in yet. Please see the door desk.'
  }
  if (error.status === 403 && error.code === 'ineligible') {
    return 'Our records show your membership has ended. Please see the door desk.'
  }
  if (error.status === 429) return 'Too many attempts. Please try again in a few minutes.'
  return 'Something went wrong. Please try again.'
}
