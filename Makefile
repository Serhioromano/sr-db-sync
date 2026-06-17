.PHONY: build publish install clean

build:
	bun build ./src/index.ts --outdir ./dist --target bun --minify

install:
	bun install

clean:
	rm -rf dist/

publish: build
	@# 1. Проверить, что передана версия
	@test -n "$(v)" || { \
		echo "❌ Usage: make publish v=<version>"; \
		echo "   Example: make publish v=patch"; \
		echo "   Valid: major, minor, patch, premajor, preminor, prepatch, prerelease"; \
		exit 1; \
	}
	@# 2. Проверить GitHub CLI
	@command -v gh >/dev/null 2>&1 || { \
		echo "❌ GitHub CLI (gh) not found. Install: https://cli.github.com/"; \
		exit 1; \
	}
	@# 3. Проверить авторизацию в GitHub
	@gh auth status >/dev/null 2>&1 || { \
		echo "❌ Not logged in to GitHub. Run: gh auth login"; \
		exit 1; \
	}
	@# 4. Проверить авторизацию в npm
	@npm ping >/dev/null 2>&1 || { \
		echo "❌ Not logged in to npm."; \
		echo "   Create a token at https://www.npmjs.com/settings/<your-username>/tokens"; \
		echo "   Then run: npm config set //registry.npmjs.org/:_authToken <token>"; \
		exit 1; \
	}
	@# 5. Закоммитить незакоммиченные изменения
	@if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then \
		echo "📦 Uncommitted changes found. Committing..."; \
		git add -A; \
		git commit -m "Prepare for new version $(v)"; \
	fi
	@# 6. Синхронизация с remote
	@git pull --rebase origin main
	@# 7. Поднять версию в package.json
	@newver=$$(npm version $(v) 2>&1 | tail -1); \
		echo "🏷️  Version bumped: $$newver"
	@# 8. Запушить с тегами
	@git push origin main --follow-tags
	@echo "🚀 Pushed to GitHub"
	@# 9. Опубликовать в npm
	@npm publish
	@echo "📦 Published db-sync to npm"
	@# 10. Создать GitHub Release из CHANGELOG.md
	@tag=$$(git describe --tags --abbrev=0); \
		notes_file=$$(mktemp); \
		awk -v ver="## [$$tag]" 'found && /^## \[/{exit} {print} /^## \[/ && $$0 == ver{found=1}' CHANGELOG.md > "$$notes_file"; \
		if [ ! -s "$$notes_file" ]; then \
			echo "⚠️  No release notes found in CHANGELOG.md for $$tag, using auto-generated notes"; \
			gh release create "$$tag" --title "$$tag" --generate-notes; \
		else \
			echo "📝 Release notes extracted ($$(wc -l < "$$notes_file") lines)"; \
			gh release create "$$tag" --title "$$tag" --notes-file "$$notes_file"; \
		fi; \
		rm -f "$$notes_file"; \
		echo "🎉 GitHub release created: $$tag"
