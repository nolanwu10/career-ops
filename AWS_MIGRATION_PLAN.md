# AWS Migration Plan

Porting the desktop app (`apps/desktop`) to a fully hosted, multi-user web product on AWS.

The desktop app is the source of truth for features and behavior. Everything being ported comes from there — not from `apps/web`.

---

## Phase 0: Audit & Prerequisites

**Goal:** Know exactly what's done, what's broken, what's missing before touching AWS.

1. **Inventory desktop features.** Walk every screen and route in `apps/desktop/src/renderer/renderer.js` and list each one that needs a web equivalent. This becomes the build checklist for the web app.

2. **Audit the CDK stack for production-readiness.** `apps/server/infrastructure/scanner-stack.ts` currently only has a `dev` stage. Confirm:
   - Multi-stage support (dev/prod)
   - Deletion protection on all DynamoDB tables
   - Point-in-time recovery enabled
   - CloudWatch alarms wired up
   - No hardcoded AWS account IDs

3. **Find all single-tenant assumptions.** The desktop SQLite layer hardcodes `local-user` as the user ID. Search the entire codebase for this string and any other place single-user assumptions are baked in before adding multi-user support.

4. **Decide on web hosting.** Two options:
   - **AWS Amplify Hosting** — zero-ops, CI/CD built-in, native Next.js SSR support, stays fully in AWS. Recommended for shipping speed.
   - **ECS Fargate + ALB** — more control, more ops overhead. Switch to this later if Amplify becomes a limitation.

---

## Phase 1: Storage Migration — SQLite → Cloud

**Goal:** Every user's data lives in AWS, not on their machine.

### 1a. File Storage (S3)

Create a single S3 bucket `career-ops-{stage}-user-files` with this key structure:

```
users/{userId}/resumes/{fileId}.pdf
users/{userId}/resumes/{fileId}.docx
users/{userId}/knowledge/{fileId}
```

- All uploads go through pre-signed S3 PUT URLs — never proxy file bytes through the API.
- Lambda generates the pre-signed URL; client uploads directly to S3.
- Downloads served via pre-signed GET URLs with a short TTL (~15 minutes).
- Add a lifecycle rule to delete all files when a user deletes their account.

### 1b. Structured Data (DynamoDB)

**Tables to delete from the existing CDK stack** — these all belong to the recommendations/scanning system being scrapped:

- `CareerOps-{stage}-Jobs`
- `CareerOps-{stage}-Sources`
- `CareerOps-{stage}-ScanRuns`
- `CareerOps-{stage}-Recommendations`
- `CareerOps-{stage}-FeedbackEvents`
- `CareerOps-{stage}-EnrichmentCache`
- `CareerOps-{stage}-EnrichmentBudgets`

**Tables to add** (exist only in SQLite today):

- **Applications table** — `CareerOps-{stage}-Applications`, partition key `userId`, sort key `applicationId`
- **Resume variants table** — mirrors `resume_variants` and `resume_versions` from SQLite
- **Knowledge table** — mirrors `knowledge_facts` and `knowledge_sources` from SQLite

**Tables to keep:**

- `CareerOps-{stage}-UserProfiles` — user profile and preferences

### 1c. Existing Desktop Users Migration

For users running the desktop app today, two options:

- **Option A:** Build a one-time "Migrate to cloud" flow in the desktop app that reads local SQLite and POSTs to `/v1/migrate`.
- **Option B:** Treat the web product as a fresh start. Simplest path if the current user count is small.

---

## Phase 2: Auth & Multi-User

**Goal:** Every user has their own isolated account. No data leaks between users.

### 2a. Cognito Production Setup

The current Cognito user pool is dev-only. Add a `prod` stage in CDK with:

- A separate user pool (never share dev and prod pools)
- Email verification enabled for self-sign-up
- Reasonable password policy (8+ chars, complexity required)
- Custom email sender via SES at `noreply@yourdomain.com` — Cognito's default `@cognito.com` emails go to spam
- MFA optional at launch (required MFA kills conversion)
- Token lifetimes: access token 1 hour, refresh token 30 days

### 2b. User Isolation

Every Lambda handler in `apps/server/src/api-handler.ts` extracts `userId` from the JWT `sub` claim. Before going public:

