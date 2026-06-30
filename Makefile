.PHONY: lint fmt test typecheck

lint:
	pre-commit run --all-files

fmt:
	pnpm exec prettier --write .

test:
	pnpm -r test

typecheck:
	cd harness && pnpm exec tsc --noEmit
	cd packages/k8s-sandbox && pnpm exec tsc --noEmit
	cd packages/knative-server && pnpm exec tsc --noEmit
	cd experiments && pnpm exec tsc --noEmit
