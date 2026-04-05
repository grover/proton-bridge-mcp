import type { OperationRecord } from '../types/operations.js';

export const MAX_LOG_SIZE = 100;

export class OperationLog {
  #seq  = 0;
  #ring: OperationRecord[] = [];

  push(_record: Omit<OperationRecord, 'id'>): number {
    throw new Error('Not implemented');
  }

  getFrom(_operationId: number): OperationRecord[] {
    throw new Error('Not implemented');
  }

  has(_operationId: number): boolean {
    throw new Error('Not implemented');
  }

  remove(_operationId: number): void {
    throw new Error('Not implemented');
  }

  clear(): void {
    throw new Error('Not implemented');
  }

  get size(): number {
    return this.#ring.length;
  }
}
