# Contributing

This server drives a live Premiere Pro session, so a tool is only done when it has been run against a real project, not just schema-checked.

## Setup

```bash
npm install
npm run build
npm run setup:mac   # installs the CEP panel and enables PlayerDebugMode
```

## Development loop

1. Change the TypeScript (`src/`) or the CEP panel (`cep-plugin/`).
2. `npm run build`.
3. If you changed `cep-plugin/bridge-cep.js`, reload the panel in Premiere (close and reopen it, or restart Premiere).
4. `npm test -- --runInBand`.
5. Try the tool on a scratch project and read the result back (sequence, clip or project state) before calling it done.
6. Update `README.md`, `CHANGELOG.md` and the notes in `Kiến thức/` when behaviour or setup changes.

## Conventions

- Studio tools live in `src/tools/studio.ts` (plus `beats.ts`, `cleanup.ts`, `deliverables.ts`) and must be listed in `studioToolNames`.
- Every value interpolated into generated ExtendScript goes through `JSON.stringify`; never build script strings from raw arguments.
- Prefer new sequences over editing the active one, and never delete media: disable, copy or move to the Trash instead.
- Tool descriptions are written for the model: say what the tool changes, what it leaves alone, and how to check the result.
