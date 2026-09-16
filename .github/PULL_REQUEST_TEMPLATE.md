## What changed

<!-- One paragraph. What a reader of the changelog should learn. -->

## Why

<!-- The problem, the defect, or the behaviour that was missing. Link the issue if there is one. -->

## How it was verified

<!-- Which tests were added or changed, and what you ran by hand. A README command change was run from a clean clone; say which route. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] `NEXT_PUBLIC_DEV_NO_AUTH= pnpm build` passes locally
- [ ] Tests mirror the changed modules (see CONTRIBUTING.md)

## Documentation touched

<!-- Tick what this change updates, or say why nothing needed to. -->

- [ ] `README.md`, English half
- [ ] `README.md`, Chinese half (中文说明), for any section changed above
- [ ] `docs/running/components.md` or `docs/running/interfaces.md`
- [ ] `evaluation/README.md`
- [ ] `.env.example` (a new or changed variable)
- [ ] `CHANGELOG.md`
- [ ] Nothing a reader can see changed

## Boundaries

<!-- Delete the lines that do not apply. -->

- Adds or changes a third-party dependency, model, API or cloud service: update the Disclosures section of the README.
- Changes what a person approves, what is held, or what applies automatically: name the gate and the test that covers it.
- Changes what is stored, redacted, encrypted or deleted: name the table and the reset path.
- Touches `evaluation/results/` or a frozen fixture: this is a new evaluation, not an edit. Say so.
