import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { serviceError } from '../../application/service-error.js';

type PersistedDefinition = 'AvailabilityStateDocument' | 'AvailabilityRunDocument' | 'PerJobEvidenceDocument';

export class PersistedSchemaValidator {
  readonly #validators = new Map<PersistedDefinition, ValidateFunction>();

  public constructor(schemaDirectory: string) {
    const schema = JSON.parse(
      readFileSync(resolve(schemaDirectory, 'persisted-availability-v1.schema.json'), 'utf8'),
    ) as object;
    const publicSchema = JSON.parse(
      readFileSync(resolve(schemaDirectory, 'public-api-v1.schema.json'), 'utf8'),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    (addFormatsModule as unknown as (instance: Ajv2020) => void)(ajv);
    ajv.addKeyword({
      keyword: 'x-max-utf8-bytes',
      type: 'string',
      schemaType: 'number',
      validate: (limit: number, data: string) => Buffer.byteLength(data, 'utf8') <= limit,
    });
    ajv.addSchema(publicSchema);
    ajv.addSchema(schema);
    for (const definition of [
      'AvailabilityStateDocument',
      'AvailabilityRunDocument',
      'PerJobEvidenceDocument',
    ] as const) {
      this.#validators.set(
        definition,
        ajv.compile({
          $ref: `https://job-availability.local/schemas/persisted-availability-v1.schema.json#/$defs/${definition}`,
        }),
      );
    }
  }

  public assert(definition: PersistedDefinition, value: unknown): void {
    const validator = this.#validators.get(definition);
    if (!validator?.(value)) {
      throw serviceError(503, 'service_unavailable', 'Persisted availability data is invalid.');
    }
  }
}
