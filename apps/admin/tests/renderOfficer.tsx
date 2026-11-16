import { render } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router'
import type { ReactElement } from 'react'
import type { Batch } from '../src/api.js'
import type { OfficerContext } from '../src/OfficerLayout.js'

export const testBatch: Batch = {
  id: 'b1',
  slug: 'soc',
  name: 'Test Society',
  branding: { title: 'AGM', org_name: 'Test Society', accent_color: '#000000', logo_url: '' },
}

/** Renders a component that needs a router, without the whole app. */
export const renderRouted = (element: ReactElement, at = '/') =>
  render(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>)

/**
 * Renders an officer screen inside a route that supplies the outlet context,
 * as OfficerLayout does. A plain `render` would throw.
 */
export const renderOfficerScreen = (element: ReactElement, at = '/b/soc/elections') =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="/b/:slug"
          element={<Outlet context={{ batch: testBatch } satisfies OfficerContext} />}
        >
          <Route path="elections" element={element} />
          <Route path="roll" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
