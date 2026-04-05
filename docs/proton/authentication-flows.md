# ProtonMail Authentication Flows — WebClients vs Bridge

> Comparative analysis of authentication in [proton-mail/WebClients](https://github.com/ProtonMail/WebClients) and [proton-mail/proton-bridge](https://github.com/ProtonMail/proton-bridge), with assessment of how each could be adapted for an MCP server.

## Overview

Both the web client and Bridge authenticate to the same Proton API using the same SRP-6a protocol. The differences are in what happens *after* authentication: how sessions are stored, how keys are managed, and what authentication the downstream client (browser / IMAP client) uses.

```
Web Client:                          Bridge:                           MCP Server (proposed):
Browser → SRP → Proton API           GUI → SRP → Proton API            CLI → SRP → Proton API
  ↓                                    ↓                                  ↓
  Cookie + localStorage               Encrypted vault file               ???
  ↓                                    ↓                                  ↓
  API calls with UID header            API calls with UID header          API calls with UID header
                                       ↓
                                       Generate BridgePass (random)
                                       ↓
                                       IMAP client → BridgePass → Bridge
```

## SRP-6a — The Shared Foundation

Both implementations use SRP-6a (Secure Remote Password), a zero-knowledge proof protocol where the server never sees the user's password. The protocol has 5 auth versions (0-4) for backward compatibility.

### The Handshake

```
Client                                    Server
  │                                         │
  │──── GET /core/v4/auth/info ────────────→│  "I'm user X"
  │                                         │
  │←── { Modulus, ServerEphemeral, ────────│  SRP challenge parameters
  │      Version, Salt, SRPSession }        │
  │                                         │
  │  [hash password with salt + modulus]    │
  │  [generate client proof]               │
  │                                         │
  │──── POST /core/v4/auth ────────────────→│  { ClientProof, ClientEphemeral, SRPSession }
  │                                         │
  │←── { ServerProof, UID, AccessToken, ───│  Mutual authentication
  │      RefreshToken, 2FA, ... }           │
  │                                         │
  │  [verify ServerProof]                  │
  │                                         │
```

### Web Client SRP Implementation

**[packages/srp/lib/srp.ts:184-221](~/Projects/WebClients/packages/srp/lib/srp.ts)** (259 lines, MIT license):

```typescript
export const getSrp = async (
    { Version, Modulus: serverModulus, ServerEphemeral, Username, Salt }: AuthInfo,
    { username, password }: AuthCredentials,
    authVersion = Version
) => {
    const modulusArray = await verifyAndGetModulus(serverModulus);
    const serverEphemeralArray = Uint8Array.fromBase64(ServerEphemeral);

    const hashedPasswordArray = await hashPassword({
        version: authVersion,
        password,
        salt: authVersion < 3 ? undefined : uint8ArrayToString(Uint8Array.fromBase64(Salt)),
        username: authVersion < 3 ? Username : undefined,
        modulus: modulusArray,
    });

    const { clientEphemeral, clientProof, expectedServerProof } = await generateProofs({
        byteLength: SRP_LEN,
        modulusArray,
        hashedPasswordArray,
        serverEphemeralArray,
    });

    return {
        clientEphemeral: clientEphemeral.toBase64(),
        clientProof: clientProof.toBase64(),
        expectedServerProof: expectedServerProof.toBase64(),
    };
};
```

**Password hashing varies by auth version** ([packages/srp/lib/passwords.ts:63-102](~/Projects/WebClients/packages/srp/lib/passwords.ts)):
- **Version 0-2**: Hash with username (legacy, no salt)
- **Version 3**: bcrypt with salt, then hash with modulus
- **Version 4**: Same as 3 (current)

The version fallback logic ([packages/srp/lib/getAuthVersionWithFallback.ts](~/Projects/WebClients/packages/srp/lib/getAuthVersionWithFallback.ts)) tries the server-reported version first, then falls back to older versions if "wrong password" is returned. This handles accounts that haven't been migrated to newer auth versions.

### Bridge SRP Implementation

Bridge delegates SRP entirely to `go-proton-api`:

**[go.mod:10](~/Projects/proton-bridge/go.mod):**
```
github.com/ProtonMail/go-proton-api v0.4.1-0.20260319112440-799673ddc2db
```

Transitive dependency: `github.com/ProtonMail/go-srp v0.0.7`

**[internal/bridge/user.go:134](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
client, auth, err := bridge.api.NewClientWithLoginWithHVToken(ctx, username, password, hvDetails)
```

Bridge never touches SRP internals. One function call handles the full handshake.

## Two-Factor Authentication

### AuthResponse — What Comes Back

**[packages/shared/lib/authentication/interface.ts:16-30](~/Projects/WebClients/packages/shared/lib/authentication/interface.ts):**
```typescript
export interface AuthResponse {
    AccessToken: string;
    ExpiresIn: number;
    TokenType: string;
    Scope: string;
    UID: string;
    UserID: string;
    RefreshToken: string;
    EventID: string;
    TemporaryPassword: 0 | 1;
    PasswordMode: number;    // 1 = single password, 2 = two-password mode
    LocalID: number;
    TwoFactor: number;       // Bitmask: 0 = none, 1 = TOTP, 2 = FIDO2
    '2FA': TwoFaResponse;
}
```

### Web Client 2FA

After the initial auth response, the web client checks `TwoFactor`:
- **TOTP**: Shows input field, calls `POST /core/v4/auth/2fa` with `{ TwoFactorCode }`
- **FIDO2**: Shows WebAuthn challenge, calls same endpoint with `{ FIDO2: credential }`

### Bridge 2FA

**[internal/bridge/user.go:209-220](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
if auth.TwoFA.Enabled&proton.HasTOTP != 0 {
    totp, err := getTOTP()   // Callback — Bridge GUI prompts user
    if err != nil {
        return "", fmt.Errorf("failed to get TOTP: %w", err)
    }

    if err := client.Auth2FA(ctx, proton.Auth2FAReq{TwoFactorCode: totp}); err != nil {
        return "", fmt.Errorf("failed to authorize 2FA: %w", err)
    }
}
```

Bridge only supports TOTP, not FIDO2. The TOTP code is obtained via a callback function that the GUI provides.

## Two-Password Mode

ProtonMail supports an optional "two-password mode" where the login password and the mailbox decryption password are different.

### Bridge Handling

**[internal/bridge/user.go:222-235](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
if auth.PasswordMode == proton.TwoPasswordMode {
    userKeyPass, err := getKeyPass()  // Callback — GUI prompts for mailbox password
    keyPass = userKeyPass
} else {
    keyPass = password  // Single password mode: login password IS the key password
}
```

In single-password mode (the default for most users), the login password doubles as the key password for decrypting private keys.

### Web Client Handling

The web client handles this in `loginActions.ts` — if `PasswordMode === 2`, it prompts for a second password before proceeding to key decryption.

## Post-Auth: Key Decryption

After authentication, both implementations must decrypt the user's private PGP keys to read email.

### Web Client Key Setup

1. `GET core/v4/users` — fetch user info including encrypted key list
2. `GET core/v4/keys/salts` — fetch per-key salts
3. Compute `keyPassword = bcrypt(loginPassword, keySalt)`
4. `CryptoProxy.importPrivateKey(armoredKey, keyPassword)` — decrypt private key
5. Store `keyPassword` in encrypted session blob (localStorage)

### Bridge Key Setup

**[internal/bridge/user.go:372-399](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
func (bridge *Bridge) loginUser(ctx context.Context, client *proton.Client, 
    authUID, authRef string, keyPass []byte, hvDetails *proton.APIHVDetails) (string, error) {
    apiUser, err := client.GetUserWithHV(ctx, hvDetails)
    salts, err := client.GetSalts(ctx)
    saltedKeyPass, err := salts.SaltForKey(keyPass, apiUser.Keys.Primary().ID)
    userKR, err := apiUser.Keys.Unlock(saltedKeyPass, nil)
    // ... store auth + keyPass in vault
}
```

The `saltedKeyPass` is stored in the vault for future use. On restart, Bridge doesn't need the original password — it loads `keyPass` from the vault and unlocks keys directly.

## Session Persistence — The Critical Difference

### Web Client: Browser Storage

**[packages/shared/lib/authentication/persistedSessionStorage.ts](~/Projects/WebClients/packages/shared/lib/authentication/persistedSessionStorage.ts):**

Sessions are stored in `localStorage` with prefix `ps-{localID}`:
```typescript
interface PersistedSession {
    localID: number;
    UserID: string;
    UID: string;
    AccessToken: string;
    RefreshToken: string;
    blob: string;       // AES-encrypted keyPassword
    persistent: boolean;
    trusted: boolean;
}
```

The `keyPassword` is encrypted with a `ClientKey` that is stored server-side (`POST /auth/v4/sessions/local/key`). On page reload, the client fetches the ClientKey, decrypts the blob, and resumes.

### Bridge: Encrypted Vault File

**[internal/vault/types_user.go:24-45](~/Projects/proton-bridge/internal/vault/types_user.go):**
```go
type UserData struct {
    UserID       string
    Username     string
    PrimaryEmail string

    AuthUID string      // API session UID
    AuthRef string      // Refresh token
    KeyPass []byte      // Salted mailbox password (for key decryption)

    BridgePass  []byte  // Random 16-byte token for IMAP/SMTP auth
    AddressMode AddressMode
    SyncStatus  SyncStatus
    EventID     string
}
```

Stored in `vault.enc`, encrypted with AES-256-GCM. The vault encryption key is derived internally (not stored in OS keychain in this version).

### Key Difference

| | Web Client | Bridge |
|---|---|---|
| **Storage** | Browser localStorage | Encrypted file on disk |
| **keyPassword protection** | Server-side ClientKey + AES | Vault AES-256-GCM |
| **Survives restart** | Yes (with cookie/localStorage) | Yes (vault file) |
| **Refresh token** | In persisted session blob | In vault UserData |
| **Multi-account** | Multiple `ps-{localID}` entries | Multiple UserData in vault |

## Token Refresh

### Web Client

**[packages/shared/lib/api/helpers/refreshHandlers.ts](~/Projects/WebClients/packages/shared/lib/api/helpers/refreshHandlers.ts):**

On 401 response:
1. Mutex-protected refresh (prevents cross-tab races)
2. `POST /auth/refresh` with RefreshToken (via cookie)
3. New AccessToken + RefreshToken returned
4. Retry original request
5. If refresh fails with 4xx, emit `ApiLogoutEvent` — session is dead

### Bridge

**[internal/bridge/user.go:445-478](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
func (bridge *Bridge) loadUser(ctx context.Context, user *vault.User) error {
    client, auth, err := bridge.api.NewClientWithRefresh(ctx, user.AuthUID(), user.AuthRef())
    if err != nil {
        if apiErr.Code == proton.AuthRefreshTokenInvalid {
            if err := user.Clear(); err != nil { /* clear auth */ }
        }
        return err
    }

    if err := user.SetAuth(auth.UID, auth.RefreshToken); err != nil {
        return err
    }
    // ... continue with user setup
}
```

On startup, Bridge refreshes all stored sessions. If a refresh token is invalid, the user is logged out and must re-authenticate.

## Bridge Password — The IMAP Authentication Layer

This is unique to Bridge and has no equivalent in the web client.

**[internal/vault/vault.go:220-223](~/Projects/proton-bridge/internal/vault/vault.go):**
```go
bridgePass := data.Settings.PasswordArchive.get(primaryEmail)
if len(bridgePass) == 0 {
    bridgePass = newRandomToken(16)
}
```

A random 16-byte token is generated per user, stored in the vault, and base64-encoded for display. IMAP/SMTP clients authenticate with `email + base64(bridgePass)`.

**[internal/services/useridentity/state.go:229-254](~/Projects/proton-bridge/internal/services/useridentity/state.go):**
```go
func (s *State) CheckAuth(email string, password []byte, 
    bridgePassProvider BridgePassProvider) (string, error) {
    dec, err := algo.B64RawDecode(password)
    if err != nil {
        return "", fmt.Errorf("failed to decode password: %w", err)
    }

    if subtle.ConstantTimeCompare(bridgePassProvider.BridgePass(), dec) != 1 {
        return "", fmt.Errorf("invalid password")
    }
    // ... match email to address
}
```

The constant-time comparison (`subtle.ConstantTimeCompare`) prevents timing attacks on the bridge password.

## Human Verification / CAPTCHA

Both implementations handle Proton's anti-abuse challenges:

### Web Client
API returns error code `HUMAN_VERIFICATION_REQUIRED` with available methods (captcha, email, SMS). The listener shows a verification UI. On completion, the original request is retried with `X-PM-Human-Verification-Token` header.

### Bridge
**[internal/bridge/user.go:136-140](~/Projects/proton-bridge/internal/bridge/user.go):**
```go
if hv.IsHvRequest(err) {
    return nil, proton.Auth{}, err  // Propagates HV request to caller
}
```

Bridge passes the HV challenge to its GUI. The GUI presents a WebView with the CAPTCHA, collects the token, and retries login with `hvDetails`.

## Session Forking — Web Client Only

**[packages/shared/lib/authentication/fork/](~/Projects/WebClients/packages/shared/lib/authentication/fork/)**

The web client has an elaborate session forking mechanism for SSO across Proton apps (mail, calendar, drive, etc.):

1. **Parent app** generates a random 32-byte AES key
2. Encrypts `keyPassword` with the AES key
3. Calls `POST /auth/v4/sessions/forks` with encrypted payload -> gets `selector`
4. Constructs URL: `https://child-app/#selector=X&sk=<base64-key>&v=2`
5. **Child app** extracts `selector` + `sk` from URL hash
6. Calls `GET /auth/v4/sessions/forks/{selector}` -> gets encrypted payload + session tokens
7. Decrypts `keyPassword` using `sk`
8. Session is now active in child app

This is purely a browser concern and irrelevant for an MCP server.

## Adaptation for an MCP Server

### Option A: Adapt the Bridge Approach

**Use Bridge's authentication flow but store tokens yourself.**

```
MCP Server Startup:
  1. Check for stored session (vault/config file)
  2. If found: refresh token → API ready
  3. If not: SRP login → store session → API ready

Auth dependencies needed:
  - @proton/srp (MIT, 700 lines) — SRP-6a handshake
  - @proton/crypto (MIT) — for SRP's BigInt and hashing
  - Token storage — encrypted file, OS keychain, or env vars
```

**Pros:**
- Battle-tested flow (Bridge uses it in production)
- No browser dependencies
- Token refresh is straightforward
- Can store keyPass for subsequent restarts

**Cons:**
- Must handle TOTP interactively (prompt user on first login)
- Must handle HV/CAPTCHA (harder without a GUI)
- Go's `go-proton-api` library wraps SRP beautifully; no TypeScript equivalent exists
- Must implement key management (salt, decrypt private keys) for message reading

### Option B: Adapt the Web Client Approach

**Port the web client's auth flow to Node.js.**

```
MCP Server Startup:
  1. configureApi({ API_URL, APP_VERSION, clientID, protonFetch: nodeFetch })
  2. loginWithFallback({ api, credentials })
  3. If 2FA: prompt for TOTP
  4. persistSession locally (encrypted file instead of localStorage)
  5. loadCryptoWorker → adapt for Node.js (no Web Workers)
  6. API ready

Auth dependencies needed:
  - @proton/srp (MIT) — use directly
  - @proton/crypto (MIT) — adapt CryptoProxy for Node.js
  - @protontech/pmcrypto (npm) — OpenPGP operations
  - Custom: configureApi reimplementation (trivial, 80 lines)
  - Custom: session storage (replace localStorage with file)
```

**Pros:**
- TypeScript-native (same language as MCP server)
- SRP and crypto packages are MIT-licensed
- API endpoint definitions are just `{ method, url, data }` objects — easy to replicate
- Web client auth flow is more feature-complete (SSO, offline keys, scopes)

**Cons:**
- `@proton/crypto` uses Web Workers via `comlink` — needs Node.js adaptation
- `@proton/shared` is GPL-3.0 — can't import directly; must clean-room the glue code
- More moving parts than Bridge's single `NewClientWithLogin` call
- CAPTCHA handling requires a browser or WebView

### Option C: Hybrid — Use Bridge as Auth Proxy

**Keep using Bridge for IMAP, but also authenticate directly for API operations that IMAP can't do.**

```
MCP Server:
  1. Connect to Bridge IMAP (existing flow)
  2. Also: read Bridge's vault file to extract AuthUID + AuthRef
  3. Use extracted tokens to call Proton API directly
  4. Use IMAP for reads, API for label operations

Dependencies needed:
  - vault.enc decryption (AES-256-GCM, need vault key)
  - Token refresh logic
  - No SRP needed (Bridge already authenticated)
```

**Pros:**
- No SRP implementation needed
- No password handling
- Bridge handles CAPTCHA, 2FA, key management
- Incremental — add API calls alongside IMAP gradually

**Cons:**
- Depends on Bridge's internal vault format (undocumented, may change)
- Vault encryption key derivation must be reverse-engineered
- Bridge and MCP server could race on token refresh
- Fragile coupling to Bridge internals

### Recommendation

**Option A (Bridge approach) is the most viable for a standalone MCP server.** The flow is:

1. **First run**: Prompt for username + password + TOTP
2. SRP handshake via `@proton/srp` (MIT)
3. Store `{ AuthUID, RefreshToken, KeyPass }` in encrypted config
4. **Subsequent runs**: Refresh token, decrypt keys, ready
5. API calls with `UID` header for all operations

The main implementation effort is:
- Port SRP glue code (~130 lines, clean-room from GPL `@proton/shared`)
- Adapt `@proton/crypto` for Node.js (remove Web Worker dependency)
- Build token storage and refresh
- Handle TOTP prompt on first login
- Handle CAPTCHA (hardest part — may need an embedded browser)

The CAPTCHA problem is the real blocker. Both Bridge (GUI with WebView) and web client (browser-native) have visual interfaces for solving challenges. A headless MCP server would need either a temporary browser window or a way to present the challenge to the user.

## Complete Auth Flow Comparison

| Step | Web Client | Bridge | MCP Server (proposed) |
|---|---|---|---|
| **SRP handshake** | `@proton/srp` (TypeScript, MIT) | `go-proton-api` + `go-srp` (Go) | `@proton/srp` (reuse TypeScript) |
| **2FA** | Browser UI | GUI callback | CLI prompt |
| **CAPTCHA** | Browser-native | GUI WebView | Embedded browser? CLI URL? |
| **Key decrypt** | `CryptoProxy` (Web Workers) | `go-crypto` (Go) | `CryptoProxy` (adapted for Node) |
| **Session store** | localStorage + server ClientKey | Encrypted vault file | Encrypted config file |
| **Token refresh** | Auto on 401, mutex-protected | On startup, stored in vault | On startup + auto on 401 |
| **Downstream auth** | Cookie + UID header | BridgePass (random token) | UID header (direct API) |
| **Password mode** | Prompt for 2nd password | GUI callback | CLI prompt |

## Key Source Files

### Web Client
| File | Purpose |
|---|---|
| [packages/srp/lib/srp.ts](~/Projects/WebClients/packages/srp/lib/srp.ts) | Core SRP-6a (259 lines, MIT) |
| [packages/srp/lib/passwords.ts](~/Projects/WebClients/packages/srp/lib/passwords.ts) | Password hashing per version (102 lines) |
| [packages/shared/lib/authentication/loginWithFallback.ts](~/Projects/WebClients/packages/shared/lib/authentication/loginWithFallback.ts) | Login orchestration (68 lines, GPL) |
| [packages/shared/lib/srp.ts](~/Projects/WebClients/packages/shared/lib/srp.ts) | SRP auth glue (130 lines, GPL) |
| [packages/shared/lib/authentication/interface.ts](~/Projects/WebClients/packages/shared/lib/authentication/interface.ts) | Auth types: AuthResponse, InfoResponse (110 lines) |
| [packages/shared/lib/api/auth.ts](~/Projects/WebClients/packages/shared/lib/api/auth.ts) | Auth API endpoints (220 lines, GPL) |
| [packages/shared/lib/api.ts](~/Projects/WebClients/packages/shared/lib/api.ts) | configureApi (80 lines, GPL) |
| [packages/shared/lib/api/helpers/refreshHandlers.ts](~/Projects/WebClients/packages/shared/lib/api/helpers/refreshHandlers.ts) | Token refresh (101 lines) |
| [packages/shared/lib/authentication/persistedSessionHelper.ts](~/Projects/WebClients/packages/shared/lib/authentication/persistedSessionHelper.ts) | Session persist/resume |
| [packages/shared/lib/authentication/fork/](~/Projects/WebClients/packages/shared/lib/authentication/fork/) | SSO session forking |

### Bridge
| File | Purpose |
|---|---|
| [internal/bridge/user.go](~/Projects/proton-bridge/internal/bridge/user.go) | LoginAuth, LoginUser, LoginFull, loadUser (478 lines) |
| [internal/vault/types_user.go](~/Projects/proton-bridge/internal/vault/types_user.go) | UserData struct with auth fields (97 lines) |
| [internal/vault/vault.go](~/Projects/proton-bridge/internal/vault/vault.go) | Vault encryption, bridge password generation |
| [internal/services/useridentity/state.go](~/Projects/proton-bridge/internal/services/useridentity/state.go) | CheckAuth, WithAddrKR (key ring access) |
| [internal/services/imapservice/connector.go](~/Projects/proton-bridge/internal/services/imapservice/connector.go) | IMAP Authorize (bridge password check) |
| [internal/services/smtp/smtp_backend.go](~/Projects/proton-bridge/internal/services/smtp/smtp_backend.go) | SMTP AuthPlain |
| [pkg/keychain/keychain.go](~/Projects/proton-bridge/pkg/keychain/keychain.go) | OS keychain abstraction |
