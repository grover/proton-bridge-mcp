import { appendFile } from 'node:fs/promises';
import type { AuditEntry, AuditOutcome } from '../types/index.js';

export class AuditLogger {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async wrap<T>(
    operation: string,
    input:     unknown,
    fn:        () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    let outcome: AuditOutcome = 'success';
    let error: string | undefined;
    let result: T;

    try {
      result = await fn();
    } catch (err) {
      outcome = 'error';
      error = err instanceof Error ? err.message : String(err);
      await this.#write({
        timestamp:  new Date().toISOString(),
        operation,
        durationMs: Date.now() - start,
        input:      this.#sanitize(input),
        outcome,
        error,
      });
      throw err;
    }

    const entry: AuditEntry = {
      timestamp:  new Date().toISOString(),
      operation,
      durationMs: Date.now() - start,
      input:      this.#sanitize(input),
      outcome,
    };

    // Add batch counts if result is an array
    if (Array.isArray(result)) {
      entry.itemCount = result.length;
      entry.errorCount = result.filter(
        (r): r is { error: unknown } =>
          typeof r === 'object' && r !== null && 'error' in r && (r as Record<string, unknown>)['error'] !== undefined,
      ).length;
      if (entry.errorCount > 0) entry.outcome = 'partial';
    }

    await this.#write(entry);
    return result;
  }

  #sanitize(input: unknown): unknown {
    if (typeof input !== 'object' || input === null) return input;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (/password|secret|token|auth/i.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async #write(entry: AuditEntry): Promise<void> {
    try {
      await appendFile(this.#filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Audit write failure must not crash the application
    }
  }
}
