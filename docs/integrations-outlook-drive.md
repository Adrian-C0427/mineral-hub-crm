# Outlook, OneDrive & Google Drive

Each team member connects **their own** Outlook mailbox, OneDrive and Google
Drive. The CRM works with an account only on behalf of the person who connected
it. Teammates see an email or file only after it's filed or linked on a record
they can open.

## What each integration does

| | Outlook (Microsoft Graph) | OneDrive (Microsoft Graph) | Google Drive (Drive API v3) |
|---|---|---|---|
| Connect / reconnect / disconnect | ✓ per member, several mailboxes each | ✓ per member | ✓ per member |
| Browse / search | Folders, search, threaded conversations | My files, search | My Drive, Shared with me, shared drives, search |
| Create / organize | Mark read/unread, move, delete (to Deleted Items) | New folder, rename, move, delete (to recycle bin) | New folder, rename, move, trash |
| Send | New, reply, reply all, forward, finish a draft; attachments from the computer or the record's Documents | — | — |
| Upload / download | Attachment download | Upload (any size, chunked), download | Upload (resumable), download, Docs/Sheets/Slides export |
| Preview | Sandboxed message view | OneDrive embed | Drive embed |
| CRM records | Auto-files mail with contacts/buyers; manual "File on record"; Emails panel on deals, opportunities, contacts, buyers | Link (no copy) to deals/assets, opportunities, contacts, buyers; copy a CRM document to the drive; import a copy | same as OneDrive |
| Bulk | "Send deal by email" from the member's Outlook, paced under Exchange's 30/min | — | — |

## Permissions (OAuth scopes)

Authorization code flow with PKCE (S256), against the official Microsoft
identity platform and Google endpoints. Only what each feature needs:

- **Outlook:** `Mail.ReadWrite`, `Mail.Send`, plus `User.Read`, `openid`, `profile`, `email` and `offline_access`.
  - Not requested: `MailboxSettings`, `Contacts` or `Calendars`.
