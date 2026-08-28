import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excludedDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);

async function collect(directory, entries) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory() && excludedDirectories.has(item.name)) continue;
    const path = resolve(directory, item.name);
    const projectPath = relative(serviceRoot, path).split(sep).join('/');
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      await collect(path, entries);
    } else if (metadata.isSymbolicLink()) {
      entries.push({ kind: 'link', path: projectPath, value: await readlink(path) });
    } else if (metadata.isFile()) {
      entries.push({ kind: 'file', path: projectPath, value: await readFile(path) });
    }
  }
}

const entries = [];
await collect(serviceRoot, entries);
entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

const hash = createHash('sha256');
for (const entry of entries) {
  hash.update(entry.path);
  hash.update('\0');
  hash.update(entry.kind);
  hash.update('\0');
  hash.update(entry.value);
  hash.update('\0');
}

process.stdout.write(
  `${JSON.stringify(
    {
      algorithm: 'sha256',
      files: entries.filter(({ kind }) => kind === 'file').length,
      symlinks: entries.filter(({ kind }) => kind === 'link').length,
      sha256: hash.digest('hex'),
    },
    null,
    2,
  )}\n`,
);
