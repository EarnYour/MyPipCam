import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RecorderApp } from './RecorderApp'
import '../shared/styles.css'
import './recorder.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecorderApp />
  </StrictMode>,
)
