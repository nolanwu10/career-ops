# Desktop Application Development

This folder is the desktop and web application. Work here as an application engineer, not as the classic career-ops agent.

## Boundaries

- Do not add career-agent skills, modes, prompts, CVs, reports, trackers, or classic CLI scripts to this folder.
- Runtime/job-search data is external and selected through `CAREER_OPS_ROOT`.
- Application code belongs in `src/`.
- Browser-extension code belongs in the sibling `apps/browser-extension/` package.
- Reusable deterministic logic may move to `packages/` when at least two applications consume it.

## Checks

```bash
npm run check
npm test
```

