export type AvailabilitySignal = {
  request_id: string;
  owner_key: string;
  operation: string;
  result_status: string;
  duration_ms: number;
  retry_count: number;
  source_count: number;
  evidence_code_counts: Readonly<Record<string, number>>;
  n8n_execution_id?: string;
  run_id?: string;
};

export type SignalSink = (signal: Readonly<AvailabilitySignal>) => void | Promise<void>;

function boundedIdentifier(value: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value) ? value : 'invalid';
}

function boundedCounts(value: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, count]) => /^[a-z][a-z0-9_]{0,63}$/u.test(key) && Number.isInteger(count))
      .slice(0, 18)
      .map(([key, count]) => [key, Math.max(0, Math.min(1_000, count))]),
  );
}

export class AvailabilitySignals {
  public constructor(private readonly sink: SignalSink) {}

  public emit(signal: AvailabilitySignal): void {
    const safe: AvailabilitySignal = {
      request_id: boundedIdentifier(signal.request_id),
      owner_key: boundedIdentifier(signal.owner_key),
      operation: boundedIdentifier(signal.operation),
      result_status: boundedIdentifier(signal.result_status),
      duration_ms: Math.max(0, Math.min(60_000, Math.trunc(signal.duration_ms))),
      retry_count: Math.max(0, Math.min(20, Math.trunc(signal.retry_count))),
      source_count: Math.max(0, Math.min(20, Math.trunc(signal.source_count))),
      evidence_code_counts: boundedCounts(signal.evidence_code_counts),
      ...(signal.n8n_execution_id === undefined
        ? {}
        : { n8n_execution_id: boundedIdentifier(signal.n8n_execution_id) }),
      ...(signal.run_id === undefined ? {} : { run_id: boundedIdentifier(signal.run_id) }),
    };
    try {
      const result = this.sink(Object.freeze(safe));
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Telemetry is fail-open by contract.
    }
  }
}

export function createJsonLineSignalSink(stream: NodeJS.WritableStream): SignalSink {
  let accepting = true;
  stream.on('error', () => {
    accepting = false;
  });
  stream.on('drain', () => {
    accepting = true;
  });
  return (signal) => {
    if (!accepting) return;
    try {
      accepting = stream.write(`${JSON.stringify(signal)}\n`);
    } catch {
      accepting = false;
    }
  };
}

export const jsonLineSignalSink: SignalSink = createJsonLineSignalSink(process.stdout);
