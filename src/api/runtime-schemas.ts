import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { serviceError } from '../application/service-error.js';

export type PublicDefinition =
  | 'CredentialTestResponse'
  | 'ObservePostingRequest'
  | 'ObservePostingResponse'
  | 'CreateRunRequest'
  | 'CreateScheduledRunRequest'
  | 'Run'
  | 'CheckJobResponse'
  | 'JobAvailability'
  | 'Problem';

export class RuntimeSchemas {
  readonly #validators = new Map<PublicDefinition, ValidateFunction>();

  public constructor(schemaDirectory: string) {
    const schema = JSON.parse(
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
    ajv.addSchema(schema);
    for (const definition of [
      'CredentialTestResponse',
      'ObservePostingRequest',
      'ObservePostingResponse',
      'CreateRunRequest',
      'CreateScheduledRunRequest',
      'Run',
      'CheckJobResponse',
      'JobAvailability',
      'Problem',
    ] as const) {
      this.#validators.set(definition, ajv.compile({
        $ref: `https://job-availability.local/schemas/public-api-v1.schema.json#/$defs/${definition}`,
      }));
    }
  }

  public assertRequest(definition: PublicDefinition, value: unknown): void {
    if (!this.#valid(definition, value)) {
      throw serviceError(400, 'invalid_request', 'The request does not match the version 1 contract.');
    }
  }

  public assertResponse(definition: PublicDefinition, value: unknown): void {
    if (!this.#valid(definition, value)) {
      throw serviceError(500, 'internal_error', 'The service produced an invalid response.');
    }
  }

  #valid(definition: PublicDefinition, value: unknown): boolean {
    return this.#validators.get(definition)?.(value) === true;
  }
}
