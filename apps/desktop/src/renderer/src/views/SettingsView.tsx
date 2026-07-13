import { ProvidersView } from './ProvidersView';

/**
 * Settings. Reached from the pinned bottom nav entry — not the app's landing
 * screen. Provider connection/auth (previously the opening screen) now lives
 * here as its primary section.
 */
export function SettingsView() {
  return <ProvidersView />;
}
