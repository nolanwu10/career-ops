# Career Ops Monorepo

This repository contains two deliberately separate products:

- [`apps/desktop`](apps/desktop) — the desktop and web application under active development.
- [`classic`](classic) — the original standalone, agent-driven career-ops workflow.

The desktop application does not contain the classic skills, modes, agent instructions, or private career data. During local development it can connect to `classic/` as an external runtime through `CAREER_OPS_ROOT`.

## Common commands

```bash
npm run dev:desktop
npm run check:desktop
npm run test:desktop
npm run test:classic
```

Open `apps/desktop/` as the workspace for normal application development. Open `classic/` when you want to use or modify the original career-ops workflow.
