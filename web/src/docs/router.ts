import { type MouseEvent, useCallback, useEffect, useState } from 'react';

export interface Location {
  pathname: string;
  hash: string;
}

function current(): Location {
  return { pathname: window.location.pathname, hash: window.location.hash };
}

export function useLocation(): [Location, (href: string) => void] {
  const [location, setLocation] = useState(current);

  useEffect(() => {
    const sync = () => setLocation(current());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const navigate = useCallback((href: string) => {
    window.history.pushState(null, '', href);
    setLocation(current());
  }, []);

  return [location, navigate];
}

export function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  );
}
