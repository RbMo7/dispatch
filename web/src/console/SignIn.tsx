import { type FormEvent, useState } from 'react';

import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { ApiError, createApiClient, describeFailure } from './api/client';
import type { Credentials } from './session';
import styles from './SignIn.module.css';

/**
 * A centred card: one token field, checked against the engine before it is
 * kept. Either token signs in; the engine says which one it is.
 */
export function SignIn({
  onSignIn,
  notice,
}: {
  onSignIn: (credentials: Credentials) => void;
  notice: string | null;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError('Paste the OPERATOR_TOKEN or AUTH_TOKEN this engine was started with.');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const kind = await createApiClient(candidate, () => {}).getTokenKind();
      onSignIn({ token: candidate, kind });
    } catch (failure) {
      if (!(failure instanceof ApiError)) throw failure;
      setError(
        failure.failure.kind === 'unauthorized'
          ? 'The engine refused that token. Check OPERATOR_TOKEN and AUTH_TOKEN in its environment.'
          : describeFailure(failure.failure),
      );
      setChecking(false);
    }
  }

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles.brand}>dispatch</div>
        <div className={styles.instance}>{window.location.host}</div>
        {notice && !error && <p className={styles.notice}>{notice}</p>}
        <TextField
          label="Token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
          aria-invalid={error ? true : undefined}
          help="OPERATOR_TOKEN reviews holds and edits Flag Rules; AUTH_TOKEN reads and cancels. Kept in this tab only."
        />
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" disabled={checking} className={styles.submit}>
          {checking ? 'Checking' : 'Sign in'}
        </Button>
        <a className={styles.docs} href="/docs/console#sign-in">
          Where the token comes from ›
        </a>
      </form>
    </main>
  );
}
