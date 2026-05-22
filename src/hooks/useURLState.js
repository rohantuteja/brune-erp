import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Drop-in replacement for useState that persists the value in the URL as a
 * query parameter. Defaults are never written to the URL (keeps URLs clean).
 *
 * Supports string, boolean, and number defaults — parses accordingly.
 * All setSearchParams calls use the functional-updater form so concurrent
 * updates from sibling hooks compose correctly.
 *
 * @param {string} key          URL query param name
 * @param {string|boolean|number} defaultValue  Returned when the param is absent
 * @returns {[value, setter]}   Same shape as useState
 */
export function useURLState(key, defaultValue) {
  const [searchParams, setSearchParams] = useSearchParams();

  const rawValue = searchParams.get(key);

  let value;
  if (rawValue === null) {
    value = defaultValue;
  } else if (typeof defaultValue === 'boolean') {
    value = rawValue === 'true';
  } else if (typeof defaultValue === 'number') {
    const n = Number(rawValue);
    value = isNaN(n) ? defaultValue : n;
  } else {
    value = rawValue;
  }

  const setValue = useCallback(
    (newValue) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const isDefault =
            newValue === defaultValue ||
            newValue === '' ||
            newValue === null ||
            newValue === undefined;
          if (isDefault) {
            next.delete(key);
          } else {
            next.set(key, String(newValue));
          }
          return next;
        },
        { replace: true },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, defaultValue],
  );

  return [value, setValue];
}
