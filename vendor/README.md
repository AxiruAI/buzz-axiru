# vendor/

This directory holds a vendored snapshot of `@axiru/agent-spend-guardrails`
(with its internal type and decision-engine modules inlined) so that
`buzz-axiru` builds and tests offline, without the npm registry.

Two changes were made to the snapshot, and only these:

1. Internal package imports were rewritten to relative paths so the
   package is fully self-contained (`src/types/`, `src/engine/`).
2. Package-name references in comments were updated to match.

No evaluation logic was touched. The evaluator is deterministic and
dependency-free (Node's `node:crypto` only), so the snapshot behaves
bit-for-bit like the published package.

## Swapping to the published package at release

One line in the root `package.json`:

```diff
-    "@axiru/agent-spend-guardrails": "file:vendor/agent-spend-guardrails"
+    "@axiru/agent-spend-guardrails": "^0.1.0"
```

Then `rm -rf vendor/`, drop the first `tsc` invocation from the `build`
script, and run `npm install`. Nothing else changes: all bridge code
imports the package by name.

Do not edit files under `vendor/` by hand; fix things upstream and
re-snapshot.
