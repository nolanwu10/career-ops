# Hosted App and AWS Backend Synchronization Plan

## Goal

Use the AWS job catalog and recommendation pipeline as the source of truth while the
desktop/web application remains usable locally during development.

## Architecture

1. Add an authenticated HTTPS API in front of the existing DynamoDB repositories.
2. Use Amazon Cognito for user accounts and short-lived JWT access tokens.
3. Use API Gateway HTTP API with Lambda handlers for profile, feed, feedback, and
   application-state operations.
4. Keep DynamoDB private. Neither the browser nor desktop application receives AWS
   credentials or direct table access.
5. Add a sync client to the shared application core so Electron and the future hosted
   web application consume the same API contracts.
6. Retain local SQLite as an offline cache and outbox for reversible local development.

## Initial API

- `GET /v1/feed` — cursor-paginated recommended jobs with filters.
- `GET /v1/jobs/{jobKey}` — complete normalized job and explanation.
- `GET /v1/profile` and `PUT /v1/profile` — matching preferences and profile version.
- `POST /v1/recommendations/{id}/feedback` — save, dismiss, not interested, apply.
- `GET /v1/activity` — saved, evaluated, and applied views.
- `POST /v1/sync` — batch upload local actions and receive changes since a cursor.

All writes use an idempotency key. Feed and sync responses return a server cursor and
record version so retries cannot duplicate actions or overwrite newer state.

## Local Development

- Configure `CAREER_OPS_API_URL` and Cognito development settings through environment
  variables.
- Provide a local mock API mode for deterministic desktop tests.
- On startup, load SQLite immediately, then refresh from AWS in the background.
- Store local actions in an outbox when offline and replay them after reconnection.
- Display last-sync time and degraded/offline state instead of blocking the interface.

## Delivery Stages

### Stage 1: Read-only feed

Deploy Cognito, API Gateway, feed/detail Lambdas, and typed API contracts. Add a
feature-flagged Recommended screen to the local app.

### Stage 2: Feedback and profile

Synchronize save, dismiss, not-interested, applied state, filters, and matching profile.
Feed ranking then learns from these hosted feedback events.

### Stage 3: Offline and migration

Add SQLite cache/outbox, conflict handling, and one-time import of local application
state. The server remains authoritative after migration.

### Stage 4: Hosted web application

Host the renderer as static assets behind CloudFront and S3 or AWS Amplify Hosting.
Reuse Cognito and the same API; keep Electron as an optional desktop shell.

## Security and Cost Controls

- Cognito user identity determines every DynamoDB partition key.
- API Lambdas receive least-privilege table access.
- Add per-user API throttles and AWS WAF only when public traffic justifies it.
- Cursor pagination and bounded filter options prevent table-wide scans.
- CloudFront caches public static assets; private feed responses remain uncached.
- Add AWS Budgets alerts, API error alarms, and request/latency dashboards before beta.
