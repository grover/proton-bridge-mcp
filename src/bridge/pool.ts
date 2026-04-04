import { ImapFlow } from 'imapflow';
import type { ProtonMailBridgeConfig, ConnectionPoolConfig } from '../types/index.js';
import type { AppLogger } from '../logger.js';

interface PoolEntry {
  conn:    ImapFlow;
  version: number;
}

export class ImapConnectionPool {
  #poolVersion = 0;
  #available: PoolEntry[] = [];
  #inUse: Map<ImapFlow, number> = new Map(); // conn → version at acquire time
  #waiters: Array<(entry: PoolEntry) => void> = [];
  #drainWaiters: Array<() => void> = [];
  #lastActivityAt = Date.now();
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  readonly #config:     ProtonMailBridgeConfig;
  readonly #poolConfig: ConnectionPoolConfig;
  readonly #logger:     AppLogger;

  constructor(
    config:     ProtonMailBridgeConfig,
    poolConfig: ConnectionPoolConfig,
    logger:     AppLogger,
  ) {
    this.#config     = config;
    this.#poolConfig = poolConfig;
    this.#logger     = logger;
  }

  async start(): Promise<void> {
    this.#logger.info(
      { min: this.#poolConfig.min, max: this.#poolConfig.max,
        idleDrainSecs: this.#poolConfig.idleDrainSecs,
        idleTimeoutSecs: this.#poolConfig.idleTimeoutSecs },
      '[pool] starting — creating minimum connections',
    );
    await this.#replenish();
    this.#startIdleTimer();
  }

