import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App'
import BatchNavigation from './Navigation'
// createRoot(document.getElementById('root')).render(<App />)

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* root bage is to show list of batches */}
        <Route path="/" element={<BatchNavigation />} />
        {/* path-based batch slug for example /dsa-elections */}
        <Route path="/:batchSlug" element={<App />} />
        {/* default to page not found */}
        <Route path="*" element={<div>
            <h2>ERROR 404 - Page Not Found</h2>
            <p>
                Click here to head to the <Link to="/">main page</Link>.
            </p>
        </div>} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
