import { test, expect } from '@playwright/test'
import { SLUG, USU_ID, SURNAME, CANDIDATE } from './seed.js'

/**
 * One test, with one purpose: **proving the browser actually sends the session
 * cookie**.
 *
 * Spec §1's shared-apex precondition fails silently. `SameSite` is judged by
 * registrable domain, so on mismatched hosts the cookie is simply never sent,
 * every authenticated request 401s, and it presents identically to a CORS
 * misconfiguration — for which the tempting fix, `origin: '*'`, reinstates a
 * closed hole. The blast radius is an entire AGM.
 *
 * jsdom cannot catch it, because jsdom is not a cookie jar with a `SameSite`
 * policy. A real browser is the only thing that can, which is why this one test
 * justifies a browser toolchain and a general e2e suite would not: the API
 * already has 399 integration tests.
 *
 * Cookies are not port-scoped, so `localhost:5173` and `localhost:8787` share a
 * jar and the registrable domain matches. That is precisely why auth is testable
 * here and not on preview URLs.
 */
test('the session cookie travels, and a ballot can be cast', async ({ page }) => {
  await page.goto(`/${SLUG}`)

  await page.getByLabel(/usu id/i).fill(USU_ID)
  await page.getByLabel(/surname/i).fill(SURNAME)
  await page.getByRole('button', { name: /continue/i }).click()

  // If the cookie did not travel, the run ends here: the ballot never appears
  // because the app is still on sign-in, or every later request 401s.
  await expect(page.getByRole('button', { name: `Add ${CANDIDATE}` })).toBeVisible()
  await page.getByRole('button', { name: `Add ${CANDIDATE}` }).click()
  await page.getByRole('button', { name: /submit ballot/i }).click()

  // A receipt means the ballot insert committed, which means the cookie was sent
  // on a POST as well as on sign-in.
  await expect(page.getByText(/your receipt/i)).toBeVisible()
  await expect(page.getByText(/is recorded/i)).toBeVisible()
})
