/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0e',
        panel: '#131318',
        well: '#0d0d12',
        border: '#26262e',
        muted: '#8a8a96',
        fg: '#e7e7ea',
        // Brand green — matches the Healix leaf gradient.
        accent: '#46c878',
        // Cool blue for in-progress / informational states, so green stays
        // reserved for brand + success.
        info: '#6ca5f2',
        ok: '#3fb950',
        warn: '#d29922',
        err: '#f85149',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['ui-sans-serif', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
