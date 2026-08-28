import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serviceRoot = resolve(scriptDirectory, '..');
const fixtureDirectory = resolve(serviceRoot, 'test/fixtures');
const openapiPath = resolve(serviceRoot, 'openapi/job-availability-v1.yaml');
const publicSchemaPath = resolve(serviceRoot, 'schemas/public-api-v1.schema.json');
const persistedSchemaPath = resolve(
  serviceRoot,
  'schemas/persisted-availability-v1.schema.json',
);
const fixtureSchemaPath = resolve(
  fixtureDirectory,
  'availability-fixture-set-v1.schema.json',
);
const manifestPath = resolve(fixtureDirectory, 'manifest.v1.json');

const fixtureFiles = [
  'source-identity.v1.json',
  'observation-classification.v1.json',
  'availability-state.v1.json',
  'run-state.v1.json',
  'boundary-security.v1.json',
  'persisted-compatibility.v1.json',
];

const expectedCounts = new Map([
  ['source_identity', 9],
  ['observation_classification', 26],
  ['availability_state', 13],
  ['run_state', 6],
  ['boundary_security', 5],
  ['persisted_compatibility', 6],
]);

const expectedOperations = new Map([
  ['/v1/credentials/test', ['get']],
  ['/v1/postings/observe', ['post']],
  ['/v1/availability/runs', ['post']],
  ['/v1/availability/runs/scheduled', ['post']],
  ['/v1/availability/runs/{run_id}', ['get']],
  ['/v1/availability/runs/{run_id}/jobs/{job_id}/check', ['post']],
  ['/v1/jobs/{job_id}/availability', ['get']],
  ['/v1/availability/runs/{run_id}/finalize', ['post']],
  ['/v1/availability/runs/{run_id}/cancel', ['post']],
]);

const expectedResponseStatuses = new Map([
  ['GET /v1/credentials/test', ['200', '400', '401', '429', '500', '503']],
  [
    'POST /v1/postings/observe',
    ['200', '400', '401', '409', '413', '415', '429', '500', '503'],
  ],
  [
    'POST /v1/availability/runs',
    ['201', '400', '401', '404', '409', '413', '415', '429', '500', '503'],
  ],
  [
    'POST /v1/availability/runs/scheduled',
    ['201', '400', '401', '409', '413', '415', '429', '500', '503'],
  ],
  [
    'GET /v1/availability/runs/{run_id}',
    ['200', '400', '401', '404', '429', '500', '503'],
  ],
  [
    'POST /v1/availability/runs/{run_id}/jobs/{job_id}/check',
    ['200', '400', '401', '404', '409', '413', '415', '429', '500', '503'],
  ],
  [
    'GET /v1/jobs/{job_id}/availability',
    ['200', '400', '401', '404', '429', '500', '503'],
  ],
  [
    'POST /v1/availability/runs/{run_id}/finalize',
    ['200', '400', '401', '404', '409', '413', '415', '429', '500', '503'],
  ],
  [
    'POST /v1/availability/runs/{run_id}/cancel',
    ['200', '400', '401', '404', '409', '413', '415', '429', '500', '503'],
  ],
]);

const expectedEvidence = new Set([
  'jobposting_active',
  'apply_action_present',
  'platform_open_marker',
  'http_404',
  'http_410',
  'valid_through_past',
  'platform_closed_marker',
  'access_denied',
  'rate_limited',
  'server_error',
  'timeout',
  'network_error',
  'bot_challenge',
  'redirect_mismatch',
  'identity_mismatch',
  'identity_unverified',
  'unsupported_source',
  'parse_error',
]);

const expectedOutcomes = new Set(['open', 'closed', 'inconclusive']);
const expectedAvailabilityStatuses = new Set([
  'unchecked',
  'open',
  'likely_closed',
  'closed',
  'uncertain',
]);
const expectedRunStatuses = new Set([
  'pending',
  'running',
  'completed',
  'cancelled',
  'failed',
]);

const expectedCorrectionIds = new Set([
  'identity-non-default-port-significant',
  'identity-path-case-significant',
  'identity-unicode-idn-punycode-converge',
  'classification-malformed-json-ld',
  'classification-closed-marker-unverified',
  'classification-mixed-active-and-expired-jobpostings-open',
  'redirect-unrelated-404-inconclusive',
  'redirect-unrelated-410-inconclusive',
  'run-cancel-wins-in-flight',
  'run-per-job-failure-continues',
  'security-dns-rebinding-blocked',
  'job-id-boundary-matrix',
  'compatibility-rejects-unsupported-version-and-unknown-fields',
  'compatibility-rejects-outcome-evidence-mismatch',
]);

