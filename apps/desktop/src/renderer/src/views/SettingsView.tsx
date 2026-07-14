import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { getStoredTheme, setStoredTheme, type Theme } from '../lib/theme';
import { ProvidersView } from './ProvidersView';

function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  const onCheckedChange = (checked: boolean) => {
    const next: Theme = checked ? 'dark' : 'light';
    setStoredTheme(next);
    setTheme(next);
  };

  return (
    <section className="mx-auto max-w-4xl px-8 pt-8">
      <h2 className="mb-3 text-sm font-semibold text-muted">Appearance</h2>
      <Card className="max-w-md">
        <CardContent className="flex items-center justify-between pt-4">
          <div className="flex items-center gap-3">
            {theme === 'dark' ? (
              <Moon className="h-4 w-4 text-muted" />
            ) : (
              <Sun className="h-4 w-4 text-muted" />
            )}
            <div>
              <Label htmlFor="theme-toggle" className="text-sm font-medium text-fg">
                Dark mode
              </Label>
              <p className="text-xs text-muted">
                {theme === 'dark' ? 'Dark theme is on.' : 'Light theme is on.'}
              </p>
            </div>
          </div>
          <Switch
            id="theme-toggle"
            checked={theme === 'dark'}
            onCheckedChange={onCheckedChange}
            aria-label="Toggle dark mode"
          />
        </CardContent>
      </Card>
    </section>
  );
}

/**
 * Settings. Reached from the pinned bottom nav entry — not the app's landing
 * screen. Provider connection/auth (previously the opening screen) now lives
 * here as its primary section.
 */
export function SettingsView() {
  return (
    <div>
      <AppearanceSection />
      <ProvidersView />
    </div>
  );
}
