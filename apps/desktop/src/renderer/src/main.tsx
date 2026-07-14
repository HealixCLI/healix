import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, getStoredTheme } from './lib/theme';

// Applied before the first render so a saved light-mode preference doesn't
// flash the default dark theme (index.html) on launch.
applyTheme(getStoredTheme());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