- Audit every DynamoDB query to confirm it is scoped to `userId`
- Write an integration test: log in as User A, attempt to fetch User B's data — expect 403 or 404, never data

### 2c. Browser Extension Auth Update

The extension currently talks to `localhost:3000`. It needs to:

1. Authenticate via Cognito and store tokens in `chrome.storage.local`
2. Point to the production API Gateway URL instead of localhost
3. Add a "Sign in" flow to the extension settings page

---

## Phase 3: API & Backend

**Goal:** Lambda backend is production-ready for public traffic.

### 3a. AI Systems Inventory

The recommendations tab, auto job scanner, job enrichment, and job matching engine are all scrapped. The only AI features remaining are:

| System | Lambda | Model | Notes |
|---|---|---|---|
| Resume parsing + role/location suggestions | `resume-parser` | `gpt-5.4-mini` | Extracts profile from PDF/DOCX; returns title and location chips in the same call. |
| Cover letter generation | `cover-letter-generator` | `gpt-5.4` | Full cover letter, streaming. Full model warranted — this is the core user-facing output. |

**One OpenAI API key, stored once** in AWS Secrets Manager as `career-ops/{stage}/openai-api-key`. Both Lambdas fetch it at cold start and cache in memory. Never passed through environment variables.

### 3b. API Endpoints

**Remove from the existing API** — these belong to the scrapped recommendations system:

- `GET /v1/feed`
- `POST /v1/sync`
- `POST /v1/recommendations/{id}/feedback`

**Keep:**

- `GET /v1/profile`, `PUT /v1/profile`

