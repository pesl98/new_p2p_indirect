import { useEffect, useState } from 'react';
import { DEFAULT_LOCALE, getLocale, subscribeLocale, t } from './i18n';

/** Locale for this deployment. A future picker calls setLocale(); this hook re-renders. */
export function useI18n() {
  const [locale, setLocaleState] = useState(getLocale);
  useEffect(() => subscribeLocale(setLocaleState), []);
  return { t, locale, defaultLocale: DEFAULT_LOCALE };
}
