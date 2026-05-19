# Strict TypeScript Path

Any module placed under `src/lib/strict/` is held to a stricter set of
TypeScript rules than the rest of the codebase. The intent is to **roll out
`strict: true` gradually** — new utilities and any code worth tightening live
here first, and over time we migrate existing modules in.

## What is enabled

Compared to the default `tsconfig.app.json`, this path enables:

- `strict: true` (the umbrella flag)
- `noImplicitAny`
- `strictNullChecks`
- `strictFunctionTypes`
- `strictBindCallApply`
- `strictPropertyInitialization`
- `alwaysStrict`
- `noImplicitOverride`
- `noUncheckedIndexedAccess`

See `tsconfig.strict.json` at the repo root.

## How to use

1. Put the file under `src/lib/strict/<feature>.ts` (or a sub-folder).
2. Author the file as if `strict: true` were globally on.
3. Run `npx tsc -p tsconfig.strict.json --noEmit` to type-check the strict
   subset on demand. The normal `npm run build` only uses
   `tsconfig.app.json`, so strict failures will not yet block CI — but they
   should not be ignored.

## When to migrate code in

Pick targets that have already burned us in production:

- Anything in `src/lib/connectors/` whose return type is currently
  `Record<string, unknown>` or `any`.
- Anything that touches `window.odin` / `window.odinDesktop` IPC payloads.
- Anything that produces `unknown` -> `string` chains.

Move one module at a time. Fix the failures it surfaces. Open a PR per module
so the type-debt clean-up stays reviewable.
