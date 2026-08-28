import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryBase = await realpath(tmpdir());
const root = await mkdtemp(join(temporaryBase, 'job-availability-runtime-smoke-'));
const dataRoot = join(root, 'data');
const tokenPath = join(root, 'service-token');
const token = randomBytes(32).toString('base64url');
await mkdir(join(dataRoot, 'jobs', 'synthetic-job'), { recursive: true });
await writeFile(join(dataRoot, 'jobs', 'index.json'), JSON.stringify({
  jobs: [{ slug: 'synthetic-job' }],
}));
await writeFile(join(dataRoot, 'jobs', 'synthetic-job', 'metadata.json'), JSON.stringify({
  title: 'Synthetic Data Engineer',
  company: 'Synthetic Company',
  platform: 'synthetic',
  url: 'https://example.com/jobs/synthetic',
  sources: [{ platform: 'synthetic', url: 'https://example.com/jobs/synthetic' }],
}));
await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
await chmod(tokenPath, 0o600);

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    JOB_AVAILABILITY_DATA_ROOT: dataRoot,
    JOB_AVAILABILITY_HOST: '127.0.0.1',
    JOB_AVAILABILITY_PORT: '5002',
    JOB_AVAILABILITY_TOKEN_FILE: tokenPath,
    JOB_AVAILABILITY_OWNER_KEY: 'runtime-smoke',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
child.stderr.on('data', (chunk) => { errors = `${errors}${String(chunk)}`.slice(-2_000); });

async function request(path, options = {}) {
  return await globalThis.fetch(`http://127.0.0.1:5002${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    signal: globalThis.AbortSignal.timeout(2_000),
  });
}

let staleLockRemained;
try {
  let ready;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      ready = await request('/v1/credentials/test');
      if (ready.ok) break;
    } catch {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
    }
  }
  if (ready?.status !== 200) throw new Error(`Credential smoke failed. ${errors}`);
  const scheduled = await request('/v1/availability/runs/scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'runtime-smoke-create' },
    body: JSON.stringify({ schema_version: 1 }),
  });
  if (scheduled.status !== 201) throw new Error('Scheduled-run smoke failed.');
  const run = await scheduled.json();
  const cancelled = await request(`/v1/availability/runs/${run.run_id}/cancel`, {
    method: 'POST',
    headers: { 'Idempotency-Key': 'runtime-smoke-cancel' },
  });
  if (cancelled.status !== 200 || (await cancelled.json()).status !== 'cancelled') {
    throw new Error('Cancellation smoke failed.');
  }
  process.stdout.write('Runtime smoke passed: credential, scheduled create, persistence, and cancellation.\n');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
  const lockPath = join(dataRoot, 'availability', '.job-availability-service.lock');
  const lock = await readFile(lockPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  await rm(root, { recursive: true, force: true });
  staleLockRemained = lock !== null;
}
if (staleLockRemained) throw new Error('Graceful shutdown left a writer lock.');
