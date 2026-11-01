/**
 * A JSON-RPC pass-through the engine's RPC URLs point at, so a flow can
 * make the engine see the chain the way a real incident would, without
 * changing engine code:
 *
 * - `underpriced` (Base): for a window, `eth_getBlockByNumber("latest")`
 *   reports a quarter of the real base fee, so the engine signs a
 *   transaction the chain will not include and the Retry Policy must bump it.
 * - `staleBlockhash` (Solana): the next `getLatestBlockhash` answers an old
 *   blockhash the runner captured, so the engine signs a transaction that has
 *   already expired and the Coordinator must resubmit it.
 *
 * Routes: `/solana` and `/base` forward to the real RPCs; `POST /__flows/arm`
 * takes `{ "trap": "underpriced", "ms": 20000 }` or
 * `{ "trap": "staleBlockhash", "blockhash": "...", "lastValidBlockHeight": 123 }`;
 * `GET /__flows/log` returns, and forgets, what was rewritten since the last read.
 */
import { createServer, type IncomingMessage } from 'node:http';

import { BASE_RPC_URL, SOLANA_RPC_URL } from './config.js';

type JsonRpcRequest = { id?: unknown; method?: string; params?: unknown[] };
type JsonRpcResponse = { result?: unknown };

type Traps = {
  underpricedUntil: number;
  staleBlockhash: { blockhash: string; lastValidBlockHeight: number } | null;
};

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function startRpcProxy(port: number) {
  const traps: Traps = { underpricedUntil: 0, staleBlockhash: null };
  const rewrites: { at: string; trap: string; detail: string }[] = [];

  function rewrite(chain: 'solana' | 'base', request: JsonRpcRequest, response: JsonRpcResponse) {
    if (
      chain === 'base' &&
      request.method === 'eth_getBlockByNumber' &&
      request.params?.[0] === 'latest' &&
      Date.now() < traps.underpricedUntil
    ) {
      const block = response.result as { baseFeePerGas?: string } | null;
      if (block?.baseFeePerGas) {
        const real = BigInt(block.baseFeePerGas);
        block.baseFeePerGas = `0x${(real / 4n).toString(16)}`;
        rewrites.push({
          at: new Date().toISOString(),
          trap: 'underpriced',
          detail: `baseFeePerGas ${real} -> ${real / 4n}`,
        });
      }
    }
    if (chain === 'solana' && request.method === 'getLatestBlockhash' && traps.staleBlockhash) {
      const result = response.result as { value?: Record<string, unknown> } | undefined;
      if (result?.value) {
        result.value = { ...result.value, ...traps.staleBlockhash };
        rewrites.push({
          at: new Date().toISOString(),
          trap: 'staleBlockhash',
          detail: `answered ${traps.staleBlockhash.blockhash}`,
        });
        traps.staleBlockhash = null;
      }
    }
    return response;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const text = await body(req);
      if (req.url === '/__flows/arm' && req.method === 'POST') {
        const arm = JSON.parse(text) as {
          trap: string;
          ms?: number;
          blockhash?: string;
          lastValidBlockHeight?: number;
        };
        if (arm.trap === 'underpriced') traps.underpricedUntil = Date.now() + (arm.ms ?? 20_000);
        else if (arm.trap === 'staleBlockhash' && arm.blockhash && arm.lastValidBlockHeight)
          traps.staleBlockhash = {
            blockhash: arm.blockhash,
            lastValidBlockHeight: arm.lastValidBlockHeight,
          };
        else {
          res.writeHead(400).end(`unknown trap ${text}`);
          return;
        }
        res.writeHead(204).end();
        return;
      }
      if (req.url === '/__flows/log') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(rewrites.splice(0)));
        return;
      }
      const chain = req.url?.startsWith('/solana')
        ? 'solana'
        : req.url?.startsWith('/base')
          ? 'base'
          : null;
      if (!chain || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      try {
        const upstream = await fetch(chain === 'solana' ? SOLANA_RPC_URL : BASE_RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
        });
        const raw = await upstream.text();
        let out = raw;
        if (upstream.ok) {
          const request = JSON.parse(text) as JsonRpcRequest | JsonRpcRequest[];
          const response = JSON.parse(raw) as JsonRpcResponse | JsonRpcResponse[];
          if (!Array.isArray(request) && !Array.isArray(response))
            out = JSON.stringify(rewrite(chain, request, response));
          else if (Array.isArray(request) && Array.isArray(response))
            out = JSON.stringify(response.map((r, i) => rewrite(chain, request[i] ?? {}, r)));
        }
        res.writeHead(upstream.status, { 'content-type': 'application/json' }).end(out);
      } catch (cause) {
        res.writeHead(502).end(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  });
  return new Promise<{ close: () => void }>((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve({ close: () => server.close() })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.FLOWS_PROXY_PORT ?? 8503);
  await startRpcProxy(port);
  console.log(`flows rpc proxy on :${port}`);
}
