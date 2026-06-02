import { useCallback, useEffect, useState } from 'react';

import { safeGetItem, safeSetItem } from '../utils/storage';

const THEME_KEY = 'photowall_theme';

function getInitialDarkMode(): boolean {
  const saved = safeGetItem(THEME_KEY);
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export const useThemeMode = () => {
  const [darkMode, setDarkMode] = useState(getInitialDarkMode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    safeSetItem(THEME_KEY, darkMode ? 'dark' : 'light');
  }, [darkMode]);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((value) => !value);
  }, []);

  return { darkMode, toggleDarkMode };
};