const evidenceByOutcome = new Map([
  [
    'open',
    new Set(['jobposting_active', 'apply_action_present', 'platform_open_marker']),
  ],
  [
    'closed',
    new Set(['http_404', 'http_410', 'valid_through_past', 'platform_closed_marker']),
  ],
  [
    'inconclusive',
    new Set([
      'access_denied',
      'rate_limited',
      'server_error',
      'timeout',
      'network_error',
      'bot_challenge',
      'redirect_mismatch',
      'identity_mismatch',
      'identity_unverified',
      'unsupported_source',
      'parse_error',
    ]),
  ],
]);

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function sorted(values) {
  return [...values].sort();
}

function equalSets(actual, expected) {
  return (
    actual.size === expected.size && [...actual].every((value) => expected.has(value))
  );
}

function formatAjvErrors(validate) {
  return (validate.errors ?? [])
    .map(({ instancePath, message, params }) =>
      `${instancePath || '/'} ${message ?? 'is invalid'} ${JSON.stringify(params)}`,
    )
    .join('; ');
}

function assertValid(validate, value, label) {
  check(validate(value), `${label}: ${formatAjvErrors(validate)}`);
}

function collectStrings(value, target) {
  if (typeof value === 'string') {
    target.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, target);
  }
}

function collectObjects(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, target);
    return;
  }
  if (value !== null && typeof value === 'object') {
    target.push(value);
    for (const item of Object.values(value)) collectObjects(item, target);
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function projectedUtcTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function responseHasHeader(openapi, response, headerName) {
  let selected = response;
  if (typeof selected?.$ref === 'string') {
    const componentName = selected.$ref.split('/').at(-1);
    selected = openapi.components?.responses?.[componentName];
  }
  return selected?.headers?.[headerName] !== undefined;
}

function parameterReferenceName(parameter) {
  if (typeof parameter?.$ref !== 'string') return parameter?.name;
  return parameter.$ref.split('/').at(-1);
}

function validateOpenApiStructure(openapi) {
  check(openapi.openapi === '3.1.1', 'OpenAPI version must be exactly 3.1.1');
  check(
    openapi.jsonSchemaDialect === 'https://json-schema.org/draft/2020-12/schema',
    'OpenAPI JSON Schema dialect must be 2020-12',
  );
  check(openapi.info?.version === '1.0.0', 'OpenAPI contract version must be 1.0.0');
  check(openapi['x-request-body-max-bytes'] === 262144, 'request body limit drifted');
  check(
    openapi['x-idempotency']?.['key-retention-hours'] === 24,
    'idempotency retention must be 24 hours',
  );
  check(
    openapi.components?.securitySchemes?.bearerAuth?.scheme === 'bearer',
    'Bearer authentication scheme is missing',
  );
  check(
    JSON.stringify(openapi.security) === JSON.stringify([{ bearerAuth: [] }]),
    'Bearer authentication must apply globally',
  );

  const paths = new Set(Object.keys(openapi.paths ?? {}));
  check(equalSets(paths, new Set(expectedOperations.keys())), 'OpenAPI route set drifted');

  let operationCount = 0;
  for (const [path, methods] of expectedOperations) {
    const pathItem = openapi.paths[path];
    check(pathItem !== undefined, `missing route ${path}`);
    for (const method of methods) {
      const operation = pathItem[method];
      check(operation !== undefined, `missing ${method.toUpperCase()} ${path}`);
      operationCount += 1;
      const parameters = new Set(
        (operation.parameters ?? []).map(parameterReferenceName),
      );
      check(parameters.has('N8nExecutionId'), `${method} ${path} lacks correlation header`);
      if (method === 'post') {
        check(parameters.has('IdempotencyKey'), `POST ${path} lacks idempotency key`);
      }
      const operationKey = `${method.toUpperCase()} ${path}`;
      const responseStatuses = new Set(Object.keys(operation.responses ?? {}));
      check(
        equalSets(responseStatuses, new Set(expectedResponseStatuses.get(operationKey))),
        `${operationKey} response status set drifted`,
      );
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        check(
          responseHasHeader(openapi, response, 'X-Request-Id'),
          `${method} ${path} response ${status} lacks X-Request-Id`,
        );
        if (method === 'post') {
          check(
            responseHasHeader(openapi, response, 'Idempotency-Replayed'),
            `POST ${path} response ${status} lacks replay header`,
          );
        }
      }
    }
  }

  const bodylessPaths = [
    '/v1/availability/runs/{run_id}/jobs/{job_id}/check',
    '/v1/availability/runs/{run_id}/finalize',
    '/v1/availability/runs/{run_id}/cancel',
  ];
  for (const path of bodylessPaths) {
    check(
      openapi.paths[path].post.requestBody === undefined,
      `bodyless mutation declares a request body: ${path}`,
    );
  }
  for (const path of [
    '/v1/postings/observe',
    '/v1/availability/runs',
    '/v1/availability/runs/scheduled',
  ]) {
    check(openapi.paths[path].post.requestBody?.required === true, `missing body: ${path}`);
  }
  return operationCount;
}

