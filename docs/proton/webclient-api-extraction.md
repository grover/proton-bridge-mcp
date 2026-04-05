# Extracting the ProtonMail API Client from WebClients

> Analysis of [proton-mail/WebClients](https://github.com/ProtonMail/WebClients) for the purpose of extracting a standalone ProtonMail email API client, bypassing IMAP entirely.

## Why Consider This

The MCP server currently talks to ProtonMail through the Bridge's IMAP daemon. This works but imposes the IMAP virtualization layer — labels become folders, messages get copy UIDs, and we spend effort devirtualizing everything back (see [bridge-label-implementation.md](bridge-label-implementation.md)). A direct API client would eliminate the middleman: no UID mapping, no COPYUID resolution, no Message-ID searches to find label copies. Labels would just be label IDs on a message.

## Monorepo Structure

WebClients is a Yarn 4 workspace monorepo with Turbo for task orchestration.

**[package.json](~/Projects/WebClients/package.json):**
```json
{
  "packageManager": "yarn@4.13.0",
  "engines": { "node": ">= 22.14.0 < 23.6.0" },
  "license": "GPL-3.0",
  "devDependencies": { "turbo": "2.8.7" }
}
```

**Workspace layout:**
```
WebClients/
├── applications/          # 21 web apps (mail, calendar, drive, pass, etc.)
│   └── mail/              # Proton Mail web client (React + Redux)
├── packages/              # ~57 shared packages
│   ├── shared/            # Core: API definitions, types, auth, fetch — GPL-3.0
│   ├── crypto/            # CryptoProxy, Web Worker pool — MIT
│   ├── srp/               # SRP-6a authentication — MIT
│   ├── mail/              # Mail business logic + Redux store
│   ├── components/        # React UI components
│   └── ...
└── turbo.json
```

The mail API client is **not a standalone package**. It's distributed across `packages/shared` (API definitions + types), `packages/crypto` (message decryption), `packages/srp` (authentication), and `packages/mail` (business logic).

## The API Layer — Surprisingly Clean

The API endpoint definitions in `packages/shared/lib/api/` are **pure functions returning config objects**. They have zero runtime dependencies — only `import type` statements.

**[packages/shared/lib/api/messages.ts](~/Projects/WebClients/packages/shared/lib/api/messages.ts)** (302 lines):
```typescript
import type { SimpleMap } from '../interfaces';
import type { Message } from '../interfaces/mail/Message';
// ... all imports are type-only

export const queryMessageMetadata = ({ LabelID, Sort = 'Time', Desc = 1, ... }) => ({
    method: 'get',
    url: 'mail/v4/messages',
    params: { LabelID, Sort, Desc, ... },
});

export const getMessage = (messageID: string) => ({
    method: 'get',
    url: `mail/v4/messages/${messageID}`,
});

export const labelMessages = ({ LabelID, IDs, SpamAction }: { ... }) => ({
    method: 'put',
    url: 'mail/v4/messages/label',
    data: { LabelID, IDs, SpamAction },
});

export const unlabelMessages = ({ LabelID, IDs }: { ... }) => ({
    method: 'put',
    url: 'mail/v4/messages/unlabel',
    data: { LabelID, IDs },
});

export const markMessageAsRead = (IDs: string[]) => ({
    method: 'put',
    url: 'mail/v4/messages/read',
    data: { IDs },
});
```

Every function returns `{ method, url, data?, params? }` — a descriptor that gets passed to the API caller. This is the **easiest layer to extract**. You could rewrite these as plain fetch calls in an afternoon.

**[packages/shared/lib/api/labels.ts](~/Projects/WebClients/packages/shared/lib/api/labels.ts)** (108 lines):
```typescript
export const create = ({ Name, Color, Type, Notify, ParentID, Expanded }) => ({
    method: 'post',
    url: 'core/v4/labels',
    data: { Name, Color, Type, Notify, ParentID, Expanded },
});

export const deleteLabel = (labelID: string) => ({
    method: 'delete',
    url: `core/v4/labels/${labelID}`,
});

export const getLabels = () => get(MESSAGE_LABEL);  // LABEL_TYPE.MESSAGE_LABEL = 1
export const getFolders = () => get(MESSAGE_FOLDER); // LABEL_TYPE.MESSAGE_FOLDER = 3
```

### Complete Mail API Surface

| File | Lines | Endpoints |
|---|---|---|
| [messages.ts](~/Projects/WebClients/packages/shared/lib/api/messages.ts) | 302 | query, get, create, update, send, label, unlabel, read, unread, delete, undelete, count, move, batch ops |
| [labels.ts](~/Projects/WebClients/packages/shared/lib/api/labels.ts) | 108 | get, create, update, delete, order, check availability |
| [conversations.ts](~/Projects/WebClients/packages/shared/lib/api/conversations.ts) | 124 | query, get, label, unlabel, read, unread, delete, count |
| [auth.ts](~/Projects/WebClients/packages/shared/lib/api/auth.ts) | 220 | auth, 2FA, JWT, refresh, revoke, sessions, cookies, SSO |
| [attachments.ts](~/Projects/WebClients/packages/shared/lib/api/attachments.ts) | 31 | get, upload |
| [mailSettings.ts](~/Projects/WebClients/packages/shared/lib/api/mailSettings.ts) | 256 | get, update (many individual settings) |
| [events.ts](~/Projects/WebClients/packages/shared/lib/api/events.ts) | 117 | event polling (v4 + v6) |
| **Total** | **~1,160** | |

## The HTTP Layer — Minimal

**[packages/shared/lib/api.ts](~/Projects/WebClients/packages/shared/lib/api.ts)** (80 lines) — the complete API caller:
```typescript
export function configureApi({ API_URL, APP_VERSION, CLIENT_SECRET, UID, clientID,
                               defaultHeaders, protonFetch }) {
    const apiRateLimiter = new ApiRateLimiter();

    const cb = ({ data, headers, url, ...rest }) => {
        const fullUrl = /^https?:\/\//.test(url) ? url : `${API_URL}/${url}`;
        apiRateLimiter.recordCallOrThrow(fullUrl);
        return protonFetch({
            url: fullUrl,
            data,
            headers: { ...defaultHeaders, ...authHeaders, ...headers },
            ...rest,
        });
    };
    return cb;
}
```

The fetch wrapper itself is 382 lines across 7 files in `packages/shared/lib/fetch/` — native `fetch()` with timeout, abort controller, and response parsing. No axios.

This entire HTTP layer could be **trivially reimplemented** without touching GPL code. It's a fetch wrapper with auth headers and rate limiting.

## The Authentication Layer — SRP Complexity

Proton uses [SRP-6a](https://en.wikipedia.org/wiki/Secure_Remote_Password_protocol) (Secure Remote Password) for authentication. This is non-trivial to reimplement.

**Authentication flow** ([packages/shared/lib/authentication/loginWithFallback.ts](~/Projects/WebClients/packages/shared/lib/authentication/loginWithFallback.ts), 68 lines):

```typescript
const loginWithFallback = async ({ api, credentials }) => {
    do {
        const { authInfo, lastAuthVersion } = state;
        const info = authInfo ?? await api(getInfo({ username }));           // 1. GET auth info
        const { version, done } = getAuthVersionWithFallback(info, ...);    // 2. Determine SRP version
        const result = await srpAuth({ api, credentials, config, info });   // 3. SRP handshake
        return { authVersion: version, result };
    } while (true);
};
```

**SRP handshake** ([packages/shared/lib/srp.ts](~/Projects/WebClients/packages/shared/lib/srp.ts), 130 lines):
```typescript
export const srpAuth = async ({ api, credentials, config, info, version }) => {
    const actualInfo = info || (await api(getInfo({ username: credentials.username })));
    const { expectedServerProof, clientProof, clientEphemeral } =
        await getSrp(actualInfo, credentials, version);         // Heavy crypto
    // ... validate server proof
};
```

**[packages/srp/](~/Projects/WebClients/packages/srp/)** (700 lines total, MIT license):
- `srp.ts` (259 lines): BigInt SRP-6a implementation
- `passwords.ts` (102 lines): Password hashing with version-dependent salts
- `keys.ts` (21 lines): Key password computation
- Dependencies: `@proton/crypto` (for BigInt), `bcryptjs`
- Supports auth versions 0-4 for backward compatibility

## The Crypto Layer — The Hard Part

Every ProtonMail message body is **PGP-encrypted**. You can't read emails without decrypting them.

**[packages/crypto/](~/Projects/WebClients/packages/crypto/)** (MIT license):
```json
{
  "dependencies": {
    "comlink": "^4.4.2",
    "pmcrypto": "npm:@protontech/pmcrypto@^8.8.1"
  }
}
```

`@protontech/pmcrypto` is published on npm (not proprietary). From [yarn.lock](~/Projects/WebClients/yarn.lock):
```
"@protontech/pmcrypto@npm:^8.9.0":
  version: 8.9.0
  dependencies:
    "@noble/hashes": "npm:^2.0.1"
    "@openpgp/web-stream-tools": "npm:~0.1.3"
    jsmimeparser: "npm:@protontech/jsmimeparser@^3.0.2"
    openpgp: "npm:@protontech/openpgp@~6.3.0"
```

It wraps `@protontech/openpgp` (Proton's fork of [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)).

The crypto architecture uses **Web Workers** via `comlink` for offloading encryption/decryption — this is browser-specific and would need adaptation for Node.js.

**Message decryption flow:**
1. Authenticate -> get session
2. Fetch user keys: `GET core/v4/keys`
3. Decrypt private key with key password (derived from login password + salt via SRP)
4. Fetch message: `GET mail/v4/messages/{id}` -> armored PGP body
5. `CryptoProxy.decryptMessage({ armoredMessage: body, decryptionKeys: privateKeys })`
6. Result: decrypted plaintext/HTML

## Licensing Analysis

| Package | License | Needed for | Verdict |
|---|---|---|---|
| `@proton/shared` | **GPL-3.0** | API definitions, types, auth flow, fetch wrapper | **Toxic for commercial use** — any code linking to GPL must also be GPL |
| `@proton/crypto` | MIT | Message decryption | Safe to use |
| `@proton/srp` | MIT | Authentication | Safe to use |
| `@protontech/pmcrypto` | npm public (license TBD from npm) | PGP operations | Likely MIT (wraps OpenPGP.js which is LGPL-3.0) |
| `@protontech/openpgp` | Likely LGPL-3.0 (fork of openpgpjs) | Core PGP | LGPL is fine for dynamic linking |

**The critical problem is `@proton/shared` being GPL-3.0.** This package contains the API endpoint definitions, type interfaces, and authentication glue. Using it directly (importing, linking, or deriving from it) would require your entire project to be GPL-3.0.

### Options

1. **Clean-room rewrite**: Study the API endpoints (they're just URL patterns + JSON schemas), then rewrite without copying code. The API *itself* is not copyrightable — only the code is. `{ method: 'put', url: 'mail/v4/messages/label', data: { LabelID, IDs } }` is a fact about Proton's REST API, not creative expression.

2. **Use GPL and accept it**: If the MCP server stays GPL-3.0, you can use `@proton/shared` directly. Proton Bridge itself is GPL-3.0, so there's precedent.

3. **Dual-license**: Keep the MCP server proprietary but maintain a GPL-3.0 API client as a separate package. The viral nature of GPL only applies to the combined work distributed together.

## Extraction Complexity Assessment

### What you'd need

```
Tier 1: API definitions (trivial to clean-room)
├── messages.ts endpoints       — 302 lines of { method, url, data }
├── labels.ts endpoints         — 108 lines
├── auth.ts endpoints           — 220 lines
├── events.ts endpoints         — 117 lines
├── attachments.ts endpoints    — 31 lines
└── Type interfaces             — ~250 lines (Message, Label, etc.)
    Total: ~1,000 lines of pure data descriptions

Tier 2: HTTP + Auth (moderate, mostly MIT)
├── fetch wrapper               — 382 lines (trivially reimplementable)
├── configureApi                — 80 lines (trivially reimplementable)
├── SRP auth (@proton/srp)      — 700 lines, MIT ✓
├── srpAuth glue                — 130 lines (in GPL shared — rewrite)
└── Rate limiter                — 105 lines (trivially reimplementable)
    Total: ~1,400 lines, mostly MIT or trivially reimplementable

Tier 3: Crypto (significant, but MIT)
├── @proton/crypto              — MIT, Web Worker architecture
├── @protontech/pmcrypto        — npm public, wraps OpenPGP
├── Key derivation              — Part of SRP flow
└── Message decrypt/encrypt     — CryptoProxy API
    Total: Large but self-contained and MIT-licensed

Tier 4: Event system (optional, complex)
├── EventManager                — 343 lines, polling with Fibonacci backoff
├── Event handlers              — Redux-based, deeply coupled to React
└── Real-time sync              — NOT needed for basic API usage
    Total: Skip entirely for v1
```

### The realistic path

| Step | Effort | Risk |
|---|---|---|
| Clean-room API types + endpoints | 2-3 days | None — facts about an API |
| Node.js fetch wrapper + rate limiter | Half day | None — trivial |
| SRP authentication (use `@proton/srp` directly) | 1 day | Low — MIT licensed |
| Adapt `@proton/crypto` for Node.js (remove Web Worker) | 2-3 days | Medium — Worker pool to direct calls |
| Key management (decrypt private keys, derive key password) | 1-2 days | Medium — must match Proton's key derivation |
| Message decryption integration | 1 day | Low once crypto works |
| **Total** | **~8-10 days** | |

### What you gain over IMAP

| Capability | Via IMAP (current) | Via API (proposed) |
|---|---|---|
| Label/unlabel | COPY + EXPUNGE with Message-ID search | Single `PUT /messages/label` call |
| List by label | Not directly possible | `GET /messages?LabelID=...` |
| Message identity | Per-mailbox UIDs (fragile) | Stable MessageID strings |
| Flag sync | Automatic but invisible | Explicit — you control it |
| Message count | `STATUS` per mailbox | `GET /messages/count` |
| Conversations | Not available | Full conversation threading |
| Search | `SEARCH` command (limited) | `GET /messages?Keyword=...` with server-side search |
| Attachments | MIME parsing from FETCH | Direct `GET /attachments/{id}` |
| Message body | Already decrypted by Bridge | Must decrypt PGP yourself |

The last row is the cost: Bridge handles decryption transparently. A direct API client must manage keys and decrypt every message body.

## Versioning Concerns

**Release cadence**: Very active. Recent tags show `proton-mail@5.0.99.5` through `5.0.99.9` — rapid patch releases within a major version.

**API stability**: The REST API uses versioned paths (`mail/v4/`, `core/v4/`, `core/v5/`, `core/v6/`). The v4 endpoints have been stable for years (Bridge depends on them). Newer v5/v6 event endpoints coexist with v4.

**Breaking change risk**: Low for v4 endpoints. Proton must maintain backward compatibility for Bridge and mobile clients. However, there's no public API documentation or stability guarantee — these are internal APIs.

## Quality Assessment

### Strengths
- API definitions are **exceptionally clean** — pure functions, type-only imports, zero coupling
- Type interfaces are comprehensive and well-documented
- SRP and crypto packages are properly isolated with MIT licenses
- The fetch layer is minimal and dependency-free

### Weaknesses
- **No public API documentation** — you'd be reverse-engineering from TypeScript source
- **No API versioning promise** — Proton can change internal APIs without notice
- **Encryption is mandatory** — you can't skip crypto for a "lite" client; every message body is PGP-encrypted
- **SRP auth is non-standard** — most HTTP clients won't support it out of the box; custom implementation required
- **Web Worker assumption** in crypto — needs adaptation for Node.js
- **No official SDK or client library** — you're building infrastructure Proton deliberately doesn't publish

### Risks
- **Account suspension**: Proton's ToS may prohibit automated API access outside their official clients. Bridge is sanctioned; a custom API client is not.
- **Rate limiting**: The API has rate limits. Proton could block non-standard clients.
- **CAPTCHA/human verification**: The API can require human verification challenges that a headless client can't solve.
- **2FA/FIDO2**: Must handle TOTP and potentially FIDO2 authentication flows.

## Recommendation

**Don't extract; rewrite the thin layer.** The API definitions are facts about Proton's REST API — clean-room reimplementation is safe regardless of GPL. Use `@proton/srp` (MIT) and `@proton/crypto` (MIT) directly for the hard parts. Skip `@proton/shared` entirely.

The bigger question is whether direct API access is worth the crypto complexity and ToS risk. The IMAP approach via Bridge, despite the label virtualization overhead, has the advantage of being a sanctioned, supported integration path. A direct API client is faster and more capable but operates in a gray area.
