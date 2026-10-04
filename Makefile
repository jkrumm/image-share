# Repo contract entry points (dotfiles docs/agent-platform.md §Repo contract).
# Thin wrappers only: every command below already exists in package.json, the CI
# workflow, or the homelab repo — no new behaviour.

.DEFAULT_GOAL := help

help: ## List the available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-8s\033[0m %s\n", $$1, $$2}'

check: ## Run the local validation CI runs (lint, format check, typecheck, tests)
	bun run check

deploy: ## Deploy to production via the homelab image-share-deploy target
	$(MAKE) -C ../homelab image-share-deploy

verify: ## Probe the live production health endpoint (exit 0 = healthy)
	curl -fsS https://share.jkrumm.com/health

logs: ## Show the last 200 lines of the production container log, then exit
	ssh homelab 'docker logs --tail 200 image-share'

.PHONY: help check deploy verify logs