async function main() {
  const [
    openapiSource,
    publicSchemaSource,
    persistedSchemaSource,
    fixtureSchemaSource,
    manifest,
  ] = await Promise.all([
    readFile(openapiPath, 'utf8'),
    readFile(publicSchemaPath, 'utf8'),
    readFile(persistedSchemaPath, 'utf8'),
    readFile(fixtureSchemaPath, 'utf8'),
    readJson(manifestPath),
  ]);
  const publicSchema = JSON.parse(publicSchemaSource);
  const persistedSchema = JSON.parse(persistedSchemaSource);
  const fixtureSchema = JSON.parse(fixtureSchemaSource);
  const openapi = YAML.parse(openapiSource);
  const operationCount = validateOpenApiStructure(openapi);
  const bundledOpenapi = await SwaggerParser.bundle(openapiPath);
  await SwaggerParser.validate(bundledOpenapi);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: 'x-max-utf8-bytes', schemaType: 'number' });
  ajv.addSchema(publicSchema);
  ajv.addSchema(persistedSchema);
  const validateFixtureSet = ajv.compile(fixtureSchema);
  const validateSourceObservation = ajv.compile({
    $ref: `${persistedSchema.$id}#/$defs/SourceObservation`,
  });
  const validateAvailabilityState = ajv.compile({
    $ref: `${persistedSchema.$id}#/$defs/AvailabilityStateDocument`,
  });
  const validateAvailabilityRun = ajv.compile({
    $ref: `${persistedSchema.$id}#/$defs/AvailabilityRunDocument`,
  });
  const validatePerJobEvidence = ajv.compile({
    $ref: `${persistedSchema.$id}#/$defs/PerJobEvidenceDocument`,
  });
  const validatePublicEvidence = ajv.compile({
    $ref: `${publicSchema.$id}#/$defs/SourceEvidence`,
  });
  const validatePublicTimestamp = ajv.compile({
    $ref: `${publicSchema.$id}#/$defs/UtcTimestamp`,
  });
  const validatePersistedTimestamp = ajv.compile({
    $ref: `${persistedSchema.$id}#/$defs/UtcTimestamp`,
  });
  for (const value of ['2026-08-27T00:00:00Z', '2026-08-27T00:00:00.123456Z']) {
    assertValid(validatePublicTimestamp, value, `public UTC timestamp ${value}`);
    assertValid(validatePersistedTimestamp, value, `persisted UTC timestamp ${value}`);
  }
  assertValid(
    validatePersistedTimestamp,
    '2026-08-27T00:00:00.123456+00:00',
    'Python-compatible persisted UTC timestamp',
  );
  for (const value of [
    '2026-08-27T02:00:00+02:00',
    '2026-08-27T00:00:00+00:00',
    '2026-08-27T00:00:00-00:00',
    '2026-08-27T00:00:00',
  ]) {
    check(!validatePublicTimestamp(value), `non-canonical public timestamp accepted: ${value}`);
  }
  for (const value of [
    '2026-08-27T02:00:00+02:00',
    '2026-08-27T00:00:00-00:00',
    '2026-08-27T00:00:00',
  ]) {
    check(!validatePersistedTimestamp(value), `non-UTC persisted timestamp accepted: ${value}`);
  }

  const fixtureSets = await Promise.all(
    fixtureFiles.map(async (file) => ({
      file,
      document: await readJson(resolve(fixtureDirectory, file)),
    })),
  );
  const caseIds = new Set();
  const strings = new Set();
  const correctionIds = new Set();
  const expectationCounts = { parity: 0, correction: 0, new_contract: 0 };
  let caseCount = 0;

  for (const { file, document } of fixtureSets) {
    assertValid(validateFixtureSet, document, file);
    const expectedCount = expectedCounts.get(document.fixture_type);
    check(expectedCount !== undefined, `${file}: unknown fixture type`);
    check(document.cases.length === expectedCount, `${file}: expected ${expectedCount} cases`);
    check(document.contract_version === '1.0.0', `${file}: contract version drifted`);
    for (const sourceContract of document.source_contracts) {
      await readFile(resolve(serviceRoot, sourceContract.project_path), 'utf8');
    }
    for (const fixtureCase of document.cases) {
      check(!caseIds.has(fixtureCase.id), `duplicate fixture case ${fixtureCase.id}`);
      caseIds.add(fixtureCase.id);
      caseCount += 1;
      expectationCounts[fixtureCase.expectation] += 1;
      if (fixtureCase.expectation === 'correction') correctionIds.add(fixtureCase.id);
      collectStrings(fixtureCase.input, strings);
      collectStrings(fixtureCase.expected, strings);

      const objects = [];
      collectObjects(fixtureCase.input, objects);
      collectObjects(fixtureCase.expected, objects);
      for (const object of objects) {
        const keys = new Set(Object.keys(object));
        if (
          ['platform', 'source_identity', 'outcome', 'evidence_code', 'checked_at', 'http_status'].every(
            (key) => keys.has(key),
          )
        ) {
          const publicProjection = {
            platform: object.platform,
            outcome: object.outcome,
            evidence_code: object.evidence_code,
            checked_at: projectedUtcTimestamp(object.checked_at),
            http_status: object.http_status,
          };
          const consistentPair =
            evidenceByOutcome.get(object.outcome)?.has(object.evidence_code) === true;
          if (consistentPair) {
            assertValid(validatePublicEvidence, publicProjection, `${fixtureCase.id} projection`);
            assertValid(validateSourceObservation, object, `${fixtureCase.id} observation`);
          } else {
            check(
              fixtureCase.id === 'compatibility-rejects-outcome-evidence-mismatch',
              `${fixtureCase.id}: unapproved outcome/evidence mismatch`,
            );
            check(
              !validatePublicEvidence(publicProjection),
              `${fixtureCase.id}: public projection accepted an outcome/evidence mismatch`,
            );
          }
        }
      }
    }
  }

  check(caseCount === 65, `expected 65 fixture cases, received ${caseCount}`);
  const coveredEvidence = new Set([...expectedEvidence].filter((value) => strings.has(value)));
  const coveredOutcomes = new Set([...expectedOutcomes].filter((value) => strings.has(value)));
  const coveredAvailability = new Set(
    [...expectedAvailabilityStatuses].filter((value) => strings.has(value)),
  );
  const coveredRuns = new Set([...expectedRunStatuses].filter((value) => strings.has(value)));
  check(equalSets(coveredEvidence, expectedEvidence), 'fixture evidence coverage is incomplete');
  check(equalSets(coveredOutcomes, expectedOutcomes), 'fixture outcome coverage is incomplete');
  check(
    equalSets(coveredAvailability, expectedAvailabilityStatuses),
    'fixture availability-status coverage is incomplete',
  );
  check(equalSets(coveredRuns, expectedRunStatuses), 'fixture run-status coverage is incomplete');
  check(
    equalSets(correctionIds, expectedCorrectionIds),
    `correction fixture set drifted: ${JSON.stringify(sorted(correctionIds))}`,
  );

  const persistedSet = fixtureSets.find(
    ({ document }) => document.fixture_type === 'persisted_compatibility',
  );
  check(persistedSet !== undefined, 'persisted compatibility fixtures missing');
  const persistedValidators = {
    AvailabilityStateDocument: validateAvailabilityState,
    AvailabilityRunDocument: validateAvailabilityRun,
    PerJobEvidenceDocument: validatePerJobEvidence,
  };
  for (const fixtureCase of persistedSet.document.cases) {
    const validate = persistedValidators[fixtureCase.input.schema_name];
    check(
      validate !== undefined,
      `${fixtureCase.id}: unknown schema ${fixtureCase.input.schema_name}`,
    );
    const actual = validate(fixtureCase.input.document);
    check(
      actual === fixtureCase.expected.valid,
      `${fixtureCase.id}: expected valid=${fixtureCase.expected.valid}; ${formatAjvErrors(validate)}`,
    );
    if (fixtureCase.input.comparison_document !== undefined) {
      const comparisonActual = validate(fixtureCase.input.comparison_document);
      check(
        comparisonActual === fixtureCase.expected.comparison_valid,
        `${fixtureCase.id}: comparison validity drifted; ${formatAjvErrors(validate)}`,
      );
      const firstInstant = Date.parse(fixtureCase.input.document.last_checked_at);
      const secondInstant = Date.parse(fixtureCase.input.comparison_document.last_checked_at);
      check(
        (firstInstant === secondInstant) === fixtureCase.expected.same_instant,
        `${fixtureCase.id}: instant equivalence drifted`,
      );
    }
    if (Array.isArray(fixtureCase.input.additional_negative_documents)) {
      check(
        fixtureCase.input.additional_negative_documents.length ===
          fixtureCase.expected.additional_results.length,
        `${fixtureCase.id}: additional negative count drifted`,
      );
      fixtureCase.input.additional_negative_documents.forEach((entry, index) => {
        const expected = fixtureCase.expected.additional_results[index];
        const additionalActual = validate(entry.document);
        check(
          additionalActual === expected.valid,
          `${fixtureCase.id}/${entry.label}: expected valid=${expected.valid}; ${formatAjvErrors(validate)}`,
        );
      });
    }
  }

  check(manifest.manifest_schema_version === 1, 'fixture manifest version must be 1');
  check(manifest.manifest_version === 1, 'fixture manifest contract version must be 1');
  check(manifest.contract_version === '1.0.0', 'fixture manifest contract drifted');
  check(manifest.fixture_set_schema_version === 1, 'fixture-set version drifted');
  check(manifest.hash_algorithm === 'sha256', 'manifest hash algorithm drifted');
  const expectedManifestFiles = new Set([
    'availability-fixture-set-v1.schema.json',
    ...fixtureFiles,
  ]);
  const manifestFiles = new Set(manifest.files.map(({ path }) => path));
  check(equalSets(manifestFiles, expectedManifestFiles), 'manifest file set drifted');
  check(manifest.case_counts?.total === 65, 'manifest total case count drifted');
  check(manifest.total_cases === 65, 'manifest total_cases drifted');
  check(
    equalSets(new Set(manifest.coverage.evidence_codes), expectedEvidence),
    'manifest evidence coverage drifted',
  );
  check(
    equalSets(new Set(manifest.coverage.availability_statuses), expectedAvailabilityStatuses),
    'manifest availability status coverage drifted',
  );
  check(
    equalSets(new Set(manifest.coverage.outcomes), expectedOutcomes),
    'manifest outcome coverage drifted',
  );
  check(
    equalSets(new Set(manifest.coverage.run_statuses), expectedRunStatuses),
    'manifest run status coverage drifted',
  );
  check(
    equalSets(new Set(manifest.correction_case_ids), correctionIds),
    'manifest correction coverage drifted',
  );
  const rawHashes = [];
  for (const entry of manifest.files) {
    const content = await readFile(resolve(fixtureDirectory, entry.path));
    const digest = sha256(content);
    check(entry.sha256 === digest, `manifest hash mismatch for ${entry.path}`);
    rawHashes.push(`${entry.path}:${digest}`);
    if (entry.case_count !== undefined) {
      const document = JSON.parse(content.toString('utf8'));
      check(entry.case_count === document.cases.length, `${entry.path}: manifest count drifted`);
    }
  }
  const corpusSha256 = sha256(rawHashes.sort().join('\n'));
  check(manifest.corpus_sha256 === corpusSha256, 'manifest corpus hash mismatch');

  const summary = {
    result: 'PASS',
    contract_version: '1.0.0',
    openapi: {
      version: openapi.openapi,
      paths: expectedOperations.size,
      operations: operationCount,
      source_sha256: sha256(openapiSource),
    },
    schemas: {
      dialect: publicSchema.$schema,
      documents: 3,
      public_source_sha256: sha256(publicSchemaSource),
      persisted_source_sha256: sha256(persistedSchemaSource),
      fixture_set_source_sha256: sha256(fixtureSchemaSource),
    },
    fixtures: {
      sets: fixtureSets.length,
      cases: caseCount,
      expectations: expectationCounts,
      corrections: correctionIds.size,
      evidence_codes: sorted(coveredEvidence),
      availability_statuses: sorted(coveredAvailability),
      outcomes: sorted(coveredOutcomes),
      run_statuses: sorted(coveredRuns),
      corpus_sha256: corpusSha256,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