**Add:**

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/onboarding/resume/upload-url` | GET | Return pre-signed S3 PUT URL |
| `/v1/onboarding/resume` | POST | Trigger resume parse from S3 key |
| `/v1/onboarding/profile` | POST | Save initial profile from onboarding |
| `/v1/onboarding/cover-letter/preview` | POST | Stream sample cover letter |
| `/v1/applications` | GET / POST / PATCH / DELETE | Application tracking (ported from desktop Kanban) |
| `/v1/applications/{id}/cover-letter` | POST | Generate cover letter for a specific job |
| `/v1/resume-variants` | GET / POST / DELETE | Resume variants (ported from desktop) |
| `/v1/discovery/import` | POST | Import jobs from a user-pasted URL or sheet |
| `/v1/knowledge` | GET / POST / DELETE | Knowledge center (ported from desktop, no AI) |
| `/v1/account` | DELETE | Full account + data purge |

### 3c. Resume Parsing Lambda

New Lambda: `resume-parser`. Triggered synchronously via API Gateway after upload.

- Use `pdf-parse` and `mammoth` (already used in the desktop app) to extract raw text.
- Send extracted text to OpenAI `gpt-5.4-mini` with `response_format: { type: "json_object" }` for a structured, reliable parse.
- Single prompt returns both the `UserMatchingProfileSchema`-compatible object and the 10–15 role/location chip suggestions — one call, not two.
- Target latency: under 5 seconds for most resumes.

### 3d. Cover Letter Generation Lambda

New Lambda: `cover-letter-generator`. Used during onboarding and for every job application.

- Input: user profile + parsed resume text + job description.
- Calls OpenAI `gpt-5.4` with streaming enabled (`stream: true`). Full model is warranted here — this is the user-facing output that has to be good.
- Returns via API Gateway Lambda response streaming so the client can display tokens as they arrive.
- The sample job description used in onboarding Step 5 is hardcoded server-side — not exposed to the client.

### 3e. Knowledge Center — Port Without AI

The desktop app has AI features in the knowledge center (`apps/desktop/src/app-core.js`). Cut the AI from v1 — ship it as a plain document store (upload, tag, keyword search). Re-add AI features later once the core product is stable.

### 3f. AI Guardrails

All OpenAI calls are gated by per-user rate limits enforced before the API call is made. Limits are stored in a new `CareerOps-{stage}-AIBudgets` DynamoDB table (the old `EnrichmentBudgets` table is removed along with the enrichment system).

**Daily per-user limits (default free tier):**

| Operation | Model | Limit | Reset |
|---|---|---|---|
| Cover letter generation | `gpt-5.4` | 5 / day | Midnight UTC |
| Resume parse | `gpt-5.4-mini` | 3 / day | Midnight UTC |

**Enforcement flow:**
1. Lambda reads the user's budget record from `AIBudgets` using a conditional read.
2. If the limit is reached, return HTTP 429: `{ "error": "daily_limit_reached", "operation": "cover_letter", "resetsAt": "<ISO timestamp>" }`.
3. If under the limit, increment the counter atomically with a DynamoDB `UpdateItem` condition expression before making the OpenAI call (prevents races).
4. If the OpenAI call fails after the counter was incremented, decrement it back — don't penalize the user for API errors.

**Cost monitoring:**
- Create an AWS Budgets alert with a hard monthly ceiling on total AWS spend.
- Add a CloudWatch metric filter on Lambda logs counting OpenAI calls by operation — alarm if daily volume spikes beyond 3x the 7-day average.

### 3g. CDK Stack — What Changes

**Remove from `apps/server/infrastructure/scanner-stack.ts`:**

- All scanning Lambdas (`handler.ts`, `scan-service.ts`)
- Enrichment Lambdas (`enrichment-handler.ts`, `enrichment-service.ts`)
- Matching Lambda (`matching-handler.ts`, `matching-service.ts`, `ranking.ts`)
- SQS queues (scan queue, enrichment queue, and their dead-letter queues)
- EventBridge Scheduler rules (per-user scan schedule)
- Bedrock IAM permissions and SDK layer
- DynamoDB tables: `Jobs`, `Sources`, `ScanRuns`, `Recommendations`, `FeedbackEvents`, `EnrichmentCache`, `EnrichmentBudgets`

**Add:**

- S3 bucket with CORS policy and lifecycle rules
- `resume-parser` and `cover-letter-generator` Lambda functions
- DynamoDB tables: `Applications`, `ResumeVariants`, `Knowledge`, `AIBudgets`
- SES identity for transactional email
- CloudFront distribution for S3 static assets
- WAF on the API Gateway (IP rate limiting, SQLi/XSS rule groups)
- Secrets Manager secret: `career-ops/{stage}/openai-api-key`

---

## Phase 4: Web App — Porting from Desktop

**Goal:** Build the web app by porting features directly from `apps/desktop`.

The desktop app's UI lives in `apps/desktop/src/renderer/renderer.js` (vanilla JS). Each screen gets rebuilt as a Next.js page/component. Port in this order:

1. **Onboarding flow** (new — doesn't exist in desktop)
2. **Dashboard / pipeline view** (core screen)
3. **Discovery tab** (job board search, URL import, sheet import — replaces the old recommendations tab)
4. **Application tracking (Kanban board)**
5. **Resume builder + variants**
6. **Knowledge center** (plain document store — no AI in v1)
7. **Settings / profile**

### Onboarding Flow (7 Steps)

This is new functionality that does not exist in the desktop app. Route: `/onboarding` with step state in URL (`/onboarding/welcome`, `/onboarding/resume`, etc.).

**Step 1 — Welcome**
- Value prop in 2 sentences, "Get started" CTA.
- Static page, no API calls.

**Step 2 — Resume Upload (BLOCKING)**
- Drag-and-drop or file browse.
- Client calls `/v1/onboarding/resume/upload-url` → receives pre-signed S3 PUT URL.
- Client uploads file directly to S3.
- Client calls `/v1/onboarding/resume` with the S3 key → API parses synchronously.
- Show loading state: "Reading your resume…"
- Cannot advance until parse succeeds.

**Step 3 — Your Profile (BLOCKING)**
- Name and email pre-filled from Cognito user attributes and parsed resume.
- Role chips: 10–15 AI-suggested titles from the resume parse, user toggles what fits.
- "Add your own" text input appends to the chip list.
- Location chips: pulled from work history, user toggles + "Add your own."
- Saved to `/v1/onboarding/profile` on "Next."

**Step 4 — Preferences**
- Work mode chips: Remote / Hybrid / On-site (multi-select).
- Seniority chips (single or multi-select).
- Compensation floor: text input + currency dropdown (optional, skippable).
- All chip selections, no free text except compensation.

**Step 5 — Cover Letter Preview ("wow" moment)**
- POST to `/v1/onboarding/cover-letter/preview` with profile.
- Stream the response via `ReadableStream` / `fetch` with `response.body`.
- Display tokens arriving in a polished styled card.
- Copy: "This is what we'll generate for every job you apply to."

**Step 6 — Install Extension (soft, skippable)**
- Link to Chrome Web Store listing.
- "Skip for now" is equally prominent as "Install."
- Skipping sets a flag in user profile for later re-prompt.

**Step 7 — Enter App**
- Redirect to `/dashboard`.
- No background scan — user drives discovery manually from the discovery tab.

### Onboarding State Persistence

Store progress in a `users/{userId}/onboarding_state` DynamoDB item. If the user drops off mid-flow and returns to `/onboarding`, hydrate the step number from this record and resume where they left off.

---

## Phase 5: Web Hosting (Amplify)

**Goal:** Next.js app is publicly accessible at your domain.

1. Add an Amplify app in CDK pointing at the GitHub repo, `main` branch.
2. Build settings:
   ```yaml
   version: 1
   frontend:
     phases:
       build:
         commands:
           - npm ci
           - npm run build --workspace=apps/web
     artifacts:
       baseDirectory: apps/web/.next
       files: ['**/*']
   ```
3. Set environment variables in Amplify: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`, `NEXT_PUBLIC_COGNITO_DOMAIN`.
4. Add custom domain in Amplify — it provisions the ACM cert and updates Route53 automatically.
5. Enable preview branches so every PR gets a unique deploy URL.

