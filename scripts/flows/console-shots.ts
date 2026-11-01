/**
 * Headless Chrome over the DevTools protocol: signs the console in with the
 * operator token and saves a PNG plus the visible text of a console page.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { statePath } from './config.js';

const CHROME =
  process.env.FLOWS_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Camera = {
  /** Opens `pathAndQuery` on the console, waits for it to settle, writes `<name>.png` and `<name>.txt`. */
  shoot(pathAndQuery: string, name: string): Promise<string>;
  close(): void;
};

export async function openCamera(
  engineUrl: string,
  token: string,
  outDir: string,
): Promise<Camera> {
  mkdirSync(outDir, { recursive: true });
  const port = Number(process.env.FLOWS_CDP_PORT ?? 9339);
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${statePath('chrome-profile')}`,
      '--no-first-run',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(500);
    try {
      target = (await (
        await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      ).json()) as { webSocketDebuggerUrl: string };
    } catch {
      // Chrome still starting
    }
  }
  if (!target) throw new Error('headless Chrome never opened its DevTools port');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let nextId = 0;
  const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: unknown;
    };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  const send = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => {
        pending.delete(id);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result as T);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string) =>
    (
      await send<{ result: { value: T } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${engineUrl}/console` });
  await sleep(1500);
  await evaluate(
    `sessionStorage.setItem('dispatch-session', ${JSON.stringify(JSON.stringify({ token, kind: 'operator' }))})`,
  );

  return {
    async shoot(pathAndQuery, name) {
      await send('Page.navigate', { url: `${engineUrl}${pathAndQuery}` });
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        const settled = await evaluate<boolean>(
          `document.readyState === 'complete' && !/Loading|Reading /.test(document.body.innerText)`,
        );
        if (settled) break;
      }
      await sleep(1200);
      const { data } = await send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      const png = path.join(outDir, `${name}.png`);
      writeFileSync(png, Buffer.from(data, 'base64'));
      writeFileSync(
        path.join(outDir, `${name}.txt`),
        await evaluate<string>('document.body.innerText'),
      );
      return png;
    },
    close() {
      ws.close();
      chrome.kill();
    },
  };
}
