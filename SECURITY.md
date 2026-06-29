# Security Policy

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue,
please report it responsibly.

### How to Report

1. **Do NOT create public GitHub issues** for security vulnerabilities
2. **GitHub Security Advisories (preferred)**: Report vulnerabilities privately via
   [GitHub Security Advisories](../../security/advisories/new)
3. **Email**: Send reports to **security@kagenti.io**
4. **Include**: A clear description of the vulnerability, steps to reproduce,
   affected versions, and potential impact

### Security Contacts

- **kagenti-maintainers@googlegroups.com**
- **security@kagenti.io**

### What to Expect

- **Acknowledgement**: within 48 hours of receipt
- **Initial assessment**: within 7 business days
- **Resolution timeline**: critical vulnerabilities within 30 days, others within 90 days
- **Credit**: We will credit you in the security advisory (if desired)
- **Updates**: We will keep you informed of our progress throughout the process

### Disclosure Policy

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
Please allow us reasonable time to address the vulnerability before any public
disclosure. We aim to publish fixes and advisories within 90 days of the initial report.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| main    | :white_check_mark: |

Only the latest release and the `main` branch receive security updates.

## Security Measures

This project implements several security controls:

- **CI/CD Security**: GitHub Actions CI with typecheck and test gating
- **Dependency Scanning**: `pnpm audit` for vulnerability detection
- **Container Security**: Multi-stage Docker builds with Alpine base images
- **Runtime Security**: Non-root containers, read-only rootfs, dropped capabilities
  in Kubernetes deployments
