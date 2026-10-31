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
- **Approvals are bound to one call.** An approval id is derived from the run and the tool call; a decision for one call cannot authorise another, a decision cannot be changed once recorded, and an expired request counts as denied.
- **HTTP approval callbacks are signed.** `HttpCallbackApprovalGate` verifies an HMAC-SHA256 signature (constant-time comparison) over the approval id and the raw body, caps the body at 16 KiB and requires a secret of at least 16 characters. There is no replay window beyond "a request can be decided once". Run the callback server behind TLS; the library does not terminate TLS.
- **Persisted state is not encrypted.** Run checkpoints contain the full conversation, including tool results, unredacted, because resuming needs it. Approval files and traces are written with owner-only permissions (0600). Protect the state directory like any other store of customer data. Traces redact configured secret fields and patterns; checkpoints do not.
- **Prompt-injection heuristics are a tripwire.** They match a handful of common phrasings. A paraphrase, another language or an encoded payload passes. Do not rely on them as a boundary.
- **The OpenAI-compatible adapter** has only been tested against fake transports. It never includes the API key in error messages.

## Dependency policy

Direct dependencies are pinned to exact versions, and every package in `package-lock.json` (direct and transitive) was published on or before 2026-10-24, a week or more before it was chosen. The lockfile includes the optional platform packages for every platform. Dependabot is configured with a 7-day cooldown. Packages are installed, tested and built only inside throwaway containers, and installs run with `--ignore-scripts` (CI uses `npm ci --ignore-scripts`), so package install scripts never run. GitHub Actions are pinned by full commit SHA and the workflow token is read-only (`contents: read`, no persisted credentials).

## Open advisories

See the README ("Verification") for the `npm audit` result recorded when this version was prepared.
