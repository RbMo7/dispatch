import { BalancesProvider } from '../balances';
import { ToastProvider } from '../components/Toast';
import { DispatchesPage } from './dispatches/DispatchesPage';
import { LiveProvider } from './live';
import { Overview } from './overview/Overview';
import { RouterProvider, useRouter } from './router';
import { SendersPage } from './senders/SendersPage';
import { SendersProvider } from './senderData';
import { SessionProvider } from './session';
import { Shell } from './Shell';
import { SignIn } from './SignIn';

export function Console() {
  return (
    <BalancesProvider>
      <ToastProvider>
        <SessionProvider signIn={(accept, notice) => <SignIn onSignIn={accept} notice={notice} />}>
          <LiveProvider>
            <RouterProvider>
              <SendersProvider>
                <Shell>
                  <CurrentPage />
                </Shell>
              </SendersProvider>
            </RouterProvider>
          </LiveProvider>
        </SessionProvider>
      </ToastProvider>
    </BalancesProvider>
  );
}

function CurrentPage() {
  const { page } = useRouter();
  switch (page) {
    case 'overview':
      return <Overview />;
    case 'dispatches':
      return <DispatchesPage />;
    case 'senders':
      return <SendersPage />;
  }
}
