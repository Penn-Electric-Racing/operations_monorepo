#!/usr/bin/env bash
# Push the caller workflow into every repo that should sync to Notion.
#
#   ORG=your-org REPOS="rust-tools can-bus dti-embedded" ./scripts/rollout.sh
#
# Options:
#   MODE=pr        open a PR instead of committing to the default branch
#   SYNC_REPO=...  owner/name of the repo holding this action (default $ORG/notion-github-sync)
#   REF=v1         tag/branch of the action to pin to
#   DRY_RUN=true   print what would happen, change nothing
#
# Requires: gh (authenticated with repo + workflow scopes)

set -euo pipefail

ORG="${ORG:?set ORG}"
REPOS="${REPOS:?set REPOS to a space-separated list of repo names}"
SYNC_REPO="${SYNC_REPO:-$ORG/notion-github-sync}"
REF="${REF:-main}"
MODE="${MODE:-direct}"
DRY_RUN="${DRY_RUN:-false}"
WF_PATH=".github/workflows/notion-sync.yml"

render() {
  sed -e "s|Penn-Electric-Racing/notion-github-sync@main|${SYNC_REPO}@${REF}|" \
      "$(dirname "$0")/../examples/caller-workflow.yml"
}

BODY="$(render)"

for name in $REPOS; do
  repo="$ORG/$name"
  echo "=== $repo"

  if ! gh api "repos/$repo" >/dev/null 2>&1; then
    echo "  skip: not accessible"
    continue
  fi

  default_branch="$(gh api "repos/$repo" --jq .default_branch)"

  if [ "$DRY_RUN" = "true" ]; then
    echo "  would write $WF_PATH on $default_branch"
    continue
  fi

  # Existing file? Reuse its blob sha so the write is an update, not a conflict.
  sha="$(gh api "repos/$repo/contents/$WF_PATH" --jq .sha 2>/dev/null || true)"

  if [ "$MODE" = "pr" ]; then
    branch="chore/notion-sync"
    base_sha="$(gh api "repos/$repo/git/ref/heads/$default_branch" --jq .object.sha)"
    gh api -X POST "repos/$repo/git/refs" \
      -f ref="refs/heads/$branch" -f sha="$base_sha" >/dev/null 2>&1 || true
    target_branch="$branch"
  else
    target_branch="$default_branch"
  fi

  args=(-X PUT "repos/$repo/contents/$WF_PATH"
        -f message="ci: mirror issues and PRs to Notion"
        -f branch="$target_branch"
        -f content="$(printf '%s' "$BODY" | base64 | tr -d '\n')")
  [ -n "$sha" ] && args+=(-f sha="$sha")

  gh api "${args[@]}" >/dev/null
  echo "  wrote $WF_PATH on $target_branch"

  if [ "$MODE" = "pr" ]; then
    gh pr create --repo "$repo" --head "$branch" --base "$default_branch" \
      --title "Mirror issues and PRs to Notion" \
      --body "Adds the shared \`$SYNC_REPO@$REF\` action. Needs the org-level NOTION_TOKEN secret and NOTION_DATABASE_ID variable scoped to this repo." \
      >/dev/null 2>&1 || echo "  (PR already open)"
  fi
done

echo
echo "Reminder: the workflow only fires once it is on the default branch."
