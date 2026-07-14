# Contributing

## Development Setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- Redis (for work-queue tests)
- Docker (for container builds)

### Getting Started

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/kagenti/serverless-harness.git
cd serverless-harness

# Build pi-fork type declarations
cd pi-fork && npm ci && npm run build && cd ..

# Install workspace dependencies
pnpm install

# Run tests
pnpm -r test

# Typecheck
cd harness && pnpm exec tsc --noEmit
```

### Workspace Structure

```
serverless-harness/
├── harness/              # Core harness (@sh/harness)
├── packages/
│   ├── k8s-sandbox/      # K8s sandbox client (@sh/k8s-sandbox)
│   ├── knative-server/   # Knative HTTP server (@sh/knative-server)
│   ├── session-backend/  # Redis session backend (@sh/session-backend)
│   └── work-queue/       # Redis work queue (@sh/work-queue)
├── experiments/          # Performance experiments
├── deploy/knative/       # Deployment scripts and smoke tests
├── pi-fork/              # Submodule: Pi AI framework
└── Dockerfile            # Container build
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes with tests
4. Ensure `pnpm -r test` passes
5. Ensure `tsc --noEmit` passes in all packages with tsconfigs
6. Submit a pull request

### CI Checks

All PRs must pass:
- **Typecheck**: `tsc --noEmit` across harness, k8s-sandbox, knative-server, experiments
- **Tests**: `pnpm -r test` (requires Redis for work-queue)
- **DCO**: All commits must be signed off

## Commit Messages

Use conventional commit format:
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `ci:` CI/CD changes
- `chore:` Maintenance tasks
- `test:` Test additions or fixes

All commits must include DCO sign-off:

```bash
git commit -s -m "feat: Add new feature"
```

## Code of Conduct

This project follows the [Kagenti Code of Conduct](https://github.com/kagenti/kagenti/blob/main/CODE_OF_CONDUCT.md).
