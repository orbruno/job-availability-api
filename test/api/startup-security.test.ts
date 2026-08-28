import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { assertProvisionedToken } from '../../src/api/authentication.js';
import {
  configuredToken,
  readProvisionedTokenFile,
} from '../../src/index.js';
import { SERVICE_ROOT } from '../helpers/service-harness.js';

const executeFile = promisify(execFile);
const temporaryRoots: string[] = [];
const unavailable = { status: 503, code: 'service_unavailable' };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'job-availability-token-test-')));
  temporaryRoots.push(root);
  return root;
}

async function tokenFile(root: string, name = 'service-token'): Promise<{
  path: string;
  token: string;
}> {
  const path = join(root, name);
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, token };
}

describe('startup token boundary', () => {
  it('requires exactly one configured secret source', async () => {
    const direct = randomBytes(32).toString('base64url');
    await expect(configuredToken({})).rejects.toMatchObject(unavailable);
    await expect(configuredToken({
      JOB_AVAILABILITY_TOKEN: direct,
      JOB_AVAILABILITY_TOKEN_FILE: '/private/unused-token',
    })).rejects.toMatchObject(unavailable);
    await expect(configuredToken({ JOB_AVAILABILITY_TOKEN: direct })).resolves.toBe(direct);
    expect(() => assertProvisionedToken(direct)).not.toThrow();
  });

  it('loads a protected absolute regular file and preserves a valid generated token', async () => {
    const root = await temporaryRoot();
    const provisioned = await tokenFile(root);
    await expect(readProvisionedTokenFile(provisioned.path)).resolves.toBe(provisioned.token);
    await expect(configuredToken({
      JOB_AVAILABILITY_TOKEN_FILE: provisioned.path,
    })).resolves.toBe(provisioned.token);
    expect(() => assertProvisionedToken(provisioned.token)).not.toThrow();
  });

  it('rejects relative, non-regular, insecure, empty, and oversized token files', async () => {
    const root = await temporaryRoot();
    const insecure = await tokenFile(root, 'insecure-token');
    await chmod(insecure.path, 0o644);
    const empty = join(root, 'empty-token');
    await writeFile(empty, '', { mode: 0o600 });
    const oversized = join(root, 'oversized-token');
    await writeFile(oversized, Buffer.alloc(1_025, 0x61), { mode: 0o600 });
    const directory = join(root, 'token-directory');
    await mkdir(directory, { mode: 0o700 });

    await expect(readProvisionedTokenFile('relative-token')).rejects.toMatchObject(unavailable);
    for (const path of [insecure.path, empty, oversized, directory]) {
      await expect(readProvisionedTokenFile(path)).rejects.toMatchObject(unavailable);
    }
  });

  it('rejects a symlink in either the final file or a parent component', async () => {
    const root = await temporaryRoot();
    const realDirectory = join(root, 'real-secrets');
    await mkdir(realDirectory, { mode: 0o700 });
    const provisioned = await tokenFile(realDirectory);
    const finalLink = join(root, 'linked-token');
    await symlink(provisioned.path, finalLink);
    const parentLink = join(root, 'linked-secrets');
    await symlink(realDirectory, parentLink);

    await expect(readProvisionedTokenFile(finalLink)).rejects.toMatchObject(unavailable);
    await expect(readProvisionedTokenFile(join(parentLink, 'service-token')))
      .rejects.toMatchObject(unavailable);
  });

  it('rejects malformed or undersized decoded token material', () => {
    expect(() => assertProvisionedToken('short')).toThrow(expect.objectContaining(unavailable));
    expect(() => assertProvisionedToken(`${randomBytes(32).toString('base64url')}=`))
      .toThrow(expect.objectContaining(unavailable));
    expect(() => assertProvisionedToken(randomBytes(31).toString('base64url')))
      .toThrow(expect.objectContaining(unavailable));
  });

  it('generates unique base64url tokens containing exactly 32 random bytes', async () => {
    const outputs = await Promise.all(Array.from({ length: 4 }, async () => {
      const result = await executeFile(process.execPath, [join(SERVICE_ROOT, 'scripts', 'generate-token.mjs')], {
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.stdout.endsWith('\n')).toBe(true);
      const token = result.stdout.trim();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(() => assertProvisionedToken(token)).not.toThrow();
      return token;
    }));
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});
