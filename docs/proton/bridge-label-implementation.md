# ProtonMail Labels in Proton Bridge — Source Analysis

> Analysis of [proton-bridge](https://github.com/ProtonMail/proton-bridge) label implementation.
> Go idioms are explained inline for readers fluent in TypeScript/C/C++/C#/Java but new to Go.

## The Core Abstraction

ProtonMail labels are **tags**. A single email can carry many labels simultaneously without moving. This is identical to Gmail labels and fundamentally different from IMAP folders, which model **physical containers** — a message is "in" a folder.

Proton Bridge must present this tag system to IMAP clients that only understand folders. The bridge does this by **virtualizing labels as IMAP folders** under a `Labels/` namespace. The email appears as a "copy" in each label folder, even though at the API level there is only one message with multiple label IDs attached.

## Label Types

The bridge distinguishes four label types. The type constants come from the `go-proton-api` library (Proton's Go API client):

**[internal/services/imapservice/helpers.go:140-177](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/helpers.go)**
```go
case proton.LabelTypeSystem:       // Inbox, Sent, Drafts, Trash, Spam, Archive, AllMail, Starred, AllScheduled
case proton.LabelTypeFolder:       // User-created hierarchical folders
case proton.LabelTypeLabel:        // User-created flat labels
case proton.LabelTypeContactGroup: // Contact groups — filtered out, never synced to IMAP
```

> **Go -> TypeScript:** Go doesn't have enums. These are typed constants (likely `int` values). The `case` syntax is inside a `switch` — Go switches don't fall through by default (opposite of C/Java), so there's no `break` needed.

The `WantLabel()` function at this location acts as a filter — it returns `true` for labels that should appear as IMAP mailboxes and `false` for those that shouldn't (like contact groups).

## Path Construction — Where `Labels/` Comes From

**[internal/services/imapservice/imap_updates.go:115-135](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/imap_updates.go)**
```go
func GetMailboxName(label proton.Label) []string {
    var name []string

    switch label.Type {
    case proton.LabelTypeFolder:
        name = append([]string{folderPrefix}, label.Path...)

    case proton.LabelTypeLabel:
        name = append([]string{labelPrefix}, label.Path...)

    case proton.LabelTypeSystem:
        name = []string{label.Name}
    }

    return name
}
```

**[internal/services/imapservice/connector.go:579-582](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**
```go
const (
    folderPrefix = "Folders"
    labelPrefix  = "Labels"
)
```

> **Go -> TypeScript:** `[]string` is a string array (like `string[]`). `append([]string{folderPrefix}, label.Path...)` is Go's spread syntax — the `...` unpacks the slice into individual arguments, like TypeScript's `[folderPrefix, ...label.Path]`. The `var name []string` declares a nil slice (similar to `let name: string[] | undefined`).

Key observations:

1. **Paths are string arrays**, not strings. `["Labels", "Work"]` becomes `Labels/Work` when joined by the IMAP delimiter `/`. This is handled by the Gluon IMAP library.
2. **System labels have no prefix** — `Inbox`, `Sent`, `Drafts` appear at the top level.
3. **`label.Path` is already an array** from the API — a label named "Work" has `Path: ["Work"]`. This allows folders to support nesting (`Path: ["Projects", "2024"]` -> `Folders/Projects/2024`), but labels are always flat.

## How Labels Are Flat — Enforced in Code

**[internal/services/imapservice/connector.go:593-613](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**
```go
func (s *Connector) createLabel(ctx context.Context, name []string) (imap.Mailbox, error) {
    if len(name) != 1 {
        return imap.Mailbox{}, fmt.Errorf("a label cannot have children: %w", connector.ErrOperationNotAllowed)
    }
    // ...
    label, err := s.client.CreateLabel(ctx, proton.CreateLabelReq{
        Name:  name[0],
        Color: "#7272a7",
        Type:  proton.LabelTypeLabel,
    })
    // ...
}
```

> **Go -> TypeScript:** `(s *Connector)` before the function name is a **method receiver** — it means `createLabel` is a method on `Connector`, like `class Connector { createLabel(...) {} }` in TypeScript. The `*` means it receives a pointer (mutable reference). The `%w` in `fmt.Errorf` wraps the error, similar to chaining `cause` in JavaScript's `Error`.

The `len(name) != 1` check rejects any attempt to create a nested label. In contrast, `createFolder` at line 615 accepts multi-segment names and resolves parent IDs.

Oddity: the **default color `#7272a7`** is hardcoded. When a client creates a label via IMAP CREATE, there's no way to specify a color (IMAP has no concept of it), so every IMAP-created label gets this shade of purple.

## The Phantom "Folders" and "Labels" Mailboxes

**[internal/services/imapservice/sync_update_applier.go:150-162](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/sync_update_applier.go)**

During sync, the bridge creates two placeholder mailboxes with the `\Noselect` IMAP attribute:
- `Folders` (ID: `"Folders"`)
- `Labels` (ID: `"Labels"`)

These are **not real mailboxes** — you can't SELECT them or store messages in them. They exist only so IMAP clients render a proper tree:
```
+-- Folders/
|   +-- Work
|   +-- Personal
+-- Labels/
    +-- Important
    +-- Urgent
```

Without them, `Labels/Important` would show as a flat entry rather than a child of a `Labels` parent.

## COPY Into a Label — The Labeling Operation

**[internal/services/imapservice/connector.go:385-391](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**
```go
func (s *Connector) AddMessagesToMailbox(ctx context.Context, _ connector.IMAPStateWrite,
    messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
    if isAllMailOrScheduled(mboxID) {
        return connector.ErrOperationNotAllowed
    }

    return s.client.LabelMessages(ctx,
        usertypes.MapTo[imap.MessageID, string](messageIDs), string(mboxID))
}
```

> **Go -> TypeScript:** `usertypes.MapTo[imap.MessageID, string]` is a **generic function call** (Go added generics in 1.18). It converts `[]imap.MessageID` to `[]string` — like `messageIDs.map(id => String(id))` in TypeScript. The `_` parameter means "I receive this but don't use it" — similar to `_state` in TypeScript destructuring.

When an IMAP client issues `COPY <uid> Labels/Work`, the bridge calls `LabelMessages(messageIDs, labelID)` on the ProtonMail API. This **adds the label to the message** — the message remains in its original mailbox and gains a new label association. No physical copy is created at the API level.

The IMAP client then sees the message appear in `Labels/Work` with a **new UID** (assigned by Gluon), creating the illusion of a copy.

## EXPUNGE From a Label — The Unlabeling Operation

**[internal/services/imapservice/connector.go:403-500](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**
```go
func (s *Connector) RemoveMessagesFromMailbox(ctx context.Context, _ connector.IMAPStateWrite,
    messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
    if isAllMailOrScheduled(mboxID) {
        return connector.ErrOperationNotAllowed
    }

    if s.isMailboxOfTypeLabel(string(mboxID)) {
        msgIDs := usertypes.MapTo[imap.MessageID, string](messageIDs)

        if err := s.client.UnlabelMessages(ctx, msgIDs, string(mboxID)); err != nil {
            return err
        }
    }
    // ... (Trash/Drafts permanent deletion logic follows)
}
```

When you STORE `\Deleted` + EXPUNGE on a message in `Labels/Work`, the bridge calls `UnlabelMessages()`. This **removes the label association** — the message continues to exist in INBOX and any other labels.

**Critical distinction from folders:** The permanent deletion logic at lines 419-500 only kicks in for Trash and Drafts. For label folders, `UnlabelMessages` is the complete operation — no deletion check follows.

The permanent deletion path is surprisingly complex:

```go
// Fetch metadata to check remaining labels
meta, err := s.client.GetMessageMetadata(ctx, msgIDs...)
// ...
for _, m := range meta {
    labelSet := m.LabelIDs
    // Remove system "virtual" labels from consideration
    labelSet = xslices.Filter(labelSet, func(id string) bool {
        return id != proton.AllMailLabel && id != proton.AllDraftsLabel &&
               id != proton.AllSentLabel && id != proton.AllScheduledLabel
    })
    // If no real labels remain, permanently delete
    if len(labelSet) == 0 {
        return s.client.DeleteMessage(ctx, m.ID)
    }
}
```

> **Go -> TypeScript:** `xslices.Filter` is like `Array.filter()`. The anonymous function `func(id string) bool { ... }` is a lambda/closure, equivalent to TypeScript's `(id: string) => boolean`.

A message is only permanently deleted when it has **zero remaining labels** after you remove it from Trash/Drafts. The system labels (AllMail, AllDrafts, AllSent, AllScheduled) are excluded from this count — they're always present on every message and don't count as "real" label assignments.

## MOVE — The Asymmetric Operation

**[internal/services/imapservice/connector.go:506-539](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**

This is where it gets interesting. `MoveMessages` is not symmetric — the behavior depends on the **types** of the source and destination:

```go
func (s *Connector) MoveMessages(ctx context.Context, _ connector.IMAPStateWrite,
    messageIDs []imap.MessageID, mboxFromID, mboxToID imap.MailboxID) (bool, error) {

    // Blocked combinations
    if (mboxFromID == proton.InboxLabel && mboxToID == proton.SentLabel) ||
        (mboxFromID == proton.SentLabel && mboxToID == proton.InboxLabel) ||
        isAllMailOrScheduled(mboxFromID) ||
        isAllMailOrScheduled(mboxToID) {
        return false, connector.ErrOperationNotAllowed
    }

    shouldExpungeOldLocation := func() bool {
        rdLabels := s.labels.Read()
        defer rdLabels.Close()

        if v, ok := rdLabels.GetLabel(string(mboxFromID)); ok && v.Type == proton.LabelTypeLabel {
            return true
        }

        if v, ok := rdLabels.GetLabel(string(mboxToID)); ok &&
            (v.Type == proton.LabelTypeFolder || v.Type == proton.LabelTypeSystem) {
            return true
        }

        return false
    }()

    // Step 1: Always add to destination
    if err := s.client.LabelMessages(ctx, ..., string(mboxToID)); err != nil {
        return false, fmt.Errorf("labeling messages: %w", err)
    }

    // Step 2: Only unlabel from source if source is a label
    if s.isMailboxOfTypeLabel(string(mboxFromID)) {
        if err := s.client.UnlabelMessages(ctx, ..., string(mboxFromID)); err != nil {
            return false, fmt.Errorf("unlabeling messages: %w", err)
        }
    }

    return shouldExpungeOldLocation, nil
}
```

> **Go -> TypeScript:** The `shouldExpungeOldLocation := func() bool { ... }()` pattern is an **immediately-invoked function expression (IIFE)** — identical to `const shouldExpungeOldLocation = (() => { ... })()` in TypeScript. `defer rdLabels.Close()` schedules `Close()` to run when the enclosing function returns — like a `finally` block. The `ok` in `v, ok := rdLabels.GetLabel(...)` is Go's "comma ok" idiom for map lookups — like `Map.has()` + `Map.get()` combined.

The asymmetry breakdown:

| From | To | API calls | IMAP behavior |
|---|---|---|---|
| **Label -> Label** | Label + Unlabel | Remove from source, appear in destination |
| **Label -> Folder** | Label + Unlabel | Remove from source, appear in destination |
| **Folder -> Label** | Label only | **Stays in source folder**, also appears in label |
| **Folder -> Folder** | Label only | Moves (old location expunged) |
| **INBOX <-> Sent** | -- | **Blocked** |
| **Any <-> AllMail** | -- | **Blocked** |

The `shouldExpungeOldLocation` return value tells the Gluon IMAP library whether to remove the message from the source mailbox view. This is how the bridge signals "this was really a COPY, not a MOVE" to the IMAP layer without changing the IMAP protocol semantics.

**Oddity:** Moving from a folder to a label doesn't call `UnlabelMessages` on the source because the source is a folder, not a label. The API's `LabelMessages` adds the label association, but the message stays in the folder. The `shouldExpungeOldLocation` flag can still be `true` (if the destination is a folder/system label), causing the IMAP client to see it disappear from the source — but at the API level, the message hasn't moved.

## Flag Sync Across Label Copies

**[internal/services/imapservice/connector.go:541-555](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go)**
```go
func (s *Connector) MarkMessagesSeen(ctx context.Context, _ connector.IMAPStateWrite,
    messageIDs []imap.MessageID, seen bool) error {
    if seen {
        return s.client.MarkMessagesRead(ctx,
            usertypes.MapTo[imap.MessageID, string](messageIDs)...)
    }
    return s.client.MarkMessagesUnread(ctx,
        usertypes.MapTo[imap.MessageID, string](messageIDs)...)
}
```

Flags are **properties of the message, not the mailbox copy**. When you set `\Seen` on `Labels/Work:7`, the bridge calls `MarkMessagesRead(messageID)` on the API — this marks the underlying message as read everywhere: INBOX, All Mail, every label folder.

**This is automatic and invisible.** The IMAP client in INBOX will see the `\Seen` flag appear on the original message without any explicit action.

The `\Flagged` flag has a particularly interesting implementation:

```go
func (s *Connector) MarkMessagesFlagged(ctx context.Context, _ connector.IMAPStateWrite,
    messageIDs []imap.MessageID, flagged bool) error {
    if flagged {
        return s.client.LabelMessages(ctx, ..., proton.StarredLabel)
    }
    return s.client.UnlabelMessages(ctx, ..., proton.StarredLabel)
}
```

**`\Flagged` is actually a label operation.** Setting `\Flagged` on a message adds the `Starred` system label. Removing `\Flagged` unlabels from `Starred`. The IMAP flag and the ProtonMail star are the same thing, implemented via the label system.

## Flag Construction from Message Metadata

**[internal/services/imapservice/helpers.go:54-77](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/helpers.go)**
```go
func BuildFlagSetFromMessageMetadata(message proton.MessageMetadata) imap.FlagSet {
    flags := imap.NewFlagSet()

    if message.Seen()     { flags.AddToSelf(imap.FlagSeen) }
    if message.Starred()  { flags.AddToSelf(imap.FlagFlagged) }
    if message.IsDraft()  { flags.AddToSelf(imap.FlagDraft) }

    if message.IsRepliedAll || message.IsReplied {
        flags.AddToSelf(imap.FlagAnswered)
    }

    if message.IsForwarded {
        flags.AddToSelf(imap.ForwardFlagList...)
    }

    return flags
}
```

> **Go -> TypeScript:** `imap.NewFlagSet()` is a constructor (Go doesn't have `new` keyword for structs — factory functions are conventional). `flags.AddToSelf(imap.ForwardFlagList...)` spreads a slice into variadic arguments.

The `Seen()` and `Starred()` methods are likely computed from the message's label IDs — a message is "starred" if its `LabelIDs` contains `proton.StarredLabel`, and "seen" if an internal flag is set.

## UID Assignment — The Gluon Layer

**[internal/services/imapservice/sync_build.go:94-110](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/sync_build.go)**
```go
func newMessageCreatedUpdate(
    apiLabels map[string]proton.Label,
    message proton.MessageMetadata,
    literal []byte,
) (*imap.MessageCreated, error) {
    return &imap.MessageCreated{
        Message:    toIMAPMessage(message),
        Literal:    literal,
        MailboxIDs: usertypes.MapTo[string, imap.MailboxID](
            wantLabels(apiLabels, message.LabelIDs)),
        ParsedMessage: parsedMessage,
    }, nil
}
```

**[internal/services/imapservice/helpers.go:122-137](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/helpers.go)**
```go
func toIMAPMessage(message proton.MessageMetadata) imap.Message {
    return imap.Message{
        ID:    imap.MessageID(message.ID),
        Flags: BuildFlagSetFromMessageMetadata(message),
        Date:  date,
    }
}
```

The bridge assigns a **single IMAP message ID** (the ProtonMail message ID) and tells Gluon "this message appears in these mailboxes" via `MailboxIDs`. Gluon then assigns **per-mailbox UIDs** internally.

This means:
- `INBOX:42` and `Labels/Work:7` are the **same message** (same `message.ID`)
- The UIDs (42 and 7) are different because they are mailbox-local
- Flag changes on either UID affect the same underlying message

## Label Events and Sync

**[internal/services/imapservice/service_label_events.go:35-211](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/service_label_events.go)**

When the ProtonMail server pushes label changes (create, rename, delete), the bridge handles them in event handlers:

```go
func (s *Service) onLabelCreated(ctx context.Context, label proton.Label) error {
    if !WantLabel(label) {
        return nil
    }
    mailboxName := GetMailboxName(label)
    // ... conflict resolution ...
    return s.publishMailboxCreated(ctx, imap.MailboxID(label.ID), mailboxName)
}
```

**Label conflict resolution** is surprisingly involved — [internal/services/imapservice/conflicts.go](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/conflicts.go) handles cases where two labels end up with the same IMAP path name:

1. Check if the conflicting label still exists on the server
2. If it was renamed/deleted remotely, update or remove it locally
3. If both labels genuinely have the same name, report to Sentry (Proton's error monitoring)
4. Cycle detection: if label A->B and B->A rename simultaneously, use a temporary `tmp_` prefix to break the cycle

## Thread Safety — The RWLabels Pattern

**[internal/services/imapservice/shared_labels.go:30-170](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/shared_labels.go)**

```go
type rwLabels struct {
    lock   sync.RWMutex
    labels labelMap
}

func (r *rwLabels) Read() labelsRead {
    r.lock.RLock()
    return &rwLabelsRead{rw: r}
}

func (r *rwLabels) Write() labelsWrite {
    r.lock.Lock()
    return &rwLabelsWrite{rw: r}
}
```

> **Go -> TypeScript:** `sync.RWMutex` is a reader-writer lock — multiple concurrent readers OR one exclusive writer. There's no equivalent in JavaScript (single-threaded), but in C# it's `ReaderWriterLockSlim` and in Java it's `ReadWriteReentrantLock`. The pattern here returns a **lock guard** object — you call `Read()` or `Write()` to acquire the lock, and `Close()` to release it. The `defer wLabels.Close()` idiom ensures release even on panic (Go's equivalent of an unhandled exception).

Usage pattern throughout the codebase:
```go
wLabels := s.labels.Write()
defer wLabels.Close()
wLabels.SetLabel(label.ID, label, "connectorCreateLabel")
```

**Oddity:** API calls happen while the write lock is held. This means a slow network call blocks all label reads. A more sophisticated design would release the lock before the API call and re-acquire after, but this simpler approach avoids race conditions between the API call and concurrent label modifications.

## How Bridge Maps Virtualized UIDs Back to Real Message IDs

### The Architecture: Gluon Owns UIDs, Bridge Never Sees Them

The bridge itself **never deals with IMAP UIDs at all**. This is the most important architectural insight.

The mapping responsibility is split cleanly between two layers:

```
IMAP Client  <->  Gluon (IMAP library)  <->  Bridge Connector  <->  ProtonMail API
                    |                           |
                 UID space                  MessageID space
              (per-mailbox ints)         (opaque API strings)
```

Gluon is Proton's own IMAP server library ([github.com/ProtonMail/gluon](https://github.com/ProtonMail/gluon)), declared at `go.mod:8`. It handles the full IMAP protocol — parsing commands, managing mailbox state, UID assignment, FETCH responses, COPYUID generation. The bridge implements a **Connector interface** that Gluon calls with already-resolved message IDs.

### The Connector Interface — Bridge's Side of the Bargain

Every Connector callback receives `imap.MessageID` (ProtonMail's API string), never `imap.UID`. Look at the signatures from [internal/services/imapservice/connector.go](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/connector.go):

```go
// Line 385 — COPY into a mailbox
func (s *Connector) AddMessagesToMailbox(ctx, _, messageIDs []imap.MessageID, mboxID imap.MailboxID) error

// Line 506 — MOVE between mailboxes
func (s *Connector) MoveMessages(ctx, _, messageIDs []imap.MessageID, mboxFromID, mboxToID imap.MailboxID) (bool, error)

// Line 541 — STORE +FLAGS (\Seen)
func (s *Connector) MarkMessagesSeen(ctx, _, messageIDs []imap.MessageID, seen bool) error

// Line 403 — STORE +FLAGS (\Deleted) + EXPUNGE
func (s *Connector) RemoveMessagesFromMailbox(ctx, _, messageIDs []imap.MessageID, mboxID imap.MailboxID) error
```

> **Go -> TypeScript:** The `_` parameter (`connector.IMAPStateWrite`) is explicitly ignored — Gluon passes it but Bridge doesn't need it for most operations. `imap.MessageID` is `type MessageID string` — just a string typedef, like `type MessageID = string & { __brand: 'MessageID' }` in branded TypeScript.

When an IMAP client sends `STORE UID 7 +FLAGS (\Seen)` while selected on `Labels/Work`, the flow is:

1. **Gluon** receives the raw IMAP command
2. **Gluon** looks up UID 7 in its SQLite database for the `Labels/Work` mailbox -> finds MessageID `"abc123"`
3. **Gluon** calls `connector.MarkMessagesSeen(ctx, state, []imap.MessageID{"abc123"}, true)`
4. **Bridge** converts and calls `client.MarkMessagesRead(ctx, "abc123")`
5. **ProtonMail API** marks the message as read

The bridge **never touches UID 7**. It doesn't know and doesn't care.

### Gluon's Database — Where UID <-> MessageID Lives

Gluon uses an **Ent ORM** (Go's TypeORM equivalent) with SQLite. The database is initialized in [internal/services/imapsmtpserver/imap.go:206-211](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapsmtpserver/imap.go):

```go
func (*storeBuilder) New(path, userID string, passphrase []byte) (store.Store, error) {
    return store.NewOnDiskStore(
        filepath.Join(path, userID),
        passphrase,
        store.WithFallback(fallback_v0.NewOnDiskStoreV0WithCompressor(...)),
    )
}
```

The database entities (derived from Gluon's Ent schema) include:

| Entity | Key fields | Purpose |
|---|---|---|
| **Mailbox** | `ID`, `RemoteID` (= `imap.MailboxID`), `UIDNext`, `UIDValidity` | Per-mailbox UID counter |
| **UID** | `UID` (uint32), FK->Message, FK->Mailbox, `Deleted`, `Recent` | **The UID<->Message mapping table** |
| **Message** | `ID`, `RemoteID` (= `imap.MessageID`), `Body`, `Envelope`, `Size` | Message content and metadata |
| **MessageFlag** | `Value` (string), FK->Message | Per-message IMAP flags |

The **UID entity** is the join table. When a message is added to a mailbox (via label), Gluon:
1. Gets the mailbox's current `UIDNext` value
2. Creates a new UID record pointing to the message and mailbox
3. Increments `UIDNext`
4. Stores the mapping in SQLite

When resolving a UID back to a message, Gluon queries:
```sql
SELECT message.remote_id
FROM uid
JOIN message ON uid.uid_message = message.id
WHERE uid.uid = ? AND uid.mailbox_ui_ds = ?
```

### How Messages Enter the UID System

When the bridge syncs messages, it publishes updates to Gluon via a channel:

**[internal/services/imapservice/sync_build.go:94-110](https://github.com/ProtonMail/proton-bridge/blob/main/internal/services/imapservice/sync_build.go)**
```go
func newMessageCreatedUpdate(
    apiLabels map[string]proton.Label,
    message proton.MessageMetadata,
    literal []byte,
) (*imap.MessageCreated, error) {
    return &imap.MessageCreated{
        Message:    toIMAPMessage(message),    // ID = ProtonMail message ID
        Literal:    literal,                   // Full RFC822 content
        MailboxIDs: usertypes.MapTo[string, imap.MailboxID](
            wantLabels(apiLabels, message.LabelIDs)),  // All mailboxes this message appears in
    }, nil
}
```

The `MailboxIDs` field is the key. For a message in INBOX with labels "Work" and "Urgent", this would be:
```
MailboxIDs: ["inbox-label-id", "work-label-id", "urgent-label-id", "all-mail-label-id"]
```

Gluon receives this single `MessageCreated` update and creates **one UID record per mailbox** — say UID 42 in INBOX, UID 7 in Labels/Work, UID 3 in Labels/Urgent, UID 155 in All Mail. All four UIDs point to the same message record (same `RemoteID`).

### The COPYUID Response — Automatic

When an IMAP client does `COPY <uid> Labels/Work`, Gluon:
1. Resolves the source UID to a MessageID
2. Calls `connector.AddMessagesToMailbox(messageIDs, labelMailboxID)` — Bridge calls `LabelMessages()` on the API
3. On success, Gluon assigns a new UID in the destination mailbox
4. Returns `OK [COPYUID <uidvalidity> <sourceuid> <destuid>]` to the IMAP client

The bridge doesn't generate the COPYUID response — Gluon does it automatically because it controls both sides of the UID assignment.

### Contrast With Our MCP Server

This is where it gets interesting. The MCP server faces the **same problem** but solves it differently because it sits on the other side of the IMAP protocol:

| | Proton Bridge | Our MCP Server |
|---|---|---|
| **Identity source** | ProtonMail API MessageID (string) | IMAP UID (per-mailbox integer) |
| **UID assignment** | Gluon assigns UIDs locally, maps to MessageID | imapflow gives us UIDs; no access to ProtonMail MessageID |
| **Copy tracking** | Gluon tracks all UIDs->MessageID in SQLite | We must use Message-ID header search (expensive) |
| **Reverse lookup** | Gluon: UID->MessageID in O(1) via database | MCP: UID->copy requires SEARCH by Message-ID across mailboxes |

The bridge has it **much easier** because it controls both sides. Gluon's database is the authoritative UID<->MessageID mapping. The bridge never needs to "find" a copy — it just tells the API "label/unlabel this message ID" and Gluon handles the UID bookkeeping.

Our MCP server is a **downstream IMAP client**. We only see UIDs, never ProtonMail MessageIDs. When `add_labels` copies `INBOX:42` into `Labels/Work`, imapflow gives us back the COPYUID response (`Labels/Work:7`). But if we later need to remove that label, we can't just say "unlabel MessageID abc123" — we have to find UID 7 in `Labels/Work` ourselves. The only reliable way is the Message-ID header search that `remove_labels` implements:

1. FETCH Message-ID from `INBOX:42`
2. SEARCH `Labels/Work` for that Message-ID
3. DELETE the found UID

This is exactly the two-phase lookup the bridge **doesn't need**, because it operates at the MessageID level above the UID layer.

### The Fundamental Asymmetry

The bridge sits between the ProtonMail API (which uses stable MessageIDs and label associations) and IMAP clients (which use per-mailbox UIDs). It owns the translation layer (Gluon's SQLite database).

Our MCP server sits below the IMAP layer. We see only what IMAP exposes — UIDs and COPYUID responses. We have no access to ProtonMail's MessageID or label association API. Every "find the copy" operation requires a search.

This is why the `add_labels` response originally leaked `newId: "Labels/Work:7"` — it was trying to give the caller a handle to the copy for future operations. But that handle is fragile (UIDs can change if UIDVALIDITY changes) and confusing (it looks like a real email ID but targets a virtual copy). The bridge doesn't have this problem because it never exposes UIDs in its API surface — it works entirely in MessageID space.

## Notable Oddities and Findings

### 1. MOVE is not atomic
`MoveMessages` calls `LabelMessages` then `UnlabelMessages` sequentially. If the second call fails, the message has been labeled in the destination but not unlabeled from the source — it appears in both places. There is no transaction or rollback.

### 2. COPY to folder is secretly MOVE
The Gluon layer (the underlying IMAP library, not the bridge itself) converts `COPY <uid> Folders/X` into a MOVE operation. This is not visible in the bridge code — it happens at the IMAP library level. The bridge's `AddMessagesToMailbox` just calls `LabelMessages`, but Gluon follows up with removal from the source. Feature test evidence: `tests/features/imap/message/copy.feature:42-50`.

### 3. INBOX <-> Sent moves are blocked
You cannot move a message between Inbox and Sent. This is because these represent fundamentally different message types in ProtonMail (received vs. sent) and the API doesn't support reclassifying them.

### 4. Hardcoded label color
Every label created via IMAP gets `#7272a7` (a muted purple). IMAP has no mechanism to specify colors, so the bridge picks a default.

### 5. AllMail is read-only
You cannot COPY to, MOVE to, or DELETE from AllMail. It's a virtual view of all messages and is always present. The `isAllMailOrScheduled()` check guards every mutating operation.

### 6. Starred is a label pretending to be a flag
The `\Flagged` IMAP flag maps to `proton.StarredLabel`. Setting `\Flagged` on a message calls `LabelMessages(..., StarredLabel)`. This is the only IMAP flag that is implemented as a label operation rather than a message metadata update.

### 7. Empty labels list -> permanent deletion
When a message in Trash/Drafts is expunged, the bridge checks if it has any remaining "real" labels. If the only labels left are system virtual ones (AllMail, AllDrafts, AllSent, AllScheduled), the message is **permanently deleted** from ProtonMail. This is the only path to permanent deletion through IMAP.

### 8. Contact group labels are silently dropped
`WantLabel()` returns `false` for `LabelTypeContactGroup`. These labels exist in the API but are completely invisible to IMAP clients. They are filtered out during sync and never create IMAP mailboxes.

## Key Source Files

| File | Purpose |
|---|---|
| `internal/services/imapservice/connector.go` | IMAP operation handlers (COPY, MOVE, DELETE, flags) |
| `internal/services/imapservice/imap_updates.go` | Mailbox name construction (`GetMailboxName`, prefix constants) |
| `internal/services/imapservice/helpers.go` | Label type classification, flag building, message conversion |
| `internal/services/imapservice/service_label_events.go` | Label lifecycle (create, update, delete events) |
| `internal/services/imapservice/shared_labels.go` | Thread-safe label storage (RWMutex lock guards) |
| `internal/services/imapservice/sync_update_applier.go` | Label sync, placeholder mailbox creation |
| `internal/services/imapservice/sync_build.go` | Message creation with label -> mailbox mapping |
| `internal/services/imapservice/conflicts.go` | Label name conflict resolution |
| `internal/services/imapsmtpserver/imap.go` | Gluon initialization and database store setup |
| `tests/features/imap/message/copy.feature` | COPY behavior integration tests |
| `tests/features/imap/message/move.feature` | MOVE behavior integration tests |
| `tests/features/imap/message/delete.feature` | EXPUNGE behavior integration tests |
