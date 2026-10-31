# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue:

- use GitHub's private vulnerability reporting ("Report a vulnerability" under the repository's Security tab), or
- email kienphan.dev@gmail.com.

Include what you found, how to reproduce it and the version or commit. You will get an acknowledgement within a few days. This is a small example project maintained by one person, so there is no bug bounty and no fixed SLA, but confirmed issues are fixed as quickly as practical and credited if you wish.

## What this project is

`agent-guardrails` is an educational reference implementation of runtime guardrails for tool-using agents. It has not been used in production, has not had an external security review and makes no guarantee that it stops a determined attacker. The README lists the threats it addresses and, just as importantly, the ones it does not.

## Security-relevant behaviour

- **Enforcement is in code, not in the prompt.** Tool arguments are validated, policy is evaluated and approvals are checked before a tool runs. The model cannot skip these steps, but it can choose which allowed tools to call and with what valid arguments.
- **Default deny.** A tool call that no policy rule matches is denied. Policy files with unknown keys, duplicate rule ids or an invalid regular expression are rejected at load time.
- **Deny-overrides.** When several rules match, the strictest effect wins, independent of rule order.
- **Approvals are bound to a digest of the exact call.** Each request stores a SHA-256 digest of the run id, call id, tool name and the canonical JSON of the unredacted arguments. A request for an existing id with a different digest replaces the record and discards the old decision; before executing, the runner recomputes the digest and requires both the saved request and the gate's stored record to match it, otherwise the call is denied; a gate that cannot report the digest fails closed. A decision cannot be changed once recorded and an expired request counts as denied. Not guaranteed: an approval for a byte-identical call (same run id, call id, tool, arguments) has no time limit and is honoured again if that exact call recurs; reviewers see redacted arguments while the digest covers the real ones.
- **HTTP approval callbacks are signed, timestamped and single-use.** `HttpCallbackApprovalGate` verifies an HMAC-SHA256 signature (constant-time comparison) over the approval id, the call digest, a timestamp and the raw body; the timestamp must be within a freshness window (default 5 minutes) of the server clock; the digest must equal the stored request's; a request can be decided once, so a replay gets 409 after the decision and 401 after the window. It caps bodies at 16 KiB and requires a secret of at least 16 characters. There is no nonce store (within the window, re-sending a valid decision for a still-pending request repeats the same decision), no rate limiting and no TLS: run the callback server behind TLS.
- **Resume re-checks the checkpoint.** It is schema-validated on load; a different environment than the run's is refused; an agent configured for dry-run never executes a persisted real run; the idempotency key is recomputed. An optional `SignedRunStore` (HMAC-SHA256 with a key kept outside the state directory) detects edited checkpoints; it does not detect a replayed older one. Without it, whoever can write the state directory can alter run state.
- **Persisted state is not encrypted.** Run checkpoints contain the full conversation, including tool results, unredacted, because resuming needs it. Approval files, locks and traces are written with owner-only permissions (0600). Protect the state directory like any other store of customer data. Traces, plans and reviewer views redact secret-looking field names and known secret shapes; checkpoints do not.
- **Locks are advisory.** A run is locked while it executes (exclusive file creation, expiring after 5 minutes without a checkpoint), and approval decisions are serialised per record. This prevents two cooperating processes on one local file system from running or deciding the same thing at once; it does not guard against a stalled process being overtaken, nor against network file systems.
- **Terminal output is escaped.** The timeline, plan and CLI listings replace control characters, ANSI/OSC sequences, bidirectional overrides and line separators with `\uXXXX` escapes, so model- or third-party-chosen text cannot forge rows or recolour the terminal.
- **Failed tool calls are scanned too.** Error messages and details are checked by the injection heuristics, and a failing `untrusted` tool still taints the run.
- **Budgets include retries.** Every backend attempt is charged to the spend budget. `safeExit` tools (policy bypass) must end the run and cannot be destructive or external-send.
- **Prompt-injection heuristics are a tripwire.** They match a handful of common phrasings. A paraphrase, another language or an encoded payload passes. Do not rely on them as a boundary.
- **The OpenAI-compatible adapter** has only been tested against fake transports. It never includes the API key in error messages, requires https (or loopback), refuses redirects, caps response size, validates token counts and estimates cost when `usage` is missing.

## Dependency policy

Direct dependencies are pinned to exact versions, and every package in `package-lock.json` (direct and transitive) was published on or before 2026-10-24, a week or more before it was chosen. The lockfile includes the optional platform packages for every platform. Dependabot is configured with a 7-day cooldown. Packages are installed, tested and built only inside throwaway containers, and installs run with `--ignore-scripts` (CI uses `npm ci --ignore-scripts`), so package install scripts never run. GitHub Actions are pinned by full commit SHA and the workflow token is read-only (`contents: read`, no persisted credentials).

## Open advisories

See the README ("Verification") for the `npm audit` result recorded when this version was prepared.
