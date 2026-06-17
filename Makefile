.PHONY: build publish install clean

build:
	bun build ./src/index.ts --outdir ./dist --target bun --minify

install:
	bun install

clean:
	rm -rf dist/

publish: build
	@# 1. Check version argument
	@test -n "$(v)" || { \
		echo "❌ Usage: make publish v=<version>"; \
		echo "   Example: make publish v=patch"; \
		echo "   Valid: major, minor, patch, premajor, preminor, prepatch, prerelease"; \
		exit 1; \
	}
	@# 2. Check GitHub CLI
	@command -v gh >/dev/null 2>&1 || { \
		echo "❌ GitHub CLI (gh) not found. Install: https://cli.github.com/"; \
		exit 1; \
	}
	@# 3. Check GitHub auth
	@gh auth status >/dev/null 2>&1 || { \
		echo "❌ Not logged in to GitHub. Run: gh auth login"; \
		exit 1; \
	}
	@# 4. Check npm auth
	@npm ping >/dev/null 2>&1 || { \
		echo "❌ Not logged in to npm."; \
		echo "   Create a token at https://www.npmjs.com/settings/<your-username>/tokens"; \
		echo "   Then run: npm config set //registry.npmjs.org/:_authToken <token>"; \
		exit 1; \
	}
	@# 5. Auto-commit uncommitted changes
	@if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then \
		echo "📦 Uncommitted changes found. Committing..."; \
		git add -A; \
		git commit -m "chore: prepare for publish"; \
	fi
	@# 6. Sync with remote
	@git pull --rebase origin main
	@# 7. Replace [Unreleased] → [vNEXT_VER] in CHANGELOG
	@NEXT_VER=$$(npm version $(v) --dry-run 2>&1 | tail -1 | sed 's/^v//'); \
		if grep -q '## \[Unreleased\]' CHANGELOG.md; then \
			echo "📝 Replacing [Unreleased] → [v$$NEXT_VER] in CHANGELOG.md"; \
			sed -i "s/## \[Unreleased\]/## [v$$NEXT_VER]/" CHANGELOG.md; \
		else \
			echo "⚠️  No [Unreleased] section in CHANGELOG.md, skipping"; \
		fi
	@# 8. Bump version + commit everything + tag
	@npm version $(v) --no-git-tag-version > /dev/null 2>&1; \
		NEW_VER=$$(node -p "require('./package.json').version"); \
		echo "🏷️  package.json → $$NEW_VER"; \
		git add package.json bun.lock CHANGELOG.md; \
		if ! git diff --cached --quiet --exit-code; then \
			git commit -m "Release v$$NEW_VER"; \
		fi; \
		git tag -f "v$$NEW_VER" > /dev/null 2>&1 || git tag "v$$NEW_VER"; \
		echo "🔖 Tagged v$$NEW_VER"
	@# 9. Open new [Unreleased] section
	@awk 'NR==1{print; print ""; print "## [Unreleased]"; next} 1' CHANGELOG.md > CHANGELOG.tmp && \
		mv CHANGELOG.tmp CHANGELOG.md && \
		git add CHANGELOG.md && \
		git commit --allow-empty -m "Open [Unreleased] for next cycle" && \
		echo "📝 Opened new [Unreleased] section"
	@# 10. Push with tags
	@git push origin main --tags
	@echo "🚀 Pushed to GitHub"
	@# 11. Publish to npm
	@npm publish && echo "📦 Published sr-db-sync to npm"
	@# 12. Create GitHub Release from CHANGELOG
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
