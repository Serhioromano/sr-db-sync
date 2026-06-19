.PHONY: install clean publish

install:
	bun install

clean:
	rm -rf dist/

publish:
	@# ── 1. Check version argument ──────────────────────────────────────────
	@test -n "$(v)" || { \
		echo "❌ Usage: make publish v=<version>"; \
		echo "   Example: make publish v=patch"; \
		echo "   Valid: major, minor, patch"; \
		exit 1; \
	}
	@# ── 2. Check GitHub CLI ────────────────────────────────────────────────
	@command -v gh >/dev/null 2>&1 || { \
		echo "❌ GitHub CLI (gh) not found. Install: https://cli.github.com/"; \
		exit 1; \
	}
	@# ── 3. Check GitHub auth (offer login) ─────────────────────────────────
	@while ! gh auth status >/dev/null 2>&1; do \
		echo "🔐 Not logged in to GitHub."; \
		echo -n "   Login now? [Y/n] "; \
		read -r answer; \
		case "$$answer" in \
			[Nn]*) echo "❌ GitHub login required. Aborting."; exit 1 ;; \
			*)      echo "   Running: gh auth login"; gh auth login ;; \
		esac; \
	done
	@echo "✅ GitHub: authenticated"
	@# ── 4. Check bun auth (offer login) ────────────────────────────────────
	@while ! bun whoami >/dev/null 2>&1; do \
		echo "🔐 Not logged in to bun/npm registry."; \
		echo -n "   Login now? [Y/n] "; \
		read -r answer; \
		case "$$answer" in \
			[Nn]*) echo "❌ Registry login required. Aborting."; exit 1 ;; \
			*)      echo "   Running: bunx npm login"; bunx npm login ;; \
		esac; \
	done
	@echo "✅ Registry: authenticated"
	@# ── 5–8. Calculate version, update CHANGELOG, bump, commit, sync ───────
	@CUR=$$(node -p "require('./package.json').version"); \
		MAJ=$$(echo $$CUR | cut -d. -f1); \
		MIN=$$(echo $$CUR | cut -d. -f2); \
		PAT=$$(echo $$CUR | cut -d. -f3); \
		case "$(v)" in \
			major)  NEW=$$((MAJ+1)).0.0 ;; \
			minor)  NEW=$$MAJ.$$((MIN+1)).0 ;; \
			patch)  NEW=$$MAJ.$$MIN.$$((PAT+1)) ;; \
			*) echo "❌ Unknown version type: $(v)"; exit 1 ;; \
		esac; \
		echo "🏷️  Version: $$CUR → $$NEW"; \
		NEW="$$NEW" node -e " \
			const fs=require('fs'); \
			const L=fs.readFileSync('CHANGELOG.md','utf8').split('\n'); \
			const v=process.env.NEW; \
			let u=-1,n=-1,c=false; \
			for(let i=0;i<L.length;i++){ \
				if(L[i]==='## [Unreleased]')u=i; \
				else if(u>=0&&/^## \[v\d/.test(L[i])){n=i;break} \
				else if(u>=0&&n<0&&L[i].trim())c=true \
			} \
			if(u>=0){ \
				if(c){L[u]='## [v'+v+']'} \
				else{ \
					L.splice(u,1); \
					if(L[u]&&!L[u].trim())L.splice(u,1); \
					for(let i=0;i<L.length;i++){if(/^## \[v\d/.test(L[i])){L[i]='## [v'+v+']';break}} \
				} \
				fs.writeFileSync('CHANGELOG.md',L.join('\n')); \
				console.log('📝 CHANGELOG updated'); \
			}else{console.log('⚠️  No [Unreleased] section found, skipping')} \
		"; \
		node -e "const p=require('./package.json');p.version='$$NEW';require('fs').writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"; \
		echo "✅ package.json → $$NEW"; \
		git add -A; \
		if ! git diff --cached --quiet --exit-code; then \
			git commit -m "Release v$$NEW"; \
		fi; \
		git tag -f "v$$NEW" > /dev/null 2>&1 || git tag "v$$NEW"; \
		echo "🔖 Tagged v$$NEW"; \
		git pull --rebase origin main; \
		git push origin main --tags; \
		echo "🚀 Pushed to GitHub"
	@# ── 9. Publish to bun ──────────────────────────────────────────────────
	@bun publish --access public && echo "📦 Published sr-db-sync to bun registry"
	@# ── 10. Create GitHub Release from CHANGELOG ────────────────────────────
	@tag=$$(git describe --tags --abbrev=0); \
		notes_file=$$(mktemp); \
		awk -v ver="## [$$tag]" '$$0 == ver {found=1} found {print} found && $$0 != ver && /^## \[/ {exit}' CHANGELOG.md > "$$notes_file"; \
		if [ ! -s "$$notes_file" ]; then \
			echo "⚠️  No release notes found, using auto-generated notes"; \
			gh release create "$$tag" --title "$$tag" --generate-notes; \
		else \
			echo "📝 Release notes extracted ($$(wc -l < "$$notes_file") lines)"; \
			gh release create "$$tag" --title "$$tag" --notes-file "$$notes_file"; \
		fi; \
		rm -f "$$notes_file"; \
		echo "🎉 GitHub release created: $$tag"
	@# ── 11. Open [Unreleased] for next cycle ───────────────────────────────
	@awk 'NR==1{print; print ""; print "## [Unreleased]"; next} 1' CHANGELOG.md > CHANGELOG.tmp && \
		mv CHANGELOG.tmp CHANGELOG.md && \
		git add CHANGELOG.md && \
		git commit -m "Open [Unreleased] for next cycle" && \
		git push origin main && \
		echo "📝 Opened new [Unreleased] section"
