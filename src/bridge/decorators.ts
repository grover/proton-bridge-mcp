import type { AuditLogger } from './audit.js';

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
