import { buildSigner } from './startup.js';

const port = Number(process.env.PORT ?? 8421);

try {
  const server = await buildSigner(process.env);
  server.listen(port, () => {
    console.error(`signer listening on :${port}`);
  });
} catch (cause) {
  console.error(
    `signer refused to start: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exit(1);
}
