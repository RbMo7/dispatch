import { BalancesProvider } from '../balances';
import { ToastProvider } from '../components/Toast';
import { ActivityPage } from './activity/ActivityPage';
import { DispatchesPage } from './dispatches/DispatchesPage';
import { HeldProvider } from './held/heldData';
import { HeldPage } from './held/HeldPage';
import { LiveProvider } from './live';
import { Overview } from './overview/Overview';
import { RejectedPage } from './rejected/RejectedPage';
import { OPERATOR_PAGES, RouterProvider, useRouter } from './router';
import { RulesPage } from './rules/RulesPage';
import { SendersPage } from './senders/SendersPage';
import { SendersProvider } from './senderData';
import { SetupPage } from './setup/SetupPage';
import { SessionProvider, useOperator } from './session';
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
                <HeldProvider>
                  <Shell>
                    <CurrentPage />
                  </Shell>
                </HeldProvider>
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
  const operator = useOperator();
  // ADR-0057: an AUTH_TOKEN session that opens an operator page's URL gets the Overview.
  switch (operator || !OPERATOR_PAGES.has(page) ? page : 'overview') {
    case 'overview':
      return <Overview />;
    case 'dispatches':
      return <DispatchesPage />;
    case 'held':
      return <HeldPage />;
    case 'rules':
      return <RulesPage />;
    case 'senders':
      return <SendersPage />;
    case 'activity':
      return <ActivityPage />;
    case 'rejected':
      return <RejectedPage />;
    case 'setup':
      return <SetupPage />;
  }
}
