import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export const PAGES = {
  overview: '/console',
  dispatches: '/console/dispatches',
  senders: '/console/senders',
} as const;

export type Page = keyof typeof PAGES;

interface Location {
  page: Page;
  params: URLSearchParams;
}

interface Router extends Location {
  /** Goes to a page, pushing history. */
  navigate: (page: Page, params?: URLSearchParams) => void;
  /** Rewrites the query of the current page in place, as filters and the selection change. */
  replaceParams: (params: URLSearchParams) => void;
}

function read(): Location {
  const path = window.location.pathname.replace(/\/+$/, '');
  const page = (Object.keys(PAGES) as Page[]).find((p) => PAGES[p] === path) ?? 'overview';
  return { page, params: new URLSearchParams(window.location.search) };
}

function url(page: Page, params?: URLSearchParams): string {
  const query = params?.toString();
  return query ? `${PAGES[page]}?${query}` : PAGES[page];
}

const RouterContext = createContext<Router | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(read);

  useEffect(() => {
    const onPop = () => setLocation(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((page: Page, params?: URLSearchParams) => {
    window.history.pushState(null, '', url(page, params));
    setLocation(read());
    window.scrollTo(0, 0);
  }, []);

  const replaceParams = useCallback((params: URLSearchParams) => {
    const page = read().page;
    const next = url(page, params);
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', next);
    }
    setLocation({ page, params });
  }, []);

  return (
    <RouterContext.Provider value={{ ...location, navigate, replaceParams }}>
      {children}
    </RouterContext.Provider>
  );
}

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter outside RouterProvider');
  return router;
}

/** A plain link that navigates in place, and still opens in a new tab with a modifier. */
export function Link({
  page,
  params,
  className,
  children,
  ...rest
}: {
  page: Page;
  params?: URLSearchParams;
  className?: string | undefined;
  children: ReactNode;
  'aria-current'?: 'page' | undefined;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={url(page, params)}
      className={className}
      {...rest}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(page, params);
      }}
    >
      {children}
    </a>
  );
}
