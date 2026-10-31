export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_STORAGE_KEY = 'dispatch-theme';

// Runs inline in each page's <head> (vite.config.ts injects it) so a stored
// choice applies before first paint. `?theme=dark` previews a theme for one
// page view without storing it. Kept as a string: it never goes through the
// bundle.
export const THEME_BOOT_SCRIPT = `try{var q=new URLSearchParams(location.search).get('theme');var t=q||localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

export function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  try {
    if (theme === 'dark') localStorage.setItem(THEME_STORAGE_KEY, theme);
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: the choice holds for this page view only.
  }
}
