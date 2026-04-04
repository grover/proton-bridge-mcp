import type { AuditLogger } from './audit.js';

/**
 * TC39 Stage 3 method decorator.
 * Wraps the decorated ImapClient method in `this.audit.wrap()`.
 * Requires the class to have a public `audit: AuditLogger` property.
 */
export function Audited(operation: string) {
  return function <
    This extends { audit: AuditLogger },
    Args extends unknown[],
    Return,
  >(
    originalMethod: (this: This, ...args: Args) => Promise<Return>,
    _context: ClassMethodDecoratorContext,
  ): (this: This, ...args: Args) => Promise<Return> {
    return async function (this: This, ...args: Args): Promise<Return> {
      return this.audit.wrap(operation, args[0], () =>
        originalMethod.apply(this, args),
      );
    };
  };
}
