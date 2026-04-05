# ImapConnectionPool

`src/bridge/pool.ts` — manages a pool of authenticated `ImapFlow` connections to the local Proton Bridge IMAP daemon.

The pool is a shared singleton across all transport modes (STDIO, HTTP, HTTPS). Each `McpServer` session shares the same pool instance; the pool is started once at process boot and stopped on shutdown.

## Configuration

The pool accepts a `ConnectionPoolConfig` object at construction. It does not resolve configuration sources itself.

| Parameter | Default | Purpose |
|---|---|---|
| `min` | 1 | Minimum connections to keep alive. `start()` pre-creates this many; `#replenish()` restores to this floor after errors or drains. |
| `max` | 5 | Hard ceiling on concurrent connections. Requests beyond this queue in the waiter list. |
| `idleDrainSecs` | 30 | Seconds of inactivity before excess connections above `min` are closed. |
| `idleTimeoutSecs` | 300 | Seconds of inactivity before all connections are closed and the pool version is bumped. |

## Connection Lifecycle

### Creation

`#createConnection()` opens an `ImapFlow` connection, stamps it with the current `#poolVersion`, and attaches an error listener. Connections are created in two contexts:

- **Replenish** — `#replenish()` runs after `start()`, after errors, and after drains to restore the pool to `min`. New connections are either handed directly to a waiting caller or placed in the available stack.
- **On-demand** — `acquire()` creates a connection inline when the available stack is empty and total connections are below `max`.

### Acquisition

`acquire()` follows three paths in order:

1. **From pool** — pop from `#available` (LIFO). O(1), reuses the most recently used connection.
2. **On-demand** — if `#inUse.size < max`, create a new connection.
3. **Wait** — push a callback onto `#waiters`. The caller's promise resolves when a connection becomes available through `release()` or `#replenish()`.

Every `acquire()` call updates `#lastActivityAt`, which drives idle timer decisions.

### Release

`release(conn)` looks up the connection's version from `#inUse` and takes one of three paths:

1. **Stale** (version < `#poolVersion`) — the connection predates the current pool generation. It is logged out and discarded. If this was the last in-use stale connection, drain waiters are notified. `#replenish()` fires to restore the pool to `min`.
2. **Hand to waiter** — if `#waiters` is non-empty, the connection is passed directly to the next queued callback without touching `#available`.
3. **Return to pool** — pushed back onto `#available`.

### Destruction

`stop()` clears the idle timer, logs out every connection (available and in-use), and clears all internal state. Logout errors are silently caught to guarantee cleanup completes even if connections are already broken.

## Version-Based Drain Pattern

The pool uses an integer `#poolVersion` to support non-blocking drains. Each `PoolEntry` carries the version it was created under. When `drain()` is called:

1. `#poolVersion` is incremented.
2. All `#available` connections are closed immediately.
3. In-use connections continue operating undisturbed — they are closed lazily when `release()` detects their version is stale.
4. Once all in-use stale connections have been released, drain waiters are resolved.
5. `#replenish()` creates fresh connections stamped with the new version.

This pattern avoids blocking callers mid-operation. A tool handler that acquired a connection before the drain can finish its IMAP commands normally; the connection is simply discarded on release instead of returned to the pool.

The same version mechanism is used by `#drainToZero()` (idle timeout). `#drainToMin()` does not bump the version — it only trims excess available connections.

## Idle Management

A `setInterval` timer checks every 10 seconds whether the pool has been idle (no `acquire()` calls):

| Idle duration | Action | Method |
|---|---|---|
| >= `idleDrainSecs` (30s) | Close available connections above `min` | `#drainToMin()` |
| >= `idleTimeoutSecs` (300s) | Close all available connections, bump pool version | `#drainToZero()` |

The timer is `unref()`'d so it does not prevent Node.js process exit. It is cleared in `stop()`.

`#drainToMin()` trims from the front of the `#available` array (oldest connections first, since `acquire` pops from the back).

`#drainToZero()` is more aggressive: it bumps the pool version so that any in-use connections are also discarded on release. The pool does not eagerly replenish after a zero-drain — new connections are created on the next `acquire()`.

## Error Handling

Each connection gets an `error` event listener that calls `#onError(conn)`:

1. The connection is removed from whichever tracking structure it belongs to (`#inUse` or `#available`).
2. `#replenish()` is called to restore the pool to `min`.

This isolates failures to individual connections. A single broken connection does not cascade or block other operations.

## Waiter Queue

When the pool is at `max` capacity, `acquire()` pushes a callback onto `#waiters` and returns a promise. Connections reach waiters through two paths:

- **release()** — a current-version connection is handed directly to `#waiters.shift()`.
- **#replenish()** — newly created connections check the waiter queue before entering `#available`.

The queue is FIFO (shift from front), ensuring fairness among blocked callers.

## Connectivity Verification

`verifyConnectivity()` opens a throwaway connection outside the pool, sends a NOOP command, and closes it. This tests IMAP reachability without affecting pool state or counts.

## Design Choices and Trade-offs

### LIFO Available Stack

Connections are pushed and popped from the end of `#available`, making it a LIFO stack. The most recently returned connection is reused first.

- **Benefit:** Keeps a small number of connections "warm" under low load. Excess connections drift to the bottom and are eventually trimmed by `#drainToMin()`.
- **Drawback:** Bottom-of-stack connections may go unused for long periods without keepalive, risking silent staleness.

### Version Drain vs. Blocking Drain

The pool increments a version counter instead of blocking `acquire()` during drain.

- **Benefit:** In-flight operations complete normally. No deadlocks, no timeouts, no special "draining" state that callers need to handle.
- **Drawback:** Drain is not instantaneous — in-use connections linger until their callers call `release()`. The `drain()` method awaits this via `#drainWaiters`, but the wall-clock time depends on how long current operations take.

### No Health Checks or Keepalive

The pool does not periodically ping idle connections.

- **Benefit:** Simpler implementation, no background IMAP traffic. Proton Bridge is a localhost daemon with low latency and stable connections.
- **Drawback:** If the bridge restarts or a connection silently drops, the caller discovers the failure at operation time rather than proactively. The error handler removes the dead connection and replenishes, but the triggering operation fails.

### No Acquire Timeout

`acquire()` will wait indefinitely if the pool is at max and no connections are released.

- **Benefit:** Simpler contract — callers don't need to handle timeout errors.
- **Drawback:** A leaked connection (one that is never released) would permanently reduce pool capacity. If all `max` connections leak, `acquire()` hangs forever. This is mitigated by the strict `try/finally` release pattern enforced in `ImapClient`.

### Callback Waiters vs. Semaphore

The pool uses a simple callback array rather than an `AsyncSemaphore` or similar abstraction.

- **Benefit:** Zero dependencies, transparent control flow, easy to reason about. The queue is just an array of functions.
- **Drawback:** No built-in cancellation, priority, or fairness guarantees beyond FIFO order. Not a practical issue given the pool's small `max` size and short-lived IMAP operations.
