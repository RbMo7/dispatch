/** The few `/v1` calls the flows make, with the two tokens kept apart. */

export type EngineTarget = { url: string; authToken: string; operatorToken: string };

export type DispatchView = {
  dispatchId: string;
  mode: 'managed' | 'relay';
  status: string;
  items?: { status: string; error: { code: string; message: string } | null }[];
  error?: { code: string; message: string } | null;
  timeline?: { kind: string; hash?: string; replaces?: string | null }[];
};

export type Reply = { status: number; body: Record<string, unknown> };

/** A Dispatch is done moving once it reaches one of these; `held` waits for a person. */
export const SETTLED = new Set(['confirmed', 'failed', 'partial', 'cancelled', 'abandoned']);

export function engineApi(
  target: EngineTarget,
  onSubmit: (key: string, dispatchId: string) => void = () => {},
) {
  async function call(
    method: string,
    path: string,
    { body, operator = false, key }: { body?: unknown; operator?: boolean; key?: string } = {},
  ): Promise<Reply> {
    const res = await fetch(`${target.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${operator ? target.operatorToken : target.authToken}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(key && { 'idempotency-key': key }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  async function getDispatch(id: string): Promise<DispatchView> {
    const reply = await call('GET', `/v1/dispatch/${id}?include=timeline`);
    if (reply.status !== 200)
      throw new Error(`GET dispatch ${id}: ${reply.status} ${JSON.stringify(reply.body)}`);
    return reply.body as unknown as DispatchView;
  }

  return {
    call,
    getDispatch,
    /** Submits a Dispatch and returns its id, or throws with the engine's refusal. */
    async submit(key: string, body: unknown): Promise<string> {
      const reply = await call('POST', '/v1/dispatch', { body, key });
      if (reply.status !== 202 && reply.status !== 200)
        throw new Error(`submit ${key}: ${reply.status} ${JSON.stringify(reply.body)}`);
      const dispatchId = reply.body.dispatchId as string;
      onSubmit(key, dispatchId);
      return dispatchId;
    },
    async waitUntil(
      id: string,
      done: (d: DispatchView) => boolean,
      timeoutMs = 6 * 60_000,
    ): Promise<DispatchView> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const view = await getDispatch(id);
        if (done(view)) return view;
        if (Date.now() > deadline)
          throw new Error(`dispatch ${id} still ${view.status} after ${timeoutMs / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  };
}

export type EngineApi = ReturnType<typeof engineApi>;
