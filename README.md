# Marcus AI

A mobile-first web application (installable as a PWA) for formatting resumes to
client-specific templates with AI assistance. Users will upload a resume (PDF,
DOCX, image), describe what they want in a chat — by typing or by voice — e.g.
_"Format my resume using Client A template"_, and download the result as DOCX or PDF.

> **Status: Phase 9 — production validation.** Email/password accounts, a
> mobile-first chat, private Cloudflare R2 file storage, deterministic resume
> extraction, MiMo v2.6 Pro assistant replies, client template analysis and the
> DOCX formatting engine exist, with startup checks, health/readiness
> endpoints, resource and rate limits, storage cleanup and a security review.
> **The complete workflow has not yet been run against live MiMo and R2**
> (no credentials were available); `npm run test:live` does that once they
> are configured. There is no OCR, no PDF output and no voice yet.
> See [Not implemented yet](#not-implemented-yet).

---

## Technology stack

| Concern       | Choice                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Framework     | Next.js 16 (App Router, Turbopack), React 19, TypeScript 6 (strict)                                             |
| Styling / UI  | Tailwind CSS 4, shadcn/ui conventions (`components.json`), lucide icons                                         |
| Database      | PostgreSQL 17, Prisma ORM 7 (`prisma-client` generator + `pg` driver adapter)                                   |
| Validation    | Zod 4                                                                                                           |
| Auth          | Auth.js (`next-auth` 4.24, current stable) — Credentials provider, JWT sessions; Argon2id via `@node-rs/argon2` |
| Storage       | Cloudflare R2 (private bucket, S3 API via AWS SDK v3) behind a `StorageProvider` interface                      |
| AI            | MiMo v2.6 Pro (OpenAI-compatible Chat Completions) behind the `AIProvider` interface                            |
| Testing       | Vitest 5                                                                                                        |
| Lint / format | ESLint 9 (`eslint-config-next`), Prettier 3 + Tailwind plugin                                                   |
| Runtime       | Node.js ≥ 22.12 (developed on 24 LTS), Docker                                                                   |

Version notes: TypeScript is pinned to 6.0.x because `typescript-eslint` does not
yet support TypeScript 7, and ESLint to 9.x because the React/import/a11y plugins
bundled by `eslint-config-next` do not yet support ESLint 10.

## Project structure

```
prisma/
  schema.prisma              # Users/auth, chat, files, extractions, templates, formatting jobs
  migrations/                # SQL migrations (committed)
prisma.config.ts             # Prisma 7 config (schema path, DATABASE_URL)
public/icons/                # PLACEHOLDER PWA icons (scripts/generate-icons.mjs)
scripts/                     # generate-icons.mjs, migrate-test-db.mjs
src/
  proxy.ts                   # Next 16 proxy: optimistic redirect of signed-out users
  instrumentation.ts         # Server start → startup checks + storage cleanup schedule
  app/                       # Routes only — thin; no business logic
    (auth)/                  # Public auth pages; signed-in users are redirected away
      login/, register/
    (chat)/chat/             # Main app: full-screen chat (layout calls requireUser())
      layout.tsx             # ChatShell: sidebar (desktop) / drawer (mobile), streamed list
      page.tsx               # /chat — new chat (conversation created with the first message)
      [conversationId]/      # /chat/:id — page, loading skeleton, not-found, error
      _components/           # Server-only loaders (conversation list)
    (dashboard)/             # Authenticated area — layout calls requireUser()
      layout.tsx             # AppShell + header + account menu
      dashboard/page.tsx     # Redirects old /dashboard links to /chat
      templates/             # /templates list + detail
    api/auth/[...nextauth]/  # Auth.js endpoints (sign-in, sign-out, session, CSRF)
    api/conversations/       # Conversation + message mutations (see "Chat")
    api/files/               # Upload authorization, confirm, discard, download URL
    api/templates/           # Client template CRUD + retry
    api/formatting-jobs/     # Formatting jobs: create, status, retry, download URL, delete
    api/register/route.ts    # POST /api/register
    api/health/route.ts      # GET /api/health
    layout.tsx               # Root layout: metadata, viewport, PWA/Apple tags
    manifest.ts              # Web app manifest (/manifest.webmanifest)
    globals.css              # Design tokens, safe-area + touch-target utilities
    error.tsx, not-found.tsx
  components/
    ui/                      # shadcn/ui-style primitives (Button, Input, Label, DropdownMenu,
                             # Dialog, AlertDialog, Sheet, FormAlert)
    layout/                  # AppShell, AppHeader, BrandLink, MainNav, PageContainer, PageHeader, EmptyState
  features/                  # Feature modules (UI + hooks per feature)
    auth/                    # Login/register forms, password input, user menu, CurrentUserProvider
    chat/                    # ChatShell, ConversationList, ChatComposer, MessageList,
                             # rename/delete dialogs, scroll + viewport hooks, API client
    files/lib/               # Shared direct-to-R2 upload helpers
    templates/               # Template list, upload dialog, detail view
    formatting/              # Format form, job list (status, download, retry, delete)
  hooks/                     # Shared client hooks (useRefreshWhile)
  lib/
    ai/                      # AIProvider interface, output schemas, provider factory
    api/client.ts            # Browser fetch wrapper for our JSON APIs (ApiRequestError)
    auth/                    # config (Auth.js), session (getCurrentUser/requireUser),
                             # password (Argon2id), validation, routes, errors, types
    chat/                    # Chat Zod schemas, DTO types, routes, title derivation
    config/                  # env.server.ts (server-only), env.public.ts, site & nav config
    db/client.ts             # Prisma client (server-only)
    documents/               # Canonical ResumeContent schema, renderer interface + registry
      docx/                  # Deterministic DOCX renderer, DOCX validation, text safety
    formatting/              # FormattingPlan schema, content refs, finalizePlan, job types
    templates/               # ClientTemplate structure schema, layout hints, types
    resumes/                 # Deterministic resume parser, extraction types
    errors/app-error.ts      # AppError hierarchy (public vs. internal messages)
    files/                   # Supported types + magic bytes, limits, upload schemas
    storage/                 # StorageProvider interface, safe key builder, provider factory
      providers/cloudflare-r2/ # The only R2-specific code (S3 client, presigning)
    utils/                   # cn(), filename sanitising
    validation/              # Shared Zod schemas (ids, pagination, file metadata)
  server/
    auth/auth-service.ts     # registerUser / authenticateWithPassword (business logic)
    chat/conversation-service.ts # Owner-scoped conversation/message/attachment persistence
    files/                   # Upload lifecycle (request/confirm/discard/download), purge
    resumes/                 # Resume extraction service (after() scheduling)
    templates/               # Template layout digest + analysis service
    formatting/              # Formatting job service (plan → render → validate → store)
    assistant/               # Chat assistant replies (MiMo)
    jobs/work-limiter.ts     # Bounded concurrency for background tasks
    maintenance/             # Hourly storage cleanup
    startup.ts               # Startup configuration checks
    users/                   # UserRepository interface + Prisma implementation
    http/                    # Route-handler wrapper, error → JSON response, body parsing
    logger.ts                # Structured JSON logger
  types/                     # API response envelope types, next-auth type augmentation
  generated/prisma/          # Generated Prisma client (git-ignored)
test/
  server-only-stub.ts        # Lets Vitest import `server-only` modules
  fakes/                     # Working in-memory implementations (not mocks) for tests
  fixtures/file-bytes.ts     # Tiny real file signatures (no binary fixtures)
docs/r2-cors.example.json    # CORS policy template for direct browser uploads
docs/deployment-digitalocean.md # Production runbook (Droplet + Managed PostgreSQL + R2)
vitest.live.config.ts        # `npm run test:live`: real MiMo + R2 end-to-end test
```

### Architectural conventions

- **Server/client boundary.** Every module that touches secrets, the database or
  providers imports `server-only`, so importing it from a client component fails
  the build. ESLint additionally forbids `@/server/*`, `@/lib/db/*`,
  `env.server` and provider factories inside `components/` and `features/`.
- **Isomorphic vs. server modules.** `lib/ai`, `lib/storage` and `lib/documents`
  each expose types and schemas from `index.ts` (safe anywhere) and keep their
  server-only factory in a separate file (`provider.ts` / `renderer.ts`).
- **Providers are swappable.** Application code calls `getAIProvider()` /
  `getStorageProvider()` / `getDocumentRenderer()` and never a vendor SDK directly.
  Implementations are added inside those factories.
- **One canonical resume model.** `lib/documents/resume-content.ts` defines
  `ResumeContent`, the contract between text extraction, AI and the DOCX/PDF
  renderers. AI output is parsed with Zod before use (`lib/ai/schemas.ts`).
- **Errors.** Throw `AppError` subclasses; route handlers wrapped in
  `withErrorHandling` return `{ error: { code, message, requestId } }`. Only an
  `AppError`'s `publicMessage` is ever returned; anything else is logged and
  replaced with a generic message.
- **Storage keys** are built from server-generated ids
  (`users/{userId}/{category}/{id}.{ext}`) — never from uploaded filenames.
- **Database access** goes through `getDb()` in `lib/db`, wrapped by
  repositories in `src/server/` (e.g. `server/users`). No raw SQL.
- **Ownership.** The signed-in user comes only from the session
  (`getCurrentUser()` / `requireUser()` / `requireApiUser()`). Every future
  resume-related table gets a `userId` FK to `User` and every query filters by
  the session user's id — never by a user id supplied by the client.

## Authentication

Auth.js (`next-auth` v4.24 — the current **stable** release; v5 is still beta)
with an email + password **Credentials** provider.

| Concern          | Implementation                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords        | Argon2id (19 MiB, t=2, p=1 — OWASP baseline) in `lib/auth/password.ts`; stored as a PHC string in `User.passwordHash`. Plaintext is never stored or logged.                                                                                       |
| Validation       | Shared Zod schemas (`lib/auth/validation.ts`): name required, valid email (trimmed + lower-cased), password 10–128 chars, confirmation must match. Client validates for UX; the server validates again.                                           |
| Registration     | `POST /api/register` → `registerUser()`. Duplicates (any email casing, including the unique-index race) get a generic 409: _"Unable to create account. An account with these details may already exist."_                                         |
| Sign in          | `signIn("credentials")` → `authenticateWithPassword()`. Unknown email, wrong password and password-less accounts all return the same _"Invalid email or password."_, with a dummy hash check to equalise timing.                                  |
| Sessions         | JWT strategy (Auth.js does not support database sessions with Credentials): encrypted, HttpOnly, `SameSite=Lax` cookie; `Secure` + `__Secure-` prefix when `APP_URL` is https. 30-day max age, rolling daily. The token carries only the user id. |
| Current user     | `getCurrentUser()` re-reads the user from PostgreSQL on every request (cached per request), so deleted users lose access immediately. `requireUser()` redirects to `/login`; `requireApiUser()` throws a 401 `AppError`.                          |
| Client access    | The dashboard layout passes the server-resolved `PublicUser` (no hash) into `CurrentUserProvider`; read it with `useCurrentUser()`. Display only — authorization stays on the server.                                                             |
| Route protection | `src/proxy.ts` redirects requests without a valid session cookie from `/dashboard/**` to `/login?callbackUrl=…` (open-redirect-safe). Layouts/pages still call `requireUser()` — the proxy is not the security boundary.                          |
| Sign out         | Account menu → `signOut()` (CSRF-protected POST) clears the session cookie and returns to `/login`.                                                                                                                                               |

**Adding OAuth later:** install `@next-auth/prisma-adapter`, add the provider to
`providers` in `lib/auth/config.ts` and set `adapter`. The `accounts`,
`sessions` and `verification_tokens` tables already exist; keep
`session.strategy: "jwt"` while the Credentials provider is enabled.

**Known limitation (JWT sessions):** signing out deletes the cookie, but a
copy of that cookie taken before sign-out stays cryptographically valid until it
expires. Server-side revocation ("sign out everywhere", invalidate on password
change) would add a `sessionVersion` column checked in `getCurrentUser()`.

## Chat

`/chat` is the main screen (the post-login landing page and PWA `start_url`).

**Data model.** `Conversation` (owned by a `User`, `title` ≤ 100 chars,
`lastMessageAt` for ordering) → `Message` (`role`: `USER | ASSISTANT | SYSTEM`,
plain-text `content`). Deleting a user deletes their conversations; deleting a
conversation deletes its messages (database `ON DELETE CASCADE`). Indexes:
`(userId, lastMessageAt DESC)` and `(conversationId, createdAt)`. Future
attachments will reference a message through their own `messageId` FK.

**Ownership.** `src/server/chat/conversation-service.ts` takes the user id from
the session and every query filters on **both** the record id and that user id
(`updateMany` / `deleteMany` / `findFirst` with `{ id, userId }`). Messages are
only reached through an owned conversation. Another user's conversation and a
non-existent one both produce the same 404 — existence is never revealed.

**API** (REST route handlers, consistent with `/api/register`; all require a
session and return `{ data }` / `{ error: { code, message, requestId } }`):

| Method & path                          | Body                   | Result                             |
| -------------------------------------- | ---------------------- | ---------------------------------- |
| `POST /api/conversations`              | `{ message?: string }` | 201 conversation (+ first message) |
| `PATCH /api/conversations/:id`         | `{ title: string }`    | 200 conversation                   |
| `DELETE /api/conversations/:id`        | —                      | 204                                |
| `POST /api/conversations/:id/messages` | `{ content: string }`  | 201 message (role `USER`)          |

Bodies are strict Zod objects (unknown keys such as `userId` or `role` are
rejected). Messages: 1–20,000 characters; leading blank lines and trailing
whitespace are dropped, everything else (indentation, blank lines) is kept.
Reads (the conversation list, a conversation with its latest 200 messages)
happen in server components through the same service, so there are no GET
endpoints yet; `listConversations` already supports cursor pagination.

**Behaviour.**

- "New chat" does not create an empty conversation: the conversation is created
  atomically with its first message and titled from that message's first line
  (deterministic truncation — no AI). Rename any time from the ⋮ menu.
- Sends are optimistic with a temporary client id; a failed message stays
  visible with **Try again** / **Discard**.
- Composer: on devices with a fine pointer (mouse/trackpad) Enter sends and
  Shift+Enter adds a line; on touch devices Enter adds a line and the send
  button sends. **Attach** opens the native file picker (see "File uploads");
  **voice** only shows an "available soon" notice — no microphone permission
  request.
- The message list scrolls independently, opens at the latest message, follows
  new content only while the reader is at the bottom, and otherwise shows a
  "scroll to latest" button (designed to follow future streamed replies).
- Mobile: conversation drawer (Radix Dialog) from the ☰ button; the layout is
  sized to the visual viewport so the composer stays above the on-screen
  keyboard (needs real-device verification on iOS).
- Assistant messages (role `ASSISTANT`) already have a distinct layout; nothing
  creates them yet. `SYSTEM` messages are never shown.
- A conversation URL owned by someone else renders the not-found screen. Because
  the route streams behind a loading skeleton, that HTML response has HTTP
  status 200 (Next.js adds `noindex`); the JSON API returns a real 404.

### Message and chat actions

ChatGPT/Claude-style actions (always visible on touch screens, on hover or focus
with a mouse):

- **Your messages:** Copy, **Edit** (inline; saving removes everything after the
  message and runs it again: a new reply and, if it asks to format, a new
  formatting job), **Retry** (removes what followed and runs it again) and
  **Delete** (with confirmation; its attachments are deleted too).
- **Assistant replies:** Copy, **Regenerate** (removes that reply onwards and asks
  again) and Delete.
- **Chat list:** a ⋮ menu on every chat with **Pin/Unpin**, **Rename** and
  **Delete**. Pinned chats are listed first in a "Pinned" group
  (`conversations.pinnedAt`).

APIs: `PATCH /api/conversations/:id` (`{ title }` or `{ pinned }`),
`PATCH|DELETE /api/conversations/:id/messages/:messageId` and
`POST /api/conversations/:id/messages/:messageId/retry` — all owner-scoped.

## File uploads (Cloudflare R2)

Users attach **PDF, DOCX, JPEG, PNG and WebP** files to chat messages. All
user files live in a **private Cloudflare R2 bucket**; DigitalOcean only hosts
the app and database. File bytes never pass through the Next.js server.

```
Browser ──1. POST /api/files {filename, contentType, sizeBytes}──▶ Next.js
          (auth, validate, generate id + key, DB row PENDING_UPLOAD, presign)
Browser ◀──2. { file, upload: { url, method: PUT, headers } }────── Next.js
Browser ──3. PUT bytes directly (presigned, 10 min, exact type+size)──▶ R2
Browser ──4. POST /api/files/:id/confirm ─────────────────────────▶ Next.js
          (HEAD object: exists + size + content type; ranged read of
           the first 16 bytes: file signature) → UPLOADED, else FAILED
Browser ──5. send message { content, attachmentFileIds } ─────────▶ Next.js
```

**Limits** (`src/lib/files/limits.ts`, enforced server-side): 20 MB per file,
5 files and 50 MB combined per message, presigned upload URL valid 10 minutes,
download URL valid 5 minutes, at most 10 unconfirmed uploads per user at once.

**Statuses** (`UploadedFileStatus`): `PENDING_UPLOAD` → `UPLOADED` (verified)
→ `PROCESSING` → `READY` (resume extraction, see below; a failed extraction
returns the file to `UPLOADED`);
`FAILED` (verification failed, object removed); `DELETED` (discarded, object
deletion requested). Only `UPLOADED`/`PROCESSING`/`READY` files can be attached
or downloaded.

**Security**

- Storage keys are generated server-side: `users/{userId}/uploads/{fileId}.{ext}`
  (32-hex random id, canonical extension of the verified type). The original
  filename is sanitised display metadata only; clients can never pass a key,
  bucket or owner (strict request schemas).
- The presigned PUT signs `Content-Type` and `Content-Length`, so the URL only
  accepts that exact type and size for that one key, for 10 minutes.
- Confirmation never trusts the browser: the server checks the stored object's
  existence, size (= declared, ≤ 20 MB), content type and magic bytes. DOCX is a
  ZIP container; only the ZIP signature is checked now — full structural
  validation comes with file processing.
- Every file query filters on file id **and** session user id; another user's
  file is a 404 on every endpoint. Attachments are only accepted for the
  sender's own verified, not-yet-attached files.
- Downloads: `GET /api/files/:id/download-url` returns a 5-minute signed URL
  (`Content-Disposition: attachment`) after the ownership check. No public
  URLs exist.
- **Uploaded files are not currently malware scanned.** The status pipeline
  leaves room for a scan step (UPLOADED → scan → PROCESSING → READY).
- Nothing in the browser bundle contains R2 credentials or the S3 SDK; the R2
  implementation lives only in `src/lib/storage/providers/cloudflare-r2/`
  behind the generic `StorageProvider` interface.

**API**

| Endpoint                                 | Purpose                                        |
| ---------------------------------------- | ---------------------------------------------- |
| `POST /api/files`                        | Authorize an upload → file + presigned PUT     |
| `POST /api/files/:id/confirm`            | Verify the stored object → `UPLOADED`          |
| `DELETE /api/files/:id`                  | Discard an unsent upload (409 if already sent) |
| `GET /api/files/:id/download-url`        | Short-lived signed GET for the owner           |
| `GET /api/files/:id/extraction`          | Extraction status + structured resume (owner)  |
| `POST /api/files/:id/extraction`         | (Re)run extraction → 202 with the claim        |
| `POST /api/conversations[/:id/messages]` | Now also accept `attachmentFileIds` (≤ 5)      |

Deleting a conversation removes its messages and attachment links, marks the
files `DELETED`, deletes their objects and then their rows (best effort).

### Local storage (development only)

Until the Cloudflare credentials are available, set `STORAGE_PROVIDER=local` in
`.env`. Files are then kept in a folder on this computer (`LOCAL_STORAGE_DIR`,
default `./storage`, git- and Docker-ignored) with the same behaviour as R2:
the browser uploads through a short-lived signed link for one server-generated
key with a fixed type and size (`PUT /api/storage/local?token=…`), downloads use
short-lived signed links, and paths outside the `users/{id}/{category}/{id}.{ext}`
layout are rejected. Env validation **refuses** `local` when
`NODE_ENV=production`, so it can never reach the live server. To switch to R2,
set `STORAGE_PROVIDER=r2` plus the `R2_*` values and restart; files saved
locally are not copied to R2.

### R2 setup

1. **Create a bucket** in the Cloudflare dashboard (R2 → Create bucket). Keep it
   **private**: do not enable the public `r2.dev` URL or attach a public custom
   domain.
2. **Create an API token** (R2 → Manage API tokens → Create API token) with
   **Object Read & Write** permission, **restricted to this bucket only**. Copy
   the Access Key ID and Secret Access Key (shown once).
3. **Configure the environment** (server-only — never `NEXT_PUBLIC_`):

   ```bash
   STORAGE_PROVIDER=r2
   R2_ACCOUNT_ID=<your Cloudflare account id>
   R2_BUCKET_NAME=<bucket name>
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   # R2_ENDPOINT=<optional override, e.g. an EU-jurisdiction endpoint>
   ```

   The endpoint defaults to `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
   With `STORAGE_PROVIDER` empty, uploads are disabled and the app shows
   "File uploads aren't available right now."

4. **Add a CORS policy** (bucket → Settings → CORS policy) so browsers may PUT
   directly. Start from [`docs/r2-cors.example.json`](docs/r2-cors.example.json)
   and list your real origin(s) — never `*`. Only `PUT` with the `content-type`
   header is needed (downloads are plain navigations, which need no CORS). Use a
   **separate development bucket** whose policy allows `http://localhost:3000`
   rather than adding localhost to the production bucket.
5. Restart the app and attach a file in the chat to verify.

### Resume extraction (PDF/DOCX → `ResumeContent`, no AI)

After an upload is confirmed, PDF and DOCX files are processed on the server:

1. The source object is read from R2 (`StorageProvider.getObject`, capped at the
   20 MB file limit). **It is never modified** — R2 stays the source of truth.
2. Text is extracted: PDF via pdf.js (`unpdf`, text layer only, first 30 pages);
   DOCX via `mammoth` (raw paragraph text). 60-second time limit.
3. `src/lib/resumes/parse-resume.ts` (deterministic, pure, unit-tested) detects
   contact details (name, headline, email, phone, location, LinkedIn/GitHub/web
   links) from the header block, common section headings (summary, experience,
   education, skills, projects, certifications, plus custom sections such as
   Languages or Volunteer), entries, bullets and date ranges
   ("Jan 2020 – Present", "2018 - 2020", "03/2019 – 05/2021").
4. The result is clamped to the schema limits and validated with the Zod
   `resumeContentSchema`, then stored in `resume_extractions` (`content` JSON,
   capped `rawText`, user-facing `warnings` such as "Couldn't detect the
   candidate's name.").

`ExtractionStatus`: `PROCESSING` → `READY` | `FAILED` (failure codes `no_text`
— e.g. scanned PDFs, `unreadable` — corrupt/password-protected,
`storage_error`, `internal`, each mapped to a safe message). File status follows
`UPLOADED → PROCESSING → READY`; on failure the file returns to `UPLOADED` so
it remains a valid attachment. Images are not extracted (no OCR yet).

Processing runs in the app process after the confirm response (Next.js
`after()`); there is no durable job queue yet. A claim left `PROCESSING` by a
restart is considered stale after 5 minutes and can be re-run with
`POST /api/files/:id/extraction`; a newer claim always wins over a stale run.
Sent PDF/DOCX attachments show "Reading resume…", "Resume read" or "Couldn't
read text". Bump `PARSER_VERSION` when the parsing rules change; stored rows
record the version that produced them.

The parser is heuristic: unusual layouts (multi-column PDFs, tables, text in
images, creative headings) can be mis-sectioned. Nothing is discarded —
unplaced text is kept as entry descriptions — and AI-assisted structuring is a
later phase.

### Cleanup

Removing an unsent attachment discards it immediately; leaving the page
discards unsent uploads best-effort; failed verification deletes the object;
deleting a conversation purges its files. An hourly task removes abandoned,
failed and deleted upload objects — see [Storage cleanup](#storage-cleanup).

## AI assistant (MiMo v2.6 Pro)

The chat answers with **Xiaomi MiMo v2.6 Pro** through the existing
`AIProvider` abstraction (`src/lib/ai/`). The MiMo-specific code lives only in
`src/lib/ai/providers/mimo/` and runs only on the server.

**Configuration** (server-only, in `.env`; never `NEXT_PUBLIC_`):

| Variable               | Default                         | Purpose                                     |
| ---------------------- | ------------------------------- | ------------------------------------------- |
| `AI_PROVIDER`          | (empty)                         | `mimo` enables AI; empty disables it        |
| `AI_API_KEY`           | (none)                          | MiMo API key (never public)                 |
| `AI_BASE_URL`          | `https://api.xiaomimimo.com/v1` | OpenAI-compatible endpoint override         |
| `AI_MODEL`             | `mimo-v2.6-pro`                 | e.g. `mimo-v2.6-flash` for faster replies   |
| `AI_TIMEOUT_MS`        | `60000`                         | Request / stream-idle limit (5 000–300 000) |
| `AI_MAX_OUTPUT_TOKENS` | `4096`                          | Upper bound per reply                       |
| `AI_THINKING`          | `disabled`                      | MiMo "thinking" mode (`enabled`/`disabled`) |

**Via OpenRouter.** MiMo v2.6 Pro can also be used through an OpenRouter key:
`AI_PROVIDER=mimo`, `AI_API_KEY=<OpenRouter key>`,
`AI_BASE_URL=https://openrouter.ai/api/v1` (model defaults to
`xiaomi/mimo-v2.6-pro`). The provider detects OpenRouter and sends its
parameter names (`max_tokens`, `reasoning` with reasoning text excluded)
instead of MiMo's (`max_completion_tokens`, `thinking`).

With `AI_PROVIDER` empty the chat works as before (messages are saved, no
replies) and the composer says so.

**Flow (streamed, ChatGPT-style).** The user's message is saved first
(`POST …/messages` or `POST /api/conversations`), then the browser calls
`POST /api/conversations/:id/reply` and reads the reply **as MiMo writes it**.
The server (`src/server/assistant/assistant-service.ts`):

1. Loads the user's own conversation (owner-scoped) and the last 40 messages.
   Problems found here (not found, already answered, a reply already running,
   AI not configured, rate limit) are ordinary JSON errors, before any streaming.
2. If a resume attached to the newest message is still being extracted, waits
   up to 15 s for it.
3. Builds context: earlier turns plus the **structured `ResumeContent`** of
   resumes attached in the conversation (newest first, up to 3). Unreadable
   files are described ("could not be read …"). Raw text, files, storage keys,
   URLs and ids are never sent.
4. Calls MiMo with `stream: true` (`AIProvider.streamResumeTask`; Server-Sent
   Events, `Authorization: Bearer`, temperature 0.3) and asks for a Markdown
   reply. Each piece of text is forwarded to the browser as it arrives, as
   newline-delimited JSON (`src/lib/chat/reply-stream.ts`): `delta` events,
   then exactly one `done` (with the saved message) or `error` (safe message).
   MiMo's reasoning text is never forwarded or stored.
5. Saves the finished reply **once**, as a single `ASSISTANT` message, and
   only if the user's message is still the newest one — no partial rows, no
   duplicates (a second reply request while one is streaming gets 409).

**In the chat.** "Thinking…" (animated) shows from the moment the request goes
out until the first real text arrives; then the reply appears progressively
with a blinking caret, rendered as Markdown (headings, bullets, numbered lists,
bold, code blocks). Text that has really arrived is revealed over a few
animation frames so chunks read smoothly — nothing is invented or delayed by
timers. The view follows the reply only while the reader is near the bottom.
While a reply is being written, Send becomes **Stop generating**: it cancels the
request, the server cancels the MiMo call and **saves nothing**; the partial
text stays on screen (faded, "not saved") with **Retry**. **Regenerate**,
**Retry** and **Edit** on messages use the same Thinking → streaming flow.

**Markdown safety.** Replies are rendered with `react-markdown` to React
elements: raw HTML is dropped, `javascript:` and other unsafe links are
removed, images are not loaded, and links open in a new tab with
`rel="noopener noreferrer nofollow"`. User messages stay plain text.

**Timeouts and interruptions.** `AI_TIMEOUT_MS` is an idle limit while
streaming (it restarts whenever data arrives; OpenRouter sends keep-alives while
the model thinks), with a hard cap of 5 minutes per reply and 20 000
characters. A stream that breaks off, goes idle or reports an error mid-way
ends with a safe error message, keeps nothing, and offers **Try again**.

**Safety.** Resume data is passed inside `<resume>` tags with an explicit rule
that it is data, not instructions (prompt-injection mitigation). Provider
failures map to safe messages: timeout → 504, rate limit → 429, invalid output
→ 502, auth/outage → 503, content filter → 422; nothing is stored and the user
can press **Try again** (or **Get a reply** later). Logs record only the error
kind/status and conversation id — never API keys, prompts, resume content or
replies. The API key, prompts and resume data never reach the browser bundle.

**Proxies.** The reply response is sent with `Cache-Control: no-store,
no-transform` and `X-Accel-Buffering: no` so compression and nginx do not
buffer it; any other reverse proxy in front of the app must not buffer
`/api/conversations/*/reply` either.

**Scope.** The assistant reviews resumes, answers questions and suggests
rewritten text. Formatting into a client template is started by the app itself
from the chat (see Resume formatting); the assistant only confirms it. It
cannot read images or scans yet — the system prompt tells it to say so.

**Limitations.** The double-reply guard is in-process, which is correct for
the single app instance planned (a multi-instance deployment needs a shared
lock). Navigating away from a chat while a reply streams keeps the request
running in the open app; closing the tab cancels it and nothing is saved.
Automated tests use mocked MiMo responses only; the live checks were run
manually against OpenRouter.

## Client templates

Users upload a client's resume template (PDF or DOCX) at **/templates**. The
template is analysed once and its structure stored; the original file is kept
**unchanged** in private R2. Templates are applied to resumes **in the chat**
(see [Resume formatting](#resume-formatting-docx)).

**Flow**

1. Upload through the normal direct-to-R2 flow with `purpose: "template"`
   (`POST /api/files`, then confirm). Template files are stored under
   `users/{userId}/templates/{fileId}.{ext}`, skip resume extraction, and can
   never be attached to chat messages.
2. `POST /api/templates { name, fileId }` creates the `ClientTemplate`
   (`PROCESSING`); analysis runs after the response (`after()`), like resume
   extraction.
3. The server reads the file from R2 and builds a **layout digest**
   (`src/server/templates/template-layout.ts`):
   - PDF (pdf.js): each line with font size and x-position, right-aligned
     segments (e.g. dates), page size, left margin, base/heading sizes, columns.
   - DOCX (mammoth + the document XML via jszip): headings, bold lines,
     bullets, table rows, fonts, default size, page size, margins, tables,
     right-aligned tab stops.
4. MiMo v2.6 Pro (`AIProvider.analyzeTemplate`) turns the digest + measured
   hints into a structure: sections in order (kind + heading as written +
   content hints), header fields, layout (columns, page size, margins, date
   alignment, bullets), typography (fonts, heading case, sizes) and
   placeholders. The JSON is validated with `clientTemplateStructureSchema`
   (one retry on invalid output) and stored as `ClientTemplate.structure`.
   Only the digest is sent — never the file, storage key or ids — and the
   digest is marked as data, not instructions.

`TemplateStatus`: `PROCESSING` → `READY` | `FAILED` (`no_text` — scanned,
`unreadable`, `storage_error`, `ai_not_configured`, `ai_unavailable`, `ai_invalid`, `internal`, each
with a safe message). Failed or stuck (> 10 min) analyses can be retried.
Templates can be uploaded while the AI provider is not configured: the file is
checked and kept, and the template shows **Waiting for AI**
(`ai_not_configured`). Once AI is configured, **Retry** analyses it without a
new upload (retrying earlier returns a clear 503).
Template names are unique per user (case-insensitive).

**API** (all owner-scoped; another user's template is a 404)

| Endpoint                              | Purpose                                       |
| ------------------------------------- | --------------------------------------------- |
| `GET /api/templates`                  | List the user's templates (no structure)      |
| `POST /api/templates`                 | Create from an uploaded template file         |
| `GET /api/templates/:id`              | Template with its validated structure         |
| `DELETE /api/templates/:id`           | Delete template + its R2 object               |
| `POST /api/templates/:id/retry`       | Re-run a failed/stuck analysis                |
| `PUT /api/conversations/:id/template` | Select (or clear) a READY template for a chat |

**UI.** `/templates` lists templates with live status; **New template** uploads
with real progress; the detail page shows the analysed sections in order,
layout/typography, placeholders and notes, with retry and delete. In a chat, ⋮
→ **Client template…** selects a template for that conversation (shown under
the title). The assistant is told which templates exist and which is selected,
and knows that asking to format in the chat starts the DOCX formatting.

## Resume formatting (DOCX)

Formatting happens **in the chat**. In a conversation with an attached resume,
the user types e.g. _"Format my resume using Client A"_. Recognised without AI
(`src/lib/formatting/chat-request.ts`): any message containing
"format"/"reformat" or "apply … template"; a short command naming one of the
user's templates (_"do it for Zillow"_, _"use Zillow"_); and a short go-ahead
(_"yes"_, _"go ahead"_) or template name answering a reply that offered
formatting. The resume is the newest one attached in that chat; the template
is the one named in the message, else one named in the reply it answers, else
the template selected for the chat (⋮ → Client template…). A name that is not
one of the user's templates (_"format as per Abbott"_) is refused with the
list of templates — never silently swapped for another.

With AI on, the **reply request starts the job** (before MiMo answers) and
tells MiMo exactly what happened — started, not started (with the reason), or
nothing — so the reply never claims formatting that isn't happening. Its job
card appears immediately, while the reply streams. Without AI, the browser
starts typed format requests itself and problems show above the composer.

**Word (DOCX) templates are filled in place** (engine version 3,
`src/lib/documents/docx/template-{blocks,fill}.ts`,
`src/lib/formatting/{fill-plan,finalize-fill-plan}.ts`). A copy of the
client's own document is edited: its tables, labels, headings, styles,
numbering, headers/footers and page setup stay; the sample candidate's
content is replaced.

1. The template body is read into addressable blocks (paragraphs `p12`,
   tables/rows/cells `t0.r1.c0`); a line joined by manual line breaks
   ("Name ↵ Location: …") becomes one block per line.
2. MiMo returns a **FillPlan** — references only, never text: which block
   shows which resume field (`contact.fullName`, `summary`, `entry.dates`…),
   which sample blocks to clear, and which sample entry / table row repeats
   per job, degree or skill. Three plans are made in parallel (each with one
   correction) and the one that places the most content wins.
3. `finalizeFillPlan` checks and repairs the plan deterministically: group
   spans, groups the model left empty (fields read from the sample entry's
   shape), groups pointed at the wrong section, content under another
   section's heading or in a labelled field it does not fit ("Pay Rate:"),
   content shown twice (the candidate summary wins over a recruiter's box),
   single date columns (shown as a range), and a **safety net**: every
   template text the plan leaves alone that is not static wording is treated
   as the sample person's and removed — form-field labels stay ("Pay Rate:"
   blank), sample entries after the repeated one are swept.
4. The filled copy is validated (every resume fact present, no sample text
   left, links safe). If filling fails for any reason the generator below
   produces the document instead (a warning says so). PDF templates always
   use the generator.

**Template rules** (both engines):

- **Contact details** appear only if the template has them (`header.fields`);
  the name is always shown. Left-out details are named in the job's warnings
  and are not expected by the validator.
- **Bullets follow the template.** Where the template shows a section as
  bullet points, running text becomes one bullet per sentence (wording
  unchanged; abbreviations like "e.g." and "Inc." are not split), and list
  sections (education, competencies) become bullet lists.
- **Content the template has no section for** (e.g. Languages) goes into one
  "Additional Information" section at the end, as bullets labelled with the
  resume's own section title, in resume order.

The job card shows live status: while queued or running, an animated page
being written, an indeterminate progress bar and the real elapsed time (no
fake percentages); then warnings, **Download DOCX**, **Retry** and delete. A
resume attached moments before is waited for (up to 90 s) while it is being
read.

```
READY ResumeContent + READY ClientTemplate structure
  → MiMo v2.6 Pro → FormattingPlan (Zod-validated; one correction on invalid JSON)
  → finalizePlan: completeness, headings, template order + facts (one AI correction if needed)
  → deterministic DOCX renderer → DOCX validation
  → private R2: users/{userId}/generated/{id}.docx → COMPLETED
```

**The AI never writes the document or the resume text.** The
`FormattingPlan` (`src/lib/formatting/plan.ts`) refers to content by reference
— `"summary"`, `"s2"` (a whole resume section) or `"s2.e0"` (one entry) — and
only chooses order, grouping, headings, per-section layout (`entries`,
`bullets`, `inline`, `paragraph`, `table`), columns, typography, colours,
spacing, bullets, dividers, page breaks and footer page numbers. The renderer
copies every word, date, name, link and number from `ResumeContent`, so
companies, titles, dates, skills, metrics or URLs cannot be invented or
reworded. The schema has no field for HTML, XML, scripts or raw markup
(unknown fields are dropped), colours are hex only and font names are
letters/digits/spaces.

**Prompt** (`src/lib/ai/prompts/formatting-prompt.ts`): the resume is
factual, the template controls presentation, never invent, place every
reference exactly once, follow the template's order and headings, put
unmatched content in the closest section or its own section. The resume and
template are marked as data. Contact **values are not sent** to the AI (only
which contact fields exist), since it only orders them.

**Checks after validation** (`src/lib/formatting/finalize-plan.ts`,
deterministic):

1. Unknown references are dropped, whole-section references expanded,
   duplicates removed.
2. Headings must be a template heading, a resume section title or a neutral
   label (Summary, Experience, …, Additional Information).
3. **Completeness:** the summary and every entry (experience, education,
   skills, projects, certifications, awards, languages, custom) must be
   placed. Name, email, phone, location and links are always rendered.
4. Sections using template headings follow the template's order.
5. Template evidence (page size, columns, margins, fonts, sizes, heading
   case, date alignment, bullet style, dividers, header alignment) overrides
   the AI where the analysis has it; unknowns keep the AI's choice.

If anything in 1–4 is wrong, MiMo gets **one controlled correction request**
listing the problems (references and headings only — no resume text). If
content is still missing afterwards it is **placed automatically** next to
related content (or in its own section) and the job shows a warning such as
_Some content from "Awards" was placed automatically._ An incomplete resume is
never produced silently.

**Renderer** (`src/lib/documents/docx/docx-renderer.ts`, the `docx` library,
behind the existing `getDocumentRenderer("docx")` abstraction): page size,
margins, fonts, sizes, bold/italic/underline, colours, alignment, paragraph
and line spacing, headings, real Word bullets (numbering), right-aligned dates
via tab stops, external hyperlinks (http/https and `mailto:` only), tables,
simple two-column layout (a borderless table; no nested tables), heading
dividers, page breaks and footer page numbers. The same input always gives the
same document body. **Layout safety:** body text 9–12 pt, headings ≤ 18 pt,
name 14–28 pt, margins 0.4–1.5 in, line spacing ≤ 1.5, bounded spacing,
light text colours replaced, no leading or consecutive page breaks. Content is
never dropped or shrunk to fit one page — long resumes use more pages.

**Validation before COMPLETED** (`src/lib/documents/docx/docx-validation.ts`):
non-empty, a readable ZIP with the required Word parts and content type, a
document body, **every text item from the resume present**, and hyperlink
targets limited to the resume's own links. Then the object is written to R2
and checked with `HEAD` (exists, same size). Any failure marks the job FAILED
and nothing is presented as a result.

**Jobs** (`FormattingJob`, same in-process `after()` pattern as extraction and
template analysis): `QUEUED` → `PROCESSING` → `COMPLETED` | `FAILED`
(`resume_unavailable`, `template_unavailable`, `ai_unavailable`, `ai_timeout`,
`ai_invalid`, `render_failed`, `validation_failed`, `storage_error`, `stale`,
`internal` — each with a safe message).

- **Duplicates:** a unique `activeKey` allows one active job per resume +
  template; creating another returns the active one (200) instead of starting
  a second.
- **Retry / recovery:** failed jobs can be retried; jobs stuck `QUEUED` > 2 min
  or `PROCESSING` > 10 min (e.g. after a restart) are retryable and are
  replaced when a new job is requested.
- **No stale overwrites:** each run claims the job with a new `startedAt` and
  every write requires that claim; a superseded run's DOCX is deleted, never
  saved.
- **Versioning:** each job stores the formatting engine version, AI model,
  resume parser version + extraction time, template analysis time, attempt
  count and the validated, completed plan (with its source ids).
- **Limitation:** processing runs inside the app process; there is no durable
  queue, so a restart loses in-flight work (recoverable by retry).

**API** (all owner-scoped; another user's resume, template or job is a 404)

| Endpoint                                    | Purpose                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `POST /api/conversations/:id/format`        | From the chat: `{ resumeFileId?, templateId?, text? }` → 202 (or 200 if active) |
| `POST /api/formatting-jobs`                 | `{ resumeFileId, templateId }` → 202 (or 200 if active)                         |
| `GET /api/formatting-jobs`                  | The user's recent jobs                                                          |
| `GET /api/formatting-jobs/:id`              | Job status, warnings, safe failure message, document info                       |
| `POST /api/formatting-jobs/:id/retry`       | Re-run a failed/stuck job (202)                                                 |
| `GET /api/formatting-jobs/:id/download-url` | Short-lived signed R2 URL for the DOCX (attachment)                             |
| `DELETE /api/formatting-jobs/:id`           | Delete a finished job and its DOCX object                                       |

Creating a job needs the AI provider and storage to be configured (503
otherwise). Generated files get a server-generated key and a sanitised
download name (`<Candidate> - <Template>.docx`); only metadata is stored in
PostgreSQL (`generated_documents`). The original resume and template files
are never read for writing or modified.

**UI.** Everything is in the chat (there is no separate Format page): job
cards are placed in the conversation after the message that started them. Jobs are linked to their conversation
(`formatting_jobs.conversationId`, `ON DELETE SET NULL`). On phones the header
shows Chat · Templates; Dashboard is in the account menu.

## Local development

### Prerequisites

- Node.js 22.12+ (24 LTS recommended) and npm
- PostgreSQL 17 — easiest via Docker (see below), or a local install

### Setup

```bash
npm install                # also runs `prisma generate`
cp .env.example .env       # then set AUTH_SECRET (command below) and adjust values
docker compose up -d db    # start PostgreSQL (or point DATABASE_URL at your own)
npm run db:deploy          # apply migrations
npm run dev                # http://localhost:3000 → /login
```

Generate a development `AUTH_SECRET` (≥ 32 characters) and paste it into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Without Docker, a local PostgreSQL 17 works too: create a role/database matching
`DATABASE_URL` (the role needs `CREATEDB` so `prisma migrate dev` can create its
temporary shadow database).

To open the app on a phone on the same Wi-Fi network, use the "Network" URL that
`npm run dev` prints. (Some PWA features require HTTPS; see below.)

## Environment variables

Copy `.env.example` to `.env`. `.env` is git-ignored; never commit real values.

| Variable                                                                          | Scope      | Required                    | Purpose                                                          |
| --------------------------------------------------------------------------------- | ---------- | --------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                                                    | server     | yes                         | PostgreSQL connection string                                     |
| `APP_URL`                                                                         | server     | no (default localhost:3000) | Public base URL; Auth.js callback origin; https ⇒ Secure cookies |
| `AUTH_SECRET`                                                                     | server     | **yes** (≥ 32 chars)        | Encrypts session cookies; rotating it signs everyone out         |
| `TEST_DATABASE_URL`                                                               | tests only | no                          | Separate DB for integration tests; skipped when empty            |
| `AI_PROVIDER`                                                                     | server     | no                          | `mimo` enables assistant replies; empty disables AI              |
| `AI_API_KEY`                                                                      | server     | if `AI_PROVIDER` set        | MiMo API key (never public)                                      |
| `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_THINKING` | server     | no                          | See "AI assistant" for defaults                                  |
| `STORAGE_PROVIDER`                                                                | server     | no                          | `r2` enables uploads; empty disables them                        |
| `R2_ACCOUNT_ID` (or `R2_ENDPOINT`), `R2_BUCKET_NAME`                              | server     | if `STORAGE_PROVIDER=r2`    | R2 S3 endpoint + private bucket                                  |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                        | server     | if `STORAGE_PROVIDER=r2`    | Bucket-scoped R2 API token (never public)                        |
| `ALLOW_DISABLED_SERVICES`                                                         | server     | no (default `false`)        | Production refuses to start without AI + R2 unless `true`        |
| `STORAGE_CLEANUP`                                                                 | server     | no (default `true`)         | Hourly cleanup of abandoned/failed/deleted upload objects        |
| `NEXT_PUBLIC_APP_NAME`                                                            | **public** | no                          | Display name (inlined into the client at build)                  |

Server variables are validated with Zod in `src/lib/config/server-env-schema.ts`
and read only via `getServerEnv()` (cached; validation errors name the
variable but never print its value). They are validated at server start
(see [Production readiness](#production-readiness)); production requires the AI
provider and R2 to be configured. Only `NEXT_PUBLIC_*` variables reach the
browser, and they are fixed at **build** time.

## Database (PostgreSQL + Prisma)

`docker-compose.yml` runs PostgreSQL 17 on `127.0.0.1:5432` with local-only
credentials matching `.env.example`.

| Command                   | What it does                                                  |
| ------------------------- | ------------------------------------------------------------- |
| `npm run db:generate`     | Generate the Prisma client into `src/generated/prisma`        |
| `npm run db:migrate`      | Create + apply a new migration in development (`migrate dev`) |
| `npm run db:deploy`       | Apply committed migrations (CI / production)                  |
| `npm run db:studio`       | Browse data in Prisma Studio                                  |
| `npm run db:test:prepare` | Apply migrations to `TEST_DATABASE_URL` (non-destructive)     |

Migrations:

- `20261007000000_init` — `users`, `accounts`, `sessions`, `verification_tokens`
  (the tables the Auth.js Prisma adapter expects).
- `…_add_user_password_hash` — adds the nullable `users.passwordHash` column
  (null for future OAuth-only users). Additive; no data loss.
- `…_add_conversations_and_messages` — `MessageRole` enum, `conversations`,
  `messages`, indexes and cascading foreign keys. Additive.
- `…_add_uploaded_files_and_attachments` — `UploadedFileStatus` enum,
  `uploaded_files`, `message_attachments`. Additive.
- `…_cascade_attachments_on_file_delete` — attachment→file FK becomes
  `ON DELETE CASCADE` so deleting a user always succeeds.
- `…_add_resume_extractions` — `ExtractionStatus` enum and `resume_extractions`
  (one per file, cascades with the file and the user). Additive.
- `…_add_client_templates` — `FilePurpose` (`uploaded_files.purpose`, default
  ATTACHMENT), `TemplateStatus`, `client_templates` (unique name per user,
  cascades with the user and its file) and `conversations.clientTemplateId`
  (`ON DELETE SET NULL`). Additive.
- `…_add_formatting_jobs` — `FormattingJobStatus`, `formatting_jobs` (unique
  nullable `activeKey`; resume file and template links `ON DELETE SET NULL`
  so finished results survive) and `generated_documents` (one per job,
  unique storage key). Additive; no existing table changed.
- `…_link_formatting_jobs_to_conversations` — nullable
  `formatting_jobs.conversationId` (`ON DELETE SET NULL`) + index, so job cards
  show in the chat that started them. Additive.
- `…_add_conversation_pinning` — nullable `conversations.pinnedAt`. Additive.

Later phases add tables with new migrations. Never use `prisma migrate reset` or
`db push --force-reset` against shared databases.

## Running, testing and checks

| Command             | Purpose                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `npm run dev`       | Development server                                                                     |
| `npm run build`     | Production build                                                                       |
| `npm start`         | Serve the production build locally                                                     |
| `npm run lint`      | ESLint                                                                                 |
| `npm run typecheck` | Generate Next.js route types, then `tsc --noEmit`                                      |
| `npm test`          | Vitest — unit tests, plus PostgreSQL integration tests when `TEST_DATABASE_URL` is set |
| `npm run format`    | Prettier (write); `format:check` to verify                                             |
| `npm run check`     | format:check + lint + typecheck + test                                                 |
| `npm run test:live` | REAL end-to-end workflow against MiMo + R2 (paid; see Production readiness)            |
| `npm run icons`     | Regenerate placeholder PWA icons                                                       |

## Docker

The `Dockerfile` is multi-stage and produces a small, non-root image running the
Next.js standalone server on port 3000, with a `HEALTHCHECK` against `/api/health`.

```bash
docker build -t resume-formatter .
docker run --rm -p 3000:3000 --env-file .env resume-formatter

# Apply migrations with the one-off migrator target
docker build --target migrator -t resume-formatter-migrator .
docker run --rm --env-file .env resume-formatter-migrator

# Or run PostgreSQL + the app image together
docker compose --profile app up -d --build
```

Secrets are passed at runtime (`--env-file`), never baked into the image.
`NEXT_PUBLIC_*` values must be passed as `--build-arg` because they are inlined at build time.

## Deployment (DigitalOcean)

Step-by-step runbook: [`docs/deployment-digitalocean.md`](docs/deployment-digitalocean.md)
— Droplet + Docker (non-root standalone image), DigitalOcean Managed
PostgreSQL, Cloudflare R2 for **all** files (DigitalOcean stores none), an
HTTPS reverse proxy, the migration step (`migrator` image, non-destructive
`prisma migrate deploy`), health/readiness checks and a release checklist.
Not yet executed against a real DigitalOcean account.

## Production readiness

### Startup and health

- **Startup checks** (`src/instrumentation.ts` → `src/server/startup.ts`): the
  environment is validated when the server boots. In production the process
  exits (code 1) with a log line naming the problem — never a secret value —
  when a required variable is missing/invalid, or when the AI provider or R2
  storage is not configured (override deliberately with
  `ALLOW_DISABLED_SERVICES=true`, e.g. for a staging smoke test).
- `GET /api/health` — liveness (process up; no database access).
- `GET /api/health/ready` — readiness: `200 {"status":"ready"}` when the
  configuration is valid and PostgreSQL answers within 3 s, otherwise `503`.
  Reports only `ok`/`unavailable` and `configured`/`disabled` per service.
- A database outage returns `503` "The service is temporarily unavailable" from
  APIs (Prisma connection errors are mapped; details only in server logs) and
  "Sign-in is temporarily unavailable" on the login page.

### Resource limits

| What                               | Limit                                                                      | When exceeded                    |
| ---------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| Upload size                        | 20 MB per file (signed into the presigned PUT; verified)                   | 400 before upload / rejected     |
| Pending uploads                    | 10 unconfirmed per user; 120 upload requests / hour                        | 429                              |
| DOCX decompression (zip bombs)     | ≤ 1 000 parts, ≤ 30 MB per part, ≤ 60 MB total (bounded inflate)           | file treated as unreadable       |
| PDF pages                          | 30 (resumes), 5 (templates)                                                | extra pages ignored              |
| Extraction / template layout time  | 60 s each                                                                  | FAILED (unreadable), retryable   |
| Background concurrency             | 3 heavy tasks per process (extraction, analysis, formatting); others queue | waits                            |
| Active formatting jobs             | 3 per user; 30 new jobs / hour; 1 per resume + template                    | 429 / existing job returned      |
| AI request                         | `AI_TIMEOUT_MS` (60 s) per call, `AI_MAX_OUTPUT_TOKENS` (4 096)            | timeout → FAILED, retryable      |
| AI planning (all calls of one job) | 4 minutes                                                                  | FAILED "took too long"           |
| AI input (resume sent to MiMo)     | 60 000 characters (never truncated)                                        | FAILED "too long to format"      |
| Template digest sent to MiMo       | 30 000 characters                                                          | truncated (layout evidence only) |
| Chat context                       | 20 turns × 4 000 chars, 3 resumes                                          | older context dropped            |
| DOCX rendering                     | 30 s                                                                       | FAILED, retryable                |
| Generated DOCX                     | 10 MB                                                                      | FAILED (validation)              |
| JSON request bodies                | 1 MB (counted while streaming, not just Content-Length)                    | 413                              |
| Sign-in                            | 30 / 15 min per IP, 10 / 15 min per email                                  | "Too many sign-in attempts"      |
| Sign-up                            | 10 / hour per IP                                                           | 429                              |
| Assistant replies / templates      | 40 / 10 min; 200 templates / hour per user                                 | 429                              |

Rate-limit counters are in process memory (single-instance deployment); a
restart resets them.

### Storage cleanup

An hourly in-process task (`src/server/maintenance/storage-cleanup.ts`, on
when storage is configured; `STORAGE_CLEANUP=false` disables it) removes, in
batches of 200, objects first and rows second:

- `PENDING_UPLOAD` older than the presigned-URL lifetime + 1 h (the browser
  may have uploaded but never confirmed);
- `DELETED` rows whose object deletion failed earlier;
- `FAILED` uploads older than 24 h.

It never touches sent attachments, template source files, uploaded resumes
or generated documents. Those are removed only by their explicit flows:
deleting a conversation (its attachments), deleting a template (its source
file), deleting a formatting job (its DOCX), discarding an unsent upload.
Generated files from failed or superseded runs are deleted immediately.
Remaining gaps: deleting a **user account** (no UI yet) leaves that user's
objects in R2, and an unsent upload that was never discarded (e.g. the tab
crashed) stays stored until the user deletes it.

### Security review (Phase 9)

Every route, page and service was reviewed for authentication, ownership,
storage access, secret exposure, prompt injection, logging and error leaks.
No authentication or ownership bypass was found; integration tests prove
isolation for conversations, files, resumes, templates, formatting jobs and
generated documents. Hardening added in this phase:

- Open-redirect fix for `callbackUrl` values containing tabs/newlines.
- Rate limits for sign-in, sign-up, uploads and AI-backed endpoints.
- `Origin` check on every state-changing API request (CSRF defence in depth).
- JSON body limit enforced while streaming.
- Production `Content-Security-Policy` (scripts/styles self + inline, connect
  to self and `*.r2.cloudflarestorage.com`, `frame-ancestors 'none'`) and HSTS.
- Uploaded/template text embedded in prompts can no longer close its
  `<resume>`/`<template>`/`<digest>` data block (`<` is escaped).
- DOCX zip-bomb guard before any parser decompresses an upload.
- A template's source file can't be discarded directly (would delete the template).
- Logs: parser errors are logged by type only.

### Real end-to-end test (`npm run test:live`)

`src/server/formatting/real-workflow.live.test.ts` runs the complete
workflow against the **real** services in `.env` and the **test** database:
synthetic resume → presigned PUT to R2 → confirm → extraction → synthetic
template → R2 → MiMo template analysis → MiMo formatting plan → DOCX → R2 →
signed download (+ a tampered-signature check) → DOCX validation. A copy of
the DOCX is written to `tmp/live-e2e/` (git-ignored) for review in Word, and
everything created is deleted afterwards (through the product's own delete
flows, then verified with `HEAD`). It is excluded from `npm test` and skips
itself unless `AI_PROVIDER`, `AI_API_KEY`, `STORAGE_PROVIDER=r2` and
`TEST_DATABASE_URL` are set. It makes paid MiMo calls.

## Supported formats

| Input            | Formats                       | Notes                                                              |
| ---------------- | ----------------------------- | ------------------------------------------------------------------ |
| Resumes          | PDF (with a text layer), DOCX | ≤ 20 MB. Scanned PDFs and images are stored but not read (no OCR). |
| Client templates | PDF (with a text layer), DOCX | Layout is analysed from text positions/styles; images are ignored. |
| Chat attachments | PDF, DOCX, JPEG, PNG, WebP    | Images are kept for reference only.                                |
| Output           | DOCX                          | PDF output is not implemented.                                     |

## Known formatting limitations

The renderer reproduces a template's **structure and style**, not its exact
pixels:

- Fonts are named, not embedded: if the reader's computer lacks the font,
  Word substitutes one. Unknown fonts fall back to Calibri.
- Two-column templates become a borderless two-column table (sidebar +
  main); if no section belongs in the sidebar, the result is single column.
  Section columns (newspaper style) are not reproduced.
- Logos, photos, icons, coloured shapes, text boxes, watermarks and
  background images in templates are not reproduced.
- Header/footer content other than page numbers is not reproduced.
- Exact spacing is approximated within readable bounds (body 9–12 pt,
  margins 0.4–1.5 in, line spacing ≤ 1.5); a template using extreme values is
  rendered with the nearest readable value.
- Dates are placed right-aligned (tab stop), inline, below the title, or in a
  dates column — whichever is closest to the template.
- Template analysis quality depends on the template's text layer; scanned
  templates fail with a clear message.
- Page count is not controlled: long resumes flow onto more pages instead of
  being shrunk or cut.
- The plan can reorder and regroup content and choose headings, but it never
  rewrites wording — tense, bullet text and dates are exactly as extracted.
  Extraction errors (e.g. a misread date) are therefore carried through.

## Troubleshooting

| Symptom                                                        | Cause / fix                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Container exits immediately: "Startup configuration error"     | Read the log line: a variable is missing/invalid, or AI/R2 isn't configured. Fix `app.env`.                        |
| `/api/health/ready` → `database: unavailable`                  | Check `DATABASE_URL`, `sslmode=require`, and that the Droplet is a trusted source of the managed database.         |
| "File uploads aren't available right now."                     | `STORAGE_PROVIDER`/`R2_*` not set (development only — production refuses to start).                                |
| Upload fails in the browser (CORS error in the console)        | R2 CORS policy missing your exact origin, or `PUT` / `content-type` not allowed.                                   |
| Upload fails with a CSP error in the console                   | A non-default R2 endpoint host: add it to `connect-src` in `next.config.ts`.                                       |
| "Could not verify the uploaded file"                           | Size/type/signature mismatch (e.g. a renamed file); upload the real PDF/DOCX.                                      |
| Resume shows "couldn't be read" / "scanned image"              | Password-protected, damaged, or image-only PDF; export a text PDF or DOCX.                                         |
| Template stuck "Analysing…" / formatting stuck "Formatting…"   | The server restarted mid-task. After 10 minutes **Retry** appears.                                                 |
| "The AI returned an unusable formatting plan"                  | MiMo produced invalid output twice; retry. Repeated failures: check the MiMo model/key and `AI_MAX_OUTPUT_TOKENS`. |
| "Formatting took too long"                                     | MiMo was slow; retry, or raise `AI_TIMEOUT_MS`.                                                                    |
| "Some content … was placed automatically"                      | The AI plan left content out; it was added next to related content. Review that section in the DOCX.               |
| Download link shows an R2 `AccessDenied`/`Request has expired` | Signed links last 5 minutes; click **Download DOCX** again (a fresh link is issued each time).                     |
| "Too many …" messages                                          | Rate limits (see table above); wait and retry.                                                                     |

## PWA status

**Implemented (foundation):** web app manifest (`/manifest.webmanifest`,
`display: standalone`, `start_url: /chat`), theme colours, placeholder
icons (192, 512, maskable 512, 180 Apple touch icon), Apple web-app meta tags,
`viewport-fit=cover` with safe-area CSS utilities (`pt-safe`, `pb-safe`,
`px-safe`), and `interactive-widget=resizes-content` for keyboard-aware layouts.

**Not yet verified:** "Add to Home Screen" has **not** been tested on a real
iPhone or Android device. Installation requires serving over HTTPS (or
`localhost`).

**Remaining:**

- Replace placeholder icons with real artwork (and add iOS splash screens if desired).
- Service worker for offline shell/caching (deliberately deferred — caching
  authenticated, private resume data needs careful design).
- Test install + standalone launch on iPhone Safari and Android Chrome over HTTPS.

## Mobile UX foundation

- **Brand theme:** black, white and one red (`#ec0a14`) in a light and a dark
  theme, defined by the tokens in `src/app/globals.css` (all components use
  them). Dark is the default; the sun/moon button in the top-right corner of
  every screen (app header, chat header, sign-in pages, phones included)
  switches it. The choice is stored per device (localStorage) and
  applied before the first paint (`src/lib/theme.ts`). The red passes WCAG AA
  on white, on black and with white text. The wordmark
  (`BrandLink`/`Wordmark`) is thin, upper-case and widely spaced, with a red dot
  over the first "i" of `NEXT_PUBLIC_APP_NAME` (or a leading dot if it has none).
  PWA icons (`npm run icons`) show the red-dotted "i" on black.
- Mobile-first Tailwind classes; layouts scale up with `sm:`/`md:`/`lg:`.
- `AppShell` — full-height (`dvh`) frame with sticky header, single scroll area
  and an optional safe-area-aware bottom `footer` slot intended for the chat composer.
- 44px minimum touch targets (`touch-target` utility, Button sizes).
- Form controls are ≥ 16px on small screens to prevent iOS zoom-on-focus.
- System font stack (no web-font download), light/dark via `prefers-color-scheme`.

## Security baseline

- Secrets are server-only (`server-only` imports + ESLint boundary rules).
- Env validation never prints secret values.
- All external input is parsed with Zod (`parseJsonBody`, `parseOrThrow`).
- Internal errors are never exposed; responses include a `requestId` for support.
- Uploaded filenames are sanitised for display and never used in storage keys;
  uploads are verified by size, type and magic bytes (see "File uploads").
  **Files are not malware scanned yet.**
- Baseline security headers (`nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`); `X-Powered-By` disabled.
- Passwords hashed with Argon2id; hashes are selected only inside the auth
  service and never returned by any API, page prop or session.
- JSON APIs require `Content-Type: application/json` (cross-site HTML forms
  cannot send it), Auth.js endpoints use their own CSRF token, and cookies are
  `SameSite=Lax` + HttpOnly.
- AI output is untrusted: every response is Zod-validated; formatting plans
  reference resume content instead of containing it, and generated DOCX text
  is always XML-escaped by the renderer (never interpreted as markup).
  Prompts, resume content and AI output are never logged.
- Production Content-Security-Policy and HSTS; `Origin` checks on state-changing
  APIs; in-memory rate limits for sign-in, sign-up, uploads and AI endpoints
  (see [Production readiness](#production-readiness)).
- Deferred: CSP nonces (inline scripts are currently allowed), shared rate
  limits for multi-instance deployments, email verification, password reset,
  breached-password checks, malware scanning for uploads.

Known advisories: `npm audit` reports high-severity issues only in dev tooling
(`mysql2` and `deepmerge-ts` inside the Prisma CLI — `mysql2` is unused with
PostgreSQL — and `braces` via `eslint-config-next`). The only automatic fix
downgrades Prisma to v6, so these are tracked rather than force-fixed.
`mammoth` pulls in `argparse` → `sprintf-js` (moderate advisory); it is only
used by mammoth's command-line interface, which the app never runs.

## Not implemented yet

Intentionally deferred to later phases:

- Account management: settings page, email verification, password reset,
  change password/email, account deletion, social/OAuth login
- OCR for images and scanned PDFs, AI-assisted resume structuring, malware
  scanning, a durable job queue for extraction, a UI to view/edit the
  extracted resume, image thumbnails for sent attachments
- Scheduled cleanup job for stale/orphaned uploads (strategy documented above)
- PDF output; editing/renaming templates; a visual template or document
  editor; a durable job queue for formatting (jobs run in the app process)
- Voice input
- AI-generated titles, streamed (token-by-token) replies, AI-assisted resume
  structuring, durable background jobs for AI calls
- Loading older messages beyond the latest 200; conversation search
- Service worker / offline support, CI pipeline, an executed production
  deployment, account deletion (with R2 object removal), final (non-placeholder)
  PWA icons
