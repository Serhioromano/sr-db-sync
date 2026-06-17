.PHONY: build publish install clean compile compile-all

build:
	bun build ./src/index.ts --outdir ./dist --target bun --minify

compile:
	bun build --compile ./src/index.ts --outfile dist/dbs

compile-all:
	@echo "🔨 Compiling for all platforms..."
	bun build --compile ./src/index.ts --outfile dist/dbs-linux-x64 --target bun-linux-x64
	bun build --compile ./src/index.ts --outfile dist/dbs-linux-arm64 --target bun-linux-arm64
	bun build --compile ./src/index.ts --outfile dist/dbs-darwin-x64 --target bun-darwin-x64
	bun build --compile ./src/index.ts --outfile dist/dbs-darwin-arm64 --target bun-darwin-arm64
	bun build --compile ./src/index.ts --outfile dist/dbs-windows-x64.exe --target bun-windows-x64
	@echo "✅ Binaries in dist/"

install:
	bun install

clean:
	rm -rf dist/

publish: build compile compile-all
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
	@# 7. Поднять версию в package.json (без git-тега — сделаем вручную после CHANGELOG)
	@newver=$$(npm version $(v) --no-git-tag-version 2>&1 | tail -1); \
		echo "🏷️  Version bumped: $$newver"; \
		if grep -q '## \[Unreleased\]' CHANGELOG.md; then \
			echo "📝 Replacing [Unreleased] → [$$newver] in CHANGELOG.md"; \
			sed -i "s/## \[Unreleased\]/## [$$newver]/" CHANGELOG.md; \
		else \
			echo "⚠️  No [Unreleased] section in CHANGELOG.md, skipping replacement"; \
		fi
	@# 8. Закоммитить версию + CHANGELOG и создать тег
	@newver=$$(node -p "require('./package.json').version"); \
		git add package.json package-lock.json CHANGELOG.md; \
		git commit -m "Release $$newver"; \
		git tag "v$$newver"; \
		echo "🔖 Tagged v$$newver"
	@# 9. Добавить свежую секцию [Unreleased] для будущих изменений
	@awk 'NR==1{print; print ""; print "## [Unreleased]"; next} 1' CHANGELOG.md > CHANGELOG.tmp && \
		mv CHANGELOG.tmp CHANGELOG.md && \
		git add CHANGELOG.md && \
		git commit -m "Open [Unreleased] for next cycle" && \
		echo "📝 Opened new [Unreleased] section"
	@# 10. Запушить с тегами
	@git push origin main --follow-tags
	@echo "🚀 Pushed to GitHub"
	@# 11. Опубликовать в npm
	@npm publish
	@echo "📦 Published sr-db-sync to npm"
	@# 12. Создать GitHub Release + прикрепить бинарники
	@tag=$$(git describe --tags --abbrev=0); \
		notes_file=$$(mktemp); \
		awk -v ver="## [$$tag]" 'found && /^## \[/{exit} {print} /^## \[/ && $$0 == ver{found=1}' CHANGELOG.md > "$$notes_file"; \
		BINARIES="dist/dbs-linux-x64 dist/dbs-linux-arm64 dist/dbs-darwin-x64 dist/dbs-darwin-arm64 dist/dbs-windows-x64.exe"; \
		if [ ! -s "$$notes_file" ]; then \
			echo "⚠️  No release notes found in CHANGELOG.md for $$tag, using auto-generated notes"; \
			gh release create "$$tag" --title "$$tag" --generate-notes $$BINARIES; \
		else \
			echo "📝 Release notes extracted ($$(wc -l < "$$notes_file") lines)"; \
			gh release create "$$tag" --title "$$tag" --notes-file "$$notes_file" $$BINARIES; \
		fi; \
		rm -f "$$notes_file"; \
		echo "🎉 GitHub release created: $$tag (+ 5 platform binaries)"
