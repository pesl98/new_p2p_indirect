import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { useI18n } from './useI18n.js'
import './index.css'

function Root() {
  const { locale } = useI18n()
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
