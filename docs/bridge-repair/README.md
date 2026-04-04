# Repairing Proton Mail Bridge

Proton Mail Bridge occasionally encounters sync issues, database corruption, or connectivity problems. This guide walks you through diagnosing and repairing common issues using the Bridge desktop application.

---

## Table of Contents

- [Symptoms](#symptoms)
- [Quick Fixes](#quick-fixes)
- [Step-by-Step Repair](#step-by-step-repair)
- [Full Reset (Nuclear Option)](#full-reset-nuclear-option)
- [Verifying the Repair](#verifying-the-repair)

---

## Symptoms

You likely need to repair Bridge if you see any of these:

| Symptom | Likely Cause |
|---|---|
| `verify_connectivity` fails with "connection refused" | Bridge is not running or IMAP is disabled |
| `verify_connectivity` fails with "authentication failed" | Mailbox password changed or account needs re-login |
| `list_folders` returns stale or empty results | Bridge sync database is corrupted |
| Emails appear in ProtonMail web but not via MCP | Bridge is stuck syncing or needs a resync |
| Bridge shows "Update available" banner | Outdated version can cause protocol issues |
| Bridge status indicator is red/orange | General connectivity or sync issue |

---

## Quick Fixes

Try these first before a full repair:

### 1. Restart Proton Mail Bridge

The simplest fix for most transient issues.

1. **Quit Bridge** completely (right-click the system tray icon > **Quit**, or use **Bridge > Quit** from the menu bar on macOS)
2. **Wait 5 seconds** for all processes to terminate
3. **Relaunch** Proton Mail Bridge from your Applications folder

> **Tip:** After restarting Bridge, use the `drain_connections` MCP tool to force the MCP server to reconnect with fresh IMAP connections. This avoids stale connection errors.

### 2. Check Bridge Status

Open the Bridge window and check:

- **Status indicator**: Should show a green checkmark or "Connected"
- **Sync progress**: If Bridge is still syncing, wait for it to complete before using MCP tools
- **IMAP/SMTP toggle**: Ensure IMAP is enabled (should show port `1143` by default)

### 3. Re-enter Your Password

If you recently changed your ProtonMail password or enabled/disabled 2FA:

1. Open Bridge and click on your **account name**
2. You may be prompted to **sign in again**
3. After signing in, note the new **Mailbox password** — it may have changed
4. Update your `.env` file or CLI flags with the new password

---

## Step-by-Step Repair

If quick fixes don't resolve the issue, follow this repair procedure.

### Step 1: Open Bridge Settings

1. Open Proton Mail Bridge
2. Click the **gear icon** (Settings) in the bottom-left corner of the Bridge window

<!-- Screenshot: Bridge main window with gear icon highlighted -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/01-settings-icon.png -->

### Step 2: Check for Updates

1. In Settings, look for an **Update** section or banner
2. If an update is available, **install it** and restart Bridge
3. Many sync and connectivity issues are resolved by updating to the latest version

<!-- Screenshot: Bridge settings showing update section -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/02-check-updates.png -->

### Step 3: Repair Your Account

This rebuilds the local sync database without removing your account.

1. Go back to the main Bridge window
2. Click on your **account name** to expand account details
3. Look for the **"Repair"** button (it may be under an overflow menu or advanced section)
4. Click **Repair** and confirm when prompted
5. Bridge will resynchronize your mailbox — this can take several minutes depending on mailbox size

<!-- Screenshot: Account details showing Repair button -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/03-repair-account.png -->

> **Note:** During repair, the IMAP server remains running but may return incomplete results. Wait for the repair to finish before using MCP tools.

### Step 4: Verify IMAP Settings

After repair, confirm your IMAP settings are correct:

1. Click on your **account name** in Bridge
2. Check that **IMAP** shows as enabled
3. Note the displayed values:
   - **Host:** `127.0.0.1` (default)
   - **Port:** `1143` (default)
   - **Security:** STARTTLS
4. If the port differs from your configuration, update your `.env` or CLI flags

<!-- Screenshot: Account IMAP settings panel -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/04-imap-settings.png -->

### Step 5: Copy the Mailbox Password

The repair process may regenerate the mailbox password:

1. In the account details panel, click **"Mailbox password"** or the copy icon next to it
2. The bridge-generated password is copied to your clipboard
3. Update your `.env` file:
   ```
   PROTONMAIL_BRIDGE_PASSWORD=new-bridge-password-here
   ```
4. Or update the CLI flag: `--bridge-password new-bridge-password-here`

<!-- Screenshot: Mailbox password copy button -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/05-mailbox-password.png -->

> **Important:** This is the Bridge-generated mailbox password, **not** your ProtonMail login password. They are different credentials.

---

## Full Reset (Nuclear Option)

If repair doesn't work, you can remove and re-add your account. **This deletes the local cache and re-syncs everything from scratch.**

### Step 1: Remove the Account

1. In the Bridge main window, click on your **account name**
2. Click **"Remove account"** (or the trash icon)
3. Confirm the removal

<!-- Screenshot: Remove account confirmation -->
<!-- Place screenshot at: docs/bridge-repair/screenshots/06-remove-account.png -->

### Step 2: Clear Bridge Cache (Optional)

If the database is truly corrupted, clear the cache:

**macOS:**
```bash
rm -rf ~/Library/Caches/protonmail/bridge-v3/
rm -rf ~/Library/Application\ Support/protonmail/bridge-v3/cache/
```

**Linux:**
```bash
rm -rf ~/.cache/protonmail/bridge-v3/
rm -rf ~/.local/share/protonmail/bridge-v3/cache/
```

**Windows:**
```powershell
Remove-Item -Recurse "$env:LOCALAPPDATA\protonmail\bridge-v3\cache"
```

> **Warning:** Only delete the `cache` directory. Do not delete the entire Bridge configuration directory or you'll lose all account settings.

### Step 3: Re-add Your Account

1. Click **"Add account"** in Bridge
2. Sign in with your ProtonMail credentials (and 2FA if enabled)
3. Wait for the initial sync to complete (this may take 10-30 minutes for large mailboxes)
4. Copy the new **Mailbox password** and update your configuration

### Step 4: Verify Everything Works

```bash
node dist/index.js --verify \
  --bridge-username your@protonmail.com \
  --bridge-password new-bridge-password
```

---

## Verifying the Repair

After any repair procedure, verify the MCP server can connect:

```bash
# 1. Test basic connectivity
node dist/index.js --verify \
  --bridge-username your@protonmail.com \
  --bridge-password your-bridge-password

# 2. If the MCP server was already running, drain stale connections
# Use the drain_connections tool via your MCP client, or restart the server

# 3. Test a read operation
# Use list_folders via your MCP client to confirm mailboxes are visible
```

### Expected Output

A successful `--verify` prints:

```
IMAP connection verified successfully (latency: XXms)
```

If you see authentication or connection errors after repair, double-check:

1. Bridge is running and shows a green status
2. The mailbox password matches (re-copy it from Bridge)
3. The IMAP port matches your configuration (default: `1143`)
4. No firewall is blocking localhost connections on that port

---

## Adding Screenshots

This guide includes placeholder comments for screenshots. To add them:

1. Create the screenshots directory:
   ```bash
   mkdir -p docs/bridge-repair/screenshots
   ```

2. Take screenshots of each step in the Proton Mail Bridge app and save them as:
   - `01-settings-icon.png`
   - `02-check-updates.png`
   - `03-repair-account.png`
   - `04-imap-settings.png`
   - `05-mailbox-password.png`
   - `06-remove-account.png`

3. Uncomment the image references in this file to display them.

> **Privacy note:** Before committing screenshots, ensure they do not contain your email address, account name, or any other personal information. Redact or blur sensitive areas.
