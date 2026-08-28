import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const tokenPath = process.env.JOB_AVAILABILITY_TOKEN_FILE;
if (tokenPath === undefined) process.exit(1);
const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let token;
try {
  token = (await handle.readFile('utf8')).trim();
} finally {
  await handle.close();
}
const port = process.env.JOB_AVAILABILITY_PORT ?? '5002';
const response = await globalThis.fetch(`http://127.0.0.1:${port}/v1/credentials/test`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: globalThis.AbortSignal.timeout(2_000),
});
process.exit(response.ok ? 0 : 1);
