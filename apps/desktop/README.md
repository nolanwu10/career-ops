# Career Ops Desktop and Web

Desktop and web application for Career Ops.

This application is developed independently from the original agent-driven
workflow in `../../classic`. It does not bundle classic skills, modes, agent
instructions, or private career data.

## Windows executable

```bash
npm install
npm run build:win
```

The portable executable is written to `dist/`. It bundles Electron and Node.js,
uses the existing Career Ops folder for private data, and stores app settings in
the standard Windows user-data folder.

For an installable Windows build:

```bash
npm run build:win:installer
```

## Local Run

```bash
npm install
npm run start:web
```

Open `http://localhost:3000`.

## Server Configuration

Copy `.env.example` to `.env` on the server or set environment variables directly:

- `PORT`: HTTP port, defaults to `3000`.
- `CAREER_OPS_ROOT`: external folder containing a Career Ops runtime/data installation. In this monorepo, development defaults to `../../classic`.
- `CAREER_OPS_USER_DATA`: folder for server-side dashboard settings. Defaults to `~/.career-ops-dashboard`.
- `OPENAI_API_KEY`: server-side OpenAI API key for evaluations and cover letters.
- `OPENAI_MODEL`: default model for cover-letter generation. Internal evaluation and knowledge tasks always use `gpt-5.4-mini`.

Do not commit `.env`, `cv.md`, `portals.yml`, `config/profile.yml`, `data/`, `reports/`, or `output/`. They are ignored because they contain personal job-search data or generated artifacts.

## Runtime boundary

The app talks to an external runtime selected through `CAREER_OPS_ROOT`.
Production deployments should provision that runtime and private user data
separately from the application bundle.

## App-owned data

Local application data is stored in `local-data/career-ops.sqlite`, with
documents under `local-data/files/`. This folder is ignored by Git.

To import the existing standalone installation without modifying it:

```bash
npm run import:classic
```

The importer verifies that the classic source files were unchanged. To
deliberately rebuild and replace an existing app store:

```bash
npm run import:classic -- --replace
```
