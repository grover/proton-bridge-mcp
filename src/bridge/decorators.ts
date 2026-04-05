import type { AuditLogger } from './audit.js';
import type { OperationLog } from './operation-log.js';
import type { ReversalSpec } from '../types/operations.js';

/**
 * Method decorator — wraps the decorated ImapClient method in `this.audit.wrap()`.
 * Requires the class to have a public `audit: AuditLogger` property.
 *
 * Uses TypeScript's `experimentalDecorators` API so that TypeScript compiles the
 * decorator to `__decorate` helper calls. This avoids emitting raw TC39 decorator
 * syntax, which Node.js does not yet parse without a V8 flag.
 */
export function Audited(operation: string) {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (this: { audit: AuditLogger }, ...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: { audit: AuditLogger }, ...args: unknown[]) {
      return this.audit.wrap(operation, args[0], () => original.apply(this, args));
    };
    return descriptor;
  };
}

/**
 * Build-reversal function signature for @Tracked.
 * Returns a ReversalSpec on success, or null to skip tracking (e.g. createFolder with created===false).
 */
export type BuildReversalFn = (args: unknown[], result: unknown) => ReversalSpec | null;

/**
 * Method decorator — after the method succeeds, builds a ReversalSpec and pushes it
 * to `this.log`. Extends the result with `operationId`.
 * Requires the class to have a public `log: OperationLog` property.
 */
export function Tracked(toolName: string, buildReversal: BuildReversalFn) {
  return function (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor {
    const original = descriptor.value as (this: { log: OperationLog }, ...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: { log: OperationLog }, ...args: unknown[]) {
      const result = await original.apply(this, args);
      const reversal = buildReversal(args, result);
      if (reversal !== null) {
        const operationId = this.log.push({
          tool: toolName,
          reversal,
          timestamp: new Date().toISOString(),
        });
        return { ...(result as object), operationId };
      }
      return result;
    };
    return descriptor;
  };
}

/**
 * Method decorator — after the method succeeds, clears the entire operation log.
 * Reserved for irreversible operations (e.g. delete_folder).
 * Requires the class to have a public `log: OperationLog` property.
 */
export function Irreversible(
  _target: object,
  _propertyKey: string | symbol,
  descriptor: PropertyDescriptor,
): PropertyDescriptor {
  const original = descriptor.value as (this: { log: OperationLog }, ...args: unknown[]) => Promise<unknown>;
  descriptor.value = async function (this: { log: OperationLog }, ...args: unknown[]) {
    const result = await original.apply(this, args);
    this.log.clear();
    return result;
  };
  return descriptor;
}
