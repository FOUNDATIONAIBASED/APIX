# Code scanning (CodeQL) notes

## “Locations for an alert exceeded limits”

GitHub stores at most **100 related locations per alert** in a SARIF upload. If a single rule matches many times (for example CSRF checks across a very large HTML/JS dashboard), you may see:

> An alert for the rule `js/missing-token-validation` contained 102 related locations … Only 100 were stored …

This is **informational**: the scan still completed; only the **extra related locations** for that alert were truncated in the uploaded results.

Mitigations:

1. **Scope analysis** to backend code (see [`.github/codeql/codeql-config.yml`](../.github/codeql/codeql-config.yml)) so high-volume UI files are not driving huge location lists.
2. **Reduce duplicates** in the codebase (shared fetch helpers, middleware) so fewer distinct locations match.
3. Optionally **exclude** specific queries via `query-filters` in the same config (only if you accept the trade-off).

## What we scan

The workflow uses `source-root: server` and ignores `server/public/**` so CodeQL focuses on the **Node gateway** under `server/src/`. The web console under `server/public/` is mostly static HTML + inline scripts; API security and routing are implemented in `server/src/`.

## CSRF / `js/missing-token-validation`

Cookie-based sessions (`apix_session`) use **double-submit CSRF**: the server sets a readable `apix_csrf` cookie and expects the same value in the `X-CSRF-Token` header on mutating requests. The dashboard (`public/index.html`) and `public/api-test.html` wrap `fetch()` to attach the header when the cookie is present.

That query still flags large inline UIs sometimes; scoping in [`.github/codeql/codeql-config.yml`](../.github/codeql/codeql-config.yml) can limit noise.

## Other mitigations (server)

- **API keys**: stored with **bcrypt** (legacy SHA-256 rows still verify).
- **IMAP rules**: regex patterns are length-bounded and filtered for obvious ReDoS shapes.
- **API key query strings**: not accepted — use headers only.
