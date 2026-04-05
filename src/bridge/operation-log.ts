import type { OperationRecord } from '../types/operations.js';

export const DEFAULT_MAX_LOG_SIZE = 100;

export class OperationLog {
  readonly #maxSize: number;
  #seq  = 0;
  #ring: OperationRecord[] = [];

  constructor(maxSize: number = DEFAULT_MAX_LOG_SIZE) {
    this.#maxSize = maxSize;
  }

  push(record: Omit<OperationRecord, 'id'>): number {
    const id = ++this.#seq;
    this.#ring.push({ ...record, id });
    if (this.#ring.length > this.#maxSize) {
      this.#ring.shift();
    }
    return id;
  }

  getFrom(operationId: number): OperationRecord[] {
    const idx = this.#ring.findIndex(r => r.id === operationId);
    if (idx === -1) return [];
    return this.#ring.slice(idx).reverse();
  }

  has(operationId: number): boolean {
    return this.#ring.some(r => r.id === operationId);
  }

  remove(operationId: number): void {
    const idx = this.#ring.findIndex(r => r.id === operationId);
    if (idx !== -1) this.#ring.splice(idx, 1);
  }

  clear(): void {
    this.#ring = [];
  }

  get size(): number {
    return this.#ring.length;
  }
}
