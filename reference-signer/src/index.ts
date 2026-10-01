import { loadKeyring } from './keys.js';
import { createSignerServer } from './server.js';

const port = Number(process.env.PORT ?? 8421);
const keyfilePath =
  process.env.SIGNER_KEYFILE ?? new URL('../keys.dev.json', import.meta.url).pathname;

const keyring = loadKeyring(keyfilePath);
const server = createSignerServer(keyring, process.env.SIGNER_AUTH_TOKEN ?? '');

server.listen(port, () => {
  console.log(`reference signer listening on :${port} (keyfile: ${keyfilePath})`);
});
