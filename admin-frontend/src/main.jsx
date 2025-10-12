import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import App from './App'
import BatchDetailPage from './BatchDetailPage'

function FallbackPage() {
  return (
    <div>
      <h2>Page Not Found</h2>
      <p>
        Click here to head to the <Link to="/">main page</Link>.
      </p>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/batch/:batchSlug" element={<BatchDetailPage />} />
        <Route path="*" element={<FallbackPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