- **OneDrive:** `Files.ReadWrite` (the member's own drive), plus the same sign-in scopes.
  - Not requested: `Files.ReadWrite.All` (files other people shared) or `Sites.*`.
- **Google Drive:** `drive`, plus `openid`, `email` and `profile`.
  - Uses `access_type=offline` and `include_granted_scopes` (incremental authorization).
  - `drive` is a "restricted" scope, so the Google OAuth app must be **Internal** (Workspace users only). No Google verification or security assessment applies to an Internal app.

A connection counts as **Connected** only when every feature scope was actually
granted. If someone unchecks a permission on the consent screen, the account is
stored as *Reconnect needed* and no tokens are kept.

## Signatures

Microsoft Graph has **no API** that returns a user's Outlook signature.
Roaming signatures are not exposed, and classic Outlook keeps them as local
files. So signatures are **imported once and managed in the CRM**; they are not
synced automatically.

**How to import** (Settings → Integrations → Outlook → Signatures):
- **Paste:** copy the signature in Outlook and paste it. Fonts, colors, links and tables are kept.
- **Upload:** upload classic Outlook's `.htm` file together with its image files.
- **Preview:** the import shows exactly what recipients will see, and lists any image it couldn't read so it can be added.

**How the images travel:** stored with the signature and sent as **inline (cid:) attachments**, the way Outlook embeds them. Linked https images stay linked.

**Defaults:** each mailbox has one default signature for new messages and one for replies and forwards. The composer previews the chosen signature but doesn't let you edit it there.

**Where it goes in a message:**
- Your text comes first, in Outlook's default compose font (Aptos 12pt).
- Then the signature, inside `<div id="Signature">`.
- For replies and forwards, both sit above the quoted thread that Microsoft itself generates.
- A signature already present in pasted text or in a re-opened draft is removed first, so it never appears twice.

## Sending: identity and reliability

**Identity:**
- Every CRM email to a buyer or contact is sent **from the member's own mailbox** through Graph: draft, then attachments, then `/send`.
- It shows the member's name and address, replies go to them, and the message appears in their **Sent Items**.
- Replies and forwards use `createReply`, `createReplyAll` and `createForward`, so Outlook's own threading headers and quoted history are kept.
- Nothing CRM-branded is added to the message.
- Members **without** Outlook connected keep sending through Resend, as before. System email (password resets, reminders, portal notices) always uses Resend.

**Idempotent:** each send carries a `clientRequestId` (unique per mailbox), so a retried request returns the first result.

**Accurate status:**
- An email is marked **SENT** only after Graph accepts `/send` (202).
- If the outcome is unknown (for example a timeout), the draft is checked: no longer a draft means sent; otherwise it is failed and deleted.
- A failure before `/send` deletes the draft.

**Bulk sends** ("Send deal by email" via Outlook):
- Each buyer gets one personalized email, queued.
- A worker keeps each mailbox at no more than 28 per minute and backs off when throttled.
- Each email is logged on the deal only after Microsoft accepts it.
- Progress shows in the send window.

## Synchronization

All synchronization runs server-side in a background loop (`services/connected/sync.ts`). Each run checks first that the account's owner is still a member of the organization.

**Mail** (every 5 minutes, sooner with Graph change notifications):
- Uses the Graph delta feeds for Inbox and Sent Items, starting 14 days back so a large mailbox isn't enumerated. The delta links are stored, and an expired link restarts the window.
- **Only mail that involves a CRM record is stored.** That means an exact address match with a contact or buyer (never internal mail between team members), or a later message in a conversation that is already filed on a record.
- Filed mail creates history entries:
  - a contact timeline entry;
  - for a reply *from* a buyer, the deal's buyer reply (EMAIL_IN), "responded", and a notification. This is the behavior the old inbox import had.
- It is idempotent: unique keys on `(account, provider message id)`, the link per record, and the timeline row per email.

**Change notifications:**
- Graph webhooks at `/api/webhooks/graph`, created only when `API_URL` is public HTTPS.
- Each subscription has a random `clientState`, stored only as a SHA-256 hash and verified in constant time before acting.
- A notification only nudges a sync; its payload is never trusted.
- Subscriptions are renewed when less than a day remains, and recreated if lost.

**Drives** (every 30 minutes):
- Follows the provider change feed (OneDrive delta from `token=latest`; Drive `changes` from a start page token) and updates linked files' names, sizes and dates.
- Links that haven't been confirmed in a day are re-checked directly.
- A file deleted or trashed at the provider becomes **Missing**, and one the account lost access to becomes **No access**. Links are never deleted, and a sync never changes anything in the drive.

**Provider calls** (`services/connected/client.ts`):
- Access tokens are refreshed before expiry, one refresh per account at a time, and the rotated tokens are persisted encrypted.
- A dead grant (`invalid_grant` and similar) flips the account to *Reconnect needed*.
- Throttling (429, plus Google's 403 rate-limit reasons), 5xx and network errors are retried with exponential backoff and jitter, honouring `Retry-After`, for idempotent requests only.
- A 401 forces one refresh and retry.
- Only HTTPS calls to the provider API hosts are allowed.

## Files and the Documents module

There are three kinds of document, always labeled:

- **Stored:** in the CRM's own storage (unchanged).
- **Linked:** lives in a member's drive. The record points at it, with no copy kept. It opens at the provider, where *their* permissions apply. Only the drive's owner can download it through the CRM.
- **Copied:** a stored document the member explicitly copied to their drive. The original stays in the CRM.

Rules for drive changes:
- Nothing is silently moved or deleted.
- Delete goes to the provider's recycle bin or trash, after confirmation.
- Name conflicts fail, or keep both if you choose; nothing is overwritten. OneDrive changes are also guarded with If-Match.

Upload limits:
- Uploads stream from disk in chunks: OneDrive in 10 MiB pieces, Drive in 8 MiB.
- The file type is sniffed from its bytes. Allowed: the Documents allow-list plus PowerPoint.
- Names are sanitized (no paths, control or reserved characters).
- Size is capped by `CLOUD_UPLOAD_MAX_MB` (default 250).

## Security

- **Tokens:** AES-256-GCM encrypted at rest (`services/secrets.ts`), never sent to the browser or written to logs.
- **Logs:** carry no query strings, bodies or mail content.
- **Sign-in state:** the OAuth `state` is a 10-minute JWT with its own audience. It carries the PKCE verifier, encrypted with the server key.
  - The public callback never redeems the code. The signed-in member who started the flow finishes it with `POST /api/accounts/:provider/oauth/complete`, so a planted link can't attach someone else's mailbox.
- **Access checks:** every route checks it's the caller's own account (others get 404) and the CRM permission:
  - `sendEmail` for Outlook;
  - `manageDocuments` for drives;
  - record visibility (`viewDeals`, `viewContacts` or `viewBuyers`) for anything filed or linked on a record.
- **Mailbox privacy:** other members never read a mailbox or drive. Admins (`manageApiIntegrations`) see *who* connected *what* and can disconnect an account, but never its contents.
- **Disconnecting:**
  - It wipes the tokens, revokes the Google grant, deletes Graph subscriptions and cancels queued sends.
  - It keeps every email and file already on records.
  - Removing a member from the organization disconnects their accounts.
- **Duplicates:** the same provider account can't be connected twice in an organization.
- **Email HTML:** sanitized server-side (`sanitize-html` 2.18.1, pinned) and shown in a sandboxed iframe with no script execution.
- **Rate limits:** per member on connect, sync, browse, file changes and sending; per IP on the webhook.
- **Audit log:** connect, disconnect, send, file, link, unlink, upload, rename, move, trash and copy.

## Database (migration `20261102120000_connected_accounts_mail_files`)

The migration only **adds** things. It creates seven tables:
- `ConnectedAccount`
- `ProviderSubscription`
- `EmailMessage`
- `EmailLink`
- `EmailSignature`
- `EmailSignatureAsset`
- `CloudFileLink`

It also adds one nullable `emailMessageId` column (unique) to `ContactActivity` and to `DealBuyerMessage`, so each email is logged once. No existing table, column or row is changed.

**The old company-wide connections** (one Outlook, OneDrive and Drive per organization, read-only):
- They keep working until members connect their own.
- After that, Outlook reply import hands over to members' mailboxes, so nothing is logged twice.
- Their cards show what's happening.
- Old imported files and messages stay where they are.

## One-time setup

**Microsoft Entra ID** — the same app registration as Microsoft sign-in (`MICROSOFT_CLIENT_ID`):
1. **API permissions** → Add → Microsoft Graph → *Delegated*: `Mail.ReadWrite`, `Mail.Send`, `Files.ReadWrite`, `User.Read`, `offline_access`, `openid`, `profile`, `email`. Grant admin consent if your tenant requires it.
2. **Authentication** → Web → Redirect URIs:
   - `{API_URL}/api/integrations/outlook/oauth/callback`
   - `{API_URL}/api/integrations/onedrive/oauth/callback`

**Google Cloud** — the existing OAuth client (`GOOGLE_CLIENT_ID`):
1. Enable the **Google Drive API**.
2. Set the **OAuth consent screen** to user type **Internal**, and add the scopes `.../auth/drive`, `openid`, `email` and `profile`.
3. Under **Credentials** → the OAuth client → Authorized redirect URIs, add `{API_URL}/api/integrations/googledrive/oauth/callback`.

**Server environment:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT` (default `common`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `API_URL` (public HTTPS, for Graph webhooks). Optional: `CLOUD_UPLOAD_MAX_MB`.

## Known limits

- **Signatures:** imported, not synced (see above). If someone changes their signature in Outlook, they re-import it.
- **Shared files:**
  - OneDrive covers the member's own drive. Files other people shared would need `Files.ReadWrite.All`.
  - Google covers My Drive, Shared with me and shared drives.
- **Sending limits:**
  - Exchange Online allows about 30 messages a minute and 10,000 recipients a day per mailbox. Bulk sends are paced to fit.
  - The CRM caps attachments at 35 MB per email (`MAX_ATTACHMENTS_BYTES`). Many tenants allow less.
- **Google exports:** Docs, Sheets and Slides export at up to 10 MB.
- **Webhooks:** Graph change notifications need a public HTTPS API URL. Locally, mail syncs on the 5-minute schedule.
