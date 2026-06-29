# Career Ops Server

AWS-hosted continuous job ingestion for Career Ops.

The server currently contains:

- Source-aware ATS ingestion and DynamoDB job catalog.
- Per-user eligibility filtering and deterministic 0–100 ranking.
- Feedback affinities with atomic profile version updates.
- DynamoDB-stream matching for inserted or materially changed jobs.
- Budgeted Amazon Bedrock enrichment with content/profile-version caching.

Current development tuning:

- Amazon Nova Pro (`amazon.nova-pro-v1:0`) for recommendation explanations.
- Eligible recommendations scoring 60 or higher may be enriched.
- Up to 20 new enrichments per user per day; cached results do not consume the limit.
- Provider responses are bounded at 15 MB with a 20-second request timeout.

It does not yet expose public APIs or synchronize with the desktop client.

See [docs/app-sync-plan.md](docs/app-sync-plan.md) for the staged hosted-app synchronization plan.

```bash
npm run check
npm test
npm run synth
```

The development stack defaults to `us-east-1` and is synthesized without deploying resources.

Deployment from an authenticated AWS environment:

```bash
npm run bootstrap:dev
npm run diff:dev
npm run deploy:dev
```

The development target is AWS account `054526846770` in `us-east-1`. Deployment does not create access keys.
