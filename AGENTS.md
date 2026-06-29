# Career Ops Monorepo Development

This repository contains separate products. Keep their concerns isolated.

## Repository boundaries

- `apps/desktop/` — desktop and web application. It must not contain career-agent prompts, modes, skills, or private career data.
- `apps/browser-extension/` — browser integration for the application.
- `apps/server/` — future hosted service boundary.
- `packages/` — deterministic code shared by applications. Do not place prompts, agent instructions, or user data here.
- `classic/` — the original standalone career-ops product, including its skills, agent instructions, modes, CLI scripts, configuration, and user data.

## Development rules

- Treat `classic/` as an independent product. Changes to the desktop or server must not require loading or modifying classic agent instructions.
- The desktop app may connect to a classic runtime through `CAREER_OPS_ROOT`, but must not bundle a copied runtime.
- Put app-specific instructions in the nearest nested `AGENTS.md`.
- Preserve user data under `classic/`; never move it into an application package.
- Run the relevant product checks after changes:
  - `npm run check:desktop`
  - `npm run test:desktop`
  - `npm run test:classic`
