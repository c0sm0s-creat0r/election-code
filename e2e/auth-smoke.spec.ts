import { test, expect } from '@playwright/test'
import { SLUG, USU_ID, SURNAME, CANDIDATE } from './seed.js'

/**
 * One test: the browser sends the session cookie.
 *
 * `SameSite` is judged by registrable domain. On mismatched hosts the cookie
 * is not sent, every authenticated request 401s, and it looks like a CORS
 * problem (spec §1). jsdom has no cookie policy, so this needs a real browser.
 *
 * Cookies are not port-scoped, so `localhost:5173` and `localhost:8787` share
 * a jar. Preview URLs do not.
 */
test('the session cookie travels, and a ballot can be cast', async ({ page }) => {
  await page.goto(`/${SLUG}`)

  await page.getByLabel(/usu id/i).fill(USU_ID)
  await page.getByLabel(/surname/i).fill(SURNAME)
  await page.getByRole('button', { name: /continue/i }).click()

  // Sign-in lands on the list of open elections. The voter picks one.
  await page.getByRole('button', { name: 'Vote' }).click()

  // No cookie, no ballot.
  await expect(page.getByRole('button', { name: `Add ${CANDIDATE}` })).toBeVisible()
  await page.getByRole('button', { name: `Add ${CANDIDATE}` }).click()
  await page.getByRole('button', { name: /submit ballot/i }).click()

  // A receipt means the cookie was also sent on a POST.
  await expect(page.getByText(/your receipt/i)).toBeVisible()
  await expect(page.getByText(/is recorded/i)).toBeVisible()
})