  async stop(): Promise<void> {
    if (this.#idleTimer !== undefined) {
      clearInterval(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    this.#logger.info(
      { available: this.#available.length, inUse: this.#inUse.size },
      '[pool] stopping — logging out all connections',
    );
    const all = [...this.#available.map(e => e.conn), ...this.#inUse.keys()];
    this.#available = [];
    await Promise.all(all.map(conn => conn.logout().catch(() => {})));
    this.#inUse.clear();
  }

  /**
   * Drain: increment pool version, close all available connections immediately.
   * In-use connections are closed when released (version check in release()).
   * Pool replenishes to min after drain. No restart needed.
   */
  async drain(): Promise<void> {
    this.#poolVersion++;
    const currentVersion = this.#poolVersion;

    this.#logger.info(
      { newVersion: currentVersion, closing: this.#available.length, inUse: this.#inUse.size },
      '[pool] draining — incrementing pool version',
    );

    const toClose = [...this.#available];
    this.#available = [];
    await Promise.all(toClose.map(e => e.conn.logout().catch(() => {})));

    // Notify any waiters that there are no more available connections
    // They'll get new connections when #replenish runs
    if (this.#inUse.size > 0) {
      await new Promise<void>((resolve) => {
        this.#drainWaiters.push(resolve);
      });
    }

    this.#logger.info({ version: currentVersion }, '[pool] drain complete — replenishing');
    void this.#replenish();
  }

  async acquire(): Promise<ImapFlow> {
    this.#lastActivityAt = Date.now();

    // Try to get a free connection from the available pool
    const entry = this.#available.pop();
    if (entry) {
      this.#inUse.set(entry.conn, entry.version);
      this.#logger.debug(
        { available: this.#available.length, inUse: this.#inUse.size },
        '[pool] connection acquired (from pool)',
      );
      return entry.conn;
    }

    // Create a new connection if under max
    if (this.#inUse.size < this.#poolConfig.max) {
      const newEntry = await this.#createConnection();
      this.#inUse.set(newEntry.conn, newEntry.version);
      this.#logger.debug(
        { available: this.#available.length, inUse: this.#inUse.size },
        '[pool] connection acquired (new)',
      );
      return newEntry.conn;
    }

    // Wait for a connection to become available
    this.#logger.debug('[pool] waiting for connection (pool at max)');
    return new Promise<ImapFlow>((resolve) => {
      this.#waiters.push((entry) => {
        this.#inUse.set(entry.conn, entry.version);
        this.#logger.debug(
          { available: this.#available.length, inUse: this.#inUse.size },
          '[pool] connection acquired (waited)',
        );
        resolve(entry.conn);
      });
    });
  }

  release(conn: ImapFlow): void {
    const version = this.#inUse.get(conn);
    this.#inUse.delete(conn);

    if (version === undefined) {
      this.#logger.warn('[pool] release() called for an unknown connection');
      return;
    }

    if (version < this.#poolVersion) {
      // Stale connection from a previous pool version — close it
      conn.logout().catch(() => {});
      this.#logger.debug(
        { connVersion: version, poolVersion: this.#poolVersion },
        '[pool] closing stale connection on release',
      );
      // Notify drain waiters if pool is now empty
      if (this.#inUse.size === 0 && this.#drainWaiters.length > 0) {
        this.#drainWaiters.forEach(r => r());
        this.#drainWaiters = [];
      }
      // Replenish to min with current-version connections
      void this.#replenish();
      return;
    }

    // Return to pool or hand to a waiter
    if (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift()!;
      this.#inUse.set(conn, version); // re-mark as in-use for the waiter
      this.#inUse.delete(conn);       // undo the re-mark (waiter will call acquire path)
      waiter({ conn, version });
    } else {
      this.#available.push({ conn, version });
    }

    this.#logger.debug(
      { available: this.#available.length, inUse: this.#inUse.size },
      '[pool] connection released',
    );
  }

  /** Test connectivity without affecting the pool */
  async verifyConnectivity(): Promise<
    { success: true; latencyMs: number } | { success: false; error: string }
  > {
    const start = Date.now();
    let conn: ImapFlow | undefined;
    try {
      conn = await this.#makeRawConnection();
      await conn.noop();
      return { success: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (conn) conn.logout().catch(() => {});
    }
  }

  #onError(conn: ImapFlow): void {
    const version = this.#inUse.get(conn);
    if (version !== undefined) {
      this.#inUse.delete(conn);
    } else {
      const idx = this.#available.findIndex(e => e.conn === conn);
      if (idx !== -1) this.#available.splice(idx, 1);
    }
    this.#logger.warn(
      { available: this.#available.length, inUse: this.#inUse.size },
      '[pool] connection error — removed from pool, replenishing',
    );
    void this.#replenish();
  }

  async #replenish(): Promise<void> {
    const total = this.#available.length + this.#inUse.size;
    const toCreate = this.#poolConfig.min - total;
    if (toCreate <= 0) return;

    await Promise.all(
      Array.from({ length: toCreate }, () =>
        this.#createConnection().then((entry) => {
          if (this.#waiters.length > 0) {
            const waiter = this.#waiters.shift()!;
            this.#inUse.set(entry.conn, entry.version);
            waiter(entry);
          } else {
            this.#available.push(entry);
          }
        }).catch((err: unknown) => {
          this.#logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            '[pool] failed to create connection during replenish',
          );
        }),
      ),
    );
  }

  async #createConnection(): Promise<PoolEntry> {
    const conn = await this.#makeRawConnection();
    const version = this.#poolVersion;

    conn.on('error', () => this.#onError(conn));

    this.#logger.debug(
      { version, available: this.#available.length + 1, inUse: this.#inUse.size },
      '[pool] new connection established',
    );

    return { conn, version };
  }

  /**
   * Idle timer: checks every 10 s.
   * - If idle ≥ idleTimeoutSecs → drain to zero (pool recreates on next use).
   * - If idle ≥ idleDrainSecs  → drain excess connections above min.
   */
  #startIdleTimer(): void {
    const checkMs = 10_000;
    this.#idleTimer = setInterval(() => {
      const idleSecs = (Date.now() - this.#lastActivityAt) / 1000;
      if (idleSecs >= this.#poolConfig.idleTimeoutSecs) {
        void this.#drainToZero();
      } else if (idleSecs >= this.#poolConfig.idleDrainSecs) {
        this.#drainToMin();
      }
    }, checkMs);
    // Don't keep process alive just for the idle timer
    this.#idleTimer.unref?.();
  }

  /** Close connections in #available above min. Does not touch in-use connections. */
  #drainToMin(): void {
    const excess = this.#available.length - this.#poolConfig.min;
    if (excess <= 0) return;
    const toClose = this.#available.splice(0, excess);
    for (const entry of toClose) {
      entry.conn.logout().catch(() => {});
    }
    this.#logger.info(
      { closed: toClose.length, remaining: this.#available.length },
      '[pool] idle drain — reduced to minimum',
    );
  }

  /**
   * Close all available connections and increment pool version so in-use
   * connections are discarded on release rather than returned to the pool.
   * Pool replenishes to min on the next acquire().
   */
  async #drainToZero(): Promise<void> {
    if (this.#available.length === 0 && this.#inUse.size === 0) return;
    this.#poolVersion++;
    const toClose = [...this.#available];
    this.#available = [];
    await Promise.all(toClose.map(e => e.conn.logout().catch(() => {})));
    this.#logger.info(
      { version: this.#poolVersion, inUse: this.#inUse.size },
      '[pool] idle timeout — emptied available connections',
    );
  }

  #makeRawConnection(): Promise<ImapFlow> {
    return new Promise<ImapFlow>((resolve, reject) => {
      const conn = new ImapFlow({
        host:   this.#config.host,
        port:   this.#config.imapPort,
        secure: false,
        auth: {
          user: this.#config.username,
          pass: this.#config.password,
        },
        tls:    this.#config.tls,
        logger: false,
      });

      conn.connect()
        .then(() => resolve(conn))
        .catch(reject);
    });
  }
}
