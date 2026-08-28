import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileAvailabilityRepository } from '../dist/infrastructure/persistence/file-availability-repository.js';

const dataRoot = process.env.JOB_AVAILABILITY_DATA_ROOT;
const expectedOwner = process.argv[2];
if (dataRoot === undefined || !isAbsolute(dataRoot) || expectedOwner === undefined) {
  process.stderr.write('Usage: JOB_AVAILABILITY_DATA_ROOT=/absolute/path npm run lock:recover -- <owner>\n');
  process.exit(2);
}
const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = new FileAvailabilityRepository(dataRoot, resolve(serviceRoot, 'schemas'));
await repository.recoverStaleWriterLock(expectedOwner);
process.stdout.write('Stale writer lock recovered.\n');
