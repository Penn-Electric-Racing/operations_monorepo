#!/usr/bin/env bash
set -euo pipefail

ORG="${ORG:?set ORG}"
REPOS="${REPOS:?set REPOS to a space-separated list of repo names}"
SYNC_REPO="${SYNC_REPO:-$ORG/operations_monorepo}"
REF="${REF:-main}"
MODE="${MODE:-direct}"
DRY_RUN="${DRY_RUN:-false}"
WF_PATH=".github/workflows/notion-sync.yml"

# Optional. Org secrets don't reach private repos on the Free plan, so set this
# to also seed NOTION_TOKEN as a repo-level secret on every repo in $REPOS.
NOTION_TOKEN="${NOTION_TOKEN:-}"

render() {
  sed -e "s|Penn-Electric-Racing/operations_monorepo/notion-github-sync@main|${SYNC_REPO}/notion-github-sync@${REF}|" \
      "$(dirname "$0")/../examples/caller-workflow.yml"
}

BODY="$(render)"

scopes="$(gh api -i user 2>/dev/null | sed -n 's/^[Xx]-[Oo][Aa]uth-[Ss]copes: *//p' | tr -d ' \r')"
if [ -n "$scopes" ] && [[ ",$scopes," != *,workflow,* ]]; then
  echo "gh token scopes: $scopes" >&2
  echo "Missing the 'workflow' scope, so writes to $WF_PATH will 404." >&2
  echo "Fix: gh auth refresh -h github.com -s workflow" >&2
  exit 1
fi

sync_private="$(gh api "repos/$SYNC_REPO" --jq .private 2>/dev/null || echo true)"

failed=""

for name in $REPOS; do
  repo="$ORG/$name"
  echo "=== $repo"

  if ! meta="$(gh api "repos/$repo" --jq '"\(.default_branch) \(.private)"' 2>/dev/null)"; then
    echo "  skip: not accessible"
    continue
  fi
  default_branch="${meta% *}"
  repo_private="${meta##* }"

  if [ "$sync_private" = "true" ] && [ "$repo_private" = "false" ]; then
    echo "  skip: $repo is public, $SYNC_REPO is private"
    echo "        a public repo cannot resolve an action from a private one"
    continue
  fi

  if [ -n "$NOTION_TOKEN" ]; then
    if [ "$DRY_RUN" = "true" ]; then
      echo "  would set secret NOTION_TOKEN"
    elif ! err="$(gh secret set NOTION_TOKEN --repo "$repo" --body "$NOTION_TOKEN" 2>&1 >/dev/null)"; then
      echo "  FAILED to set secret NOTION_TOKEN" >&2
      printf '%s\n' "$err" | sed 's/^/    /' >&2
      failed="$failed $repo"
    else
      echo "  set secret NOTION_TOKEN"
    fi
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  would write $WF_PATH on $default_branch"
    continue
  fi

  if [ "$MODE" = "pr" ]; then
    branch="chore/notion-sync"
    base_sha="$(gh api "repos/$repo/git/ref/heads/$default_branch" --jq .object.sha)"
    gh api -X POST "repos/$repo/git/refs" \
      -f ref="refs/heads/$branch" -f sha="$base_sha" >/dev/null 2>&1 || true
    target_branch="$branch"
  else
    target_branch="$default_branch"
  fi

  # Look up the blob sha on the branch we're about to write, not the default one.
  # On a 404 `gh api --jq` emits the raw error body instead of applying the
  # filter, so keep the result only when it actually looks like a sha.
  sha="$(gh api "repos/$repo/contents/$WF_PATH?ref=$target_branch" --jq .sha 2>/dev/null || true)"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || sha=""

  args=(-X PUT "repos/$repo/contents/$WF_PATH"
        -f message="ci: mirror issues and PRs to Notion"
        -f branch="$target_branch"
        -f content="$(printf '%s' "$BODY" | base64 | tr -d '\n')")
  [ -n "$sha" ] && args+=(-f sha="$sha")

  if ! err="$(gh api "${args[@]}" 2>&1 >/dev/null)"; then
    echo "  FAILED to write $WF_PATH on $target_branch" >&2
    printf '%s\n' "$err" | sed 's/^/    /' >&2
    case "$err" in
      *"through a pull request"*|*"rule violations"*|*409*)
        echo "    Branch protection: re-run as  MODE=pr $0" >&2 ;;
      *404*)
        echo "    Need push access plus the 'workflow' scope on the token." >&2 ;;
    esac
    failed="$failed $repo"
    continue
  fi
  echo "  wrote $WF_PATH on $target_branch"

  if [ "$MODE" = "pr" ]; then
    gh pr create --repo "$repo" --head "$branch" --base "$default_branch" \
      --title "Mirror issues and PRs to Notion" \
      --body "Adds the shared \`$SYNC_REPO/notion-github-sync@$REF\` action. Needs the org-level NOTION_TOKEN secret and NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID variable to be visible to this repo; see $SYNC_REPO/notion-github-sync#2-add-the-org-credentials." \
      >/dev/null 2>&1 || echo "  (PR already open)"
  fi
done

echo
[ -n "$failed" ] && echo "Failed:$failed" >&2
echo "Reminder: the workflow only fires once it is on the default branch."