---

## Phase 6: Security & Compliance Baseline

Minimum required before going public:

- **HTTPS everywhere.** Amplify and API Gateway both enforce TLS. Confirm no HTTP fallback anywhere.
- **CORS lockdown.** API Gateway CORS must only allow your production domain and the extension origin — not `*`.
- **Secrets in AWS Secrets Manager.** No secrets in environment variables. Rotate the Cognito app client secret.
- **No PII in CloudWatch logs.** Audit all Lambda `console.log` statements — resume text and cover letter content must not be logged.
- **WAF rules:** Block SQL injection patterns, rate-limit to 100 req/min per IP pre-auth and 1,000/min post-auth.
- **DynamoDB at rest:** Confirm `pointInTimeRecovery: true` and `encryption: TableEncryption.AWS_MANAGED` in CDK for every table.
- **S3 block public access.** All access via pre-signed URLs only — no public bucket policy.
- **Account deletion:** `DELETE /v1/account` must purge all DynamoDB records, S3 objects, and the Cognito user for that user.

---

## Launch Checklist

| Area | Current State | Gap |
|---|---|---|
| CDK infrastructure | Exists (dev only) | Add prod stage; remove scanning/enrichment/matching stack; add new tables, S3, WAF |
| Cognito auth | Exists (dev only) | Add prod pool, SES email, token config |
| API endpoints | Partial | Remove feed/sync/recommendations; add onboarding, applications, discovery import, cover letter, account delete |
| Web app | Not started | Port all screens from desktop; build onboarding; replace recommendations tab with discovery tab |
| Resume parsing | Desktop only | New Lambda + OpenAI `gpt-5.4-mini` |
| Cover letter generation | Missing | New Lambda + OpenAI `gpt-5.4` streaming |
| Discovery tab | Desktop only | Port job board search + URL/sheet import; no auto-scanner |
| Knowledge center | Desktop only | Port as plain document store — no AI in v1 |
| File storage | Local only | S3 bucket + pre-signed URLs |
| Applications DB | SQLite only | New DynamoDB table |
| Web hosting | None | Amplify + custom domain |
| Browser extension | Localhost only | Update to production API, add Cognito login |
| AI guardrails | None | New `AIBudgets` table, per-user daily limits |
| Security | Partial | CORS lockdown, WAF, log audit, account delete |

---

## Recommended Build Order

1. **Phase 0** — audit desktop features and `local-user` assumptions
2. **Phase 3g** — gut the CDK stack: delete scanning/enrichment/matching infra, add new tables and S3
3. **Phase 2a** — prod Cognito setup + SES email
4. **Phase 3c + 3d** — resume parser Lambda + cover letter Lambda (needed for onboarding)
5. **Phase 1a** — S3 bucket + pre-signed URL flow
6. **Phase 4** — onboarding flow + port desktop screens to web (discovery tab replaces recommendations)
7. **Phase 5** — Amplify hosting + custom domain
8. **Phase 3b** — remaining API endpoints
9. **Phase 6** — security hardening
10. **Phase 2c** — browser extension update
