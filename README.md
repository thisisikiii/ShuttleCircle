# Blueprint Guide: ShuttleCircle

## Reading order for AI agents

1. Read `DECISIONS.md`. DEC-001 to DEC-005 are the owner's answers; do not change them without clarification. DEC-006 onward are proposed defaults from the design review; build against them unless the owner overrules one.
2. Read `PRD.md` for product goals and scope, then `FEATURES.md` for behavior, the join request state machine and acceptance criteria.
3. Read `ARCHITECTURE.md`, `DATABASE.md`, `API.md` and `DESIGN.md` before implementing related features.
4. Work through `TASKS.md` in dependency order. Verify each acceptance check and record unfinished work.

## Conflict resolution

- Explicit owner answers in `DECISIONS.md` have the highest priority. Option descriptions provide context; examples are not automatically final decisions.
- `TBD` means a decision is missing. Do not silently turn it into a final value or behavior.
- Use `API.md` for endpoint contracts, `DATABASE.md` for data structures, `FEATURES.md` §2 for request states, and `ARCHITECTURE.md` for runtime, security and deployment. If any conflicts with an explicit owner answer, pause the affected work and request clarification.
- Owner inputs still missing are listed at the end of `DECISIONS.md`; each blocks only the feature named there.

## Available files

- [DECISIONS.md](DECISIONS.md)
- [PRD.md](PRD.md)
- [FEATURES.md](FEATURES.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DATABASE.md](DATABASE.md)
- [API.md](API.md)
- [DESIGN.md](DESIGN.md)
- [TASKS.md](TASKS.md)

There is no `REQUIREMENTS.md`, `USER_FLOW.md`, `API_SPEC.md` or `DATA_MODEL.md`; their content lives in `FEATURES.md`, `API.md` and `DATABASE.md`.
