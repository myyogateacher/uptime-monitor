# Security Policy

## Supported Versions

Security updates are provided for the latest version on the default branch.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately.

- Email: `pankaj@myyogateacher.com`
- Subject: `Uptime Monitor Security Report`
- Include:
  - Description of the issue
  - Reproduction steps
  - Potential impact
  - Any proof-of-concept details

Please do **not** open public GitHub issues for security reports.

## Response Process

- Initial acknowledgement: within 72 hours
- Triage and severity assessment: as soon as possible after acknowledgement
- Fix and coordinated disclosure timeline: shared after triage

## Scope

This policy covers:

- Backend API (`/api/*`)
- Authentication/session handling
- Monitor execution paths (HTTP, MySQL, Redis, NATS, TCP)
- Frontend control plane and status pages
- Deployment artifacts in this repository (Dockerfile, compose, config examples)

## Security Best Practices for Operators

- Use a strong `SESSION_SECRET`
- Keep `NODE_ENV=production` in production
- Set `TRUST_PROXY=true` behind reverse proxies
- Restrict `CONTROL_PLANE_EDITOR_EMAILS` to authorized emails
- Rotate credentials and tokens regularly
