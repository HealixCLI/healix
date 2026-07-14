export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'healix:theme';

/** The app shipped as dark-only before this preference existed, so that stays the default. */
const DEFAULT_THEME: Theme = 'dark';

export function getStoredTheme(): Theme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : DEFAULT_THEME;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function setStoredTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}
