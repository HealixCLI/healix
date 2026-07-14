/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Backed by CSS variables (see index.css) so each token flips between its
        // light and dark value with the `.dark` class, while still supporting
        // Tailwind's `/opacity` modifiers (e.g. `bg-panel/60`).
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        well: 'rgb(var(--color-well) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        fg: 'rgb(var(--color-fg) / <alpha-value>)',
        // Brand green — matches the Healix leaf gradient.
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        // Cool blue for in-progress / informational states, so green stays
        // reserved for brand + success.
        info: 'rgb(var(--color-info) / <alpha-value>)',
        ok: 'rgb(var(--color-ok) / <alpha-value>)',
        warn: 'rgb(var(--color-warn) / <alpha-value>)',
        err: 'rgb(var(--color-err) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['ui-sans-serif', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
