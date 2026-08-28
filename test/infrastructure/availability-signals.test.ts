import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  AvailabilitySignals,
  createJsonLineSignalSink,
  type AvailabilitySignal,
} from '../../src/infrastructure/telemetry/availability-signals.js';

const signal: AvailabilitySignal = {
  request_id: 'request-1',
  owner_key: 'local-operator',
  operation: 'check-job',
  result_status: '200',
  duration_ms: 25,
  retry_count: 1,
  source_count: 2,
  evidence_code_counts: { apply_action_present: 2 },
  n8n_execution_id: 'execution-1',
  run_id: 'run-1',
};

class ControlledWriter extends EventEmitter {
  public readonly writes: string[] = [];
  public returnValue = true;
  public throwOnWrite = false;

  public write(value: string | Uint8Array): boolean {
    if (this.throwOnWrite) throw new Error('injected writer failure');
    this.writes.push(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
    return this.returnValue;
  }
}

function writable(writer: ControlledWriter): NodeJS.WritableStream {
  return writer as unknown as NodeJS.WritableStream;
}

describe('privacy-safe telemetry writer', () => {
  it('writes one structured JSON line and bounds backpressure without queueing signals', () => {
    const writer = new ControlledWriter();
    writer.returnValue = false;
    const sink = createJsonLineSignalSink(writable(writer));

    expect(() => { void sink(signal); }).not.toThrow();
    expect(writer.writes).toEqual([`${JSON.stringify(signal)}\n`]);
    void sink({ ...signal, request_id: 'request-dropped' });
    expect(writer.writes).toHaveLength(1);

    writer.returnValue = true;
    writer.emit('drain');
    void sink({ ...signal, request_id: 'request-after-drain' });
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[1]).toContain('request-after-drain');
  });

  it('absorbs both synchronous write failures and asynchronous stream errors', () => {
    const throwingWriter = new ControlledWriter();
    throwingWriter.throwOnWrite = true;
    const throwingSink = createJsonLineSignalSink(writable(throwingWriter));
    expect(() => { void throwingSink(signal); }).not.toThrow();
    throwingWriter.throwOnWrite = false;
    void throwingSink(signal);
    expect(throwingWriter.writes).toEqual([]);

    const asynchronousWriter = new ControlledWriter();
    const asynchronousSink = createJsonLineSignalSink(writable(asynchronousWriter));
    void asynchronousSink(signal);
    expect(() => asynchronousWriter.emit('error', new Error('injected EPIPE'))).not.toThrow();
    void asynchronousSink({ ...signal, request_id: 'request-after-error' });
    expect(asynchronousWriter.writes).toHaveLength(1);
  });

  it('keeps domain-facing emission fail-open for a rejected asynchronous sink', async () => {
    const signals = new AvailabilitySignals(async () => {
      await Promise.resolve();
      throw new Error('injected telemetry outage');
    });
    expect(() => signals.emit(signal)).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});
