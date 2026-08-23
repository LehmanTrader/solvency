# Security policy

## Reporting a vulnerability

Please report security issues privately to `hello@solvency.dev`. Include the affected URL or file, reproduction steps, impact, and any suggested remediation.

Do not open a public issue for an unpatched vulnerability. You can expect an acknowledgement within 72 hours and a status update after the report has been reproduced and triaged.

The public pricing and benchmark data is not confidential. Clerk publishable keys and Cloudflare Web Analytics beacon tokens are also public by design. Credentials such as Clerk secret keys, Cloudflare API tokens, Stripe secret keys, and webhook secrets must never be committed or sent in a public report.

## Supported version

Security fixes target the live site and the `main` branch.
