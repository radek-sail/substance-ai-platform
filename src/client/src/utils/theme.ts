import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export type ThemeMode = 'light' | 'dark';

export const DEFAULT_THEME: ThemeMode = 'light';
export const THEME_STORAGE_KEY = 'sail-theme-mode';

/**
 * Resolves the initial theme mode, defaulting to 'light' unless 'dark' was explicitly saved.
 */
export function getInitialTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  try {
    const store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;
    const saved = store?.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') {
      return saved;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return DEFAULT_THEME;
}

/**
 * Persists the selected theme mode and updates document root attributes/classes.
 */
export function applyThemeToDocument(
  theme: ThemeMode,
  doc?: Document | null,
  storage?: Pick<Storage, 'setItem'> | null
): void {
  try {
    const store =
      storage !== undefined
        ? storage
        : typeof window !== 'undefined' && window.localStorage
        ? window.localStorage
        : null;
    store?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage write errors
  }

  const targetDoc = doc !== undefined ? doc : typeof document !== 'undefined' ? document : null;
  if (!targetDoc?.documentElement) return;

  const root = targetDoc.documentElement;
  root.setAttribute('data-theme', theme);
  root.classList.toggle('light', theme === 'light');
  root.classList.toggle('dark', theme === 'dark');
  if (root.style) {
    root.style.colorScheme = theme;
  }

  if (targetDoc.body) {
    targetDoc.body.setAttribute('data-theme', theme);
    targetDoc.body.classList.toggle('light', theme === 'light');
    targetDoc.body.classList.toggle('dark', theme === 'dark');
  }
}

/**
 * Returns the opposite theme mode ('light' <-> 'dark').
 */
export function getNextTheme(current: ThemeMode): ThemeMode {
  return current === 'light' ? 'dark' : 'light';
}

export interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: (next) => applyThemeToDocument(next),
  toggleTheme: () => {},
});

export const ThemeProvider: React.FC<{
  initialTheme?: ThemeMode;
  children: React.ReactNode;
}> = ({ initialTheme, children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => initialTheme ?? getInitialTheme());

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeMode) => {
    setThemeState(next);
    applyThemeToDocument(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = getNextTheme(prev);
      applyThemeToDocument(next);
      return next;
    });
  }, []);

  return React.createElement(
    ThemeContext.Provider,
    { value: { theme, setTheme, toggleTheme } },
    children
  );
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
