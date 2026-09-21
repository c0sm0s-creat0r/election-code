import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@election/styles/tokens.css'
import '@election/styles/base.css'
import './app.css'
import { App } from './App.js'

const root = document.getElementById('app')
if (!root) throw new Error('#app is missing from index.html')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
