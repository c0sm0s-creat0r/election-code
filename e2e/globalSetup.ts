import seed from './seed.js'

/**
 * Runs once, after `webServer` has both servers up and before any test. Seeding
 * through the real API rather than raw SQL means no password hashes to paste and
 * no fixture to drift out of step with the schema.
 */
export default async function globalSetup(): Promise<void> {
  await seed()
}
