import { BalancesProvider } from '../balances';
import { ToastProvider } from '../components/Toast';
import styles from './console.module.css';
import { DispatchesPage } from './dispatches/DispatchesPage';
import { LiveProvider } from './live';
import { RouterProvider, useRouter } from './router';
import { SendersProvider } from './senderData';
import { SessionProvider } from './session';
import { PageBar, Shell } from './Shell';
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
      return <Pending title="Overview" />;
    case 'dispatches':
      return <DispatchesPage />;
    case 'senders':
      return <Pending title="Senders & Keys" />;
  }
}

/** A page not built yet: the shell and its bar, so navigation already works. */
function Pending({ title }: { title: string }) {
  return (
    <main className={styles.main}>
      <PageBar title={title} />
    </main>
  );
}
