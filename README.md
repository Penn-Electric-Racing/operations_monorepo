# notion-github-sync

Mirrors GitHub issues and pull requests from every Penn Electric Racing repo
into the single Notion database behind our project board. This repo holds the
sync code; each mirrored repo adds one ~20-line workflow that calls it.

The GitHub URL is the primary key, so re-running is always safe — an item that
already exists is updated in place rather than duplicated.

No dependencies, plain Node 20 `fetch`. The Notion database and its properties
already exist; all you supply is the token and the database ID.

---

## Contents

1. [Get the token and database ID](#1-get-the-token-and-database-id)
2. [Add the org credentials](#2-add-the-org-credentials)
3. [Install into each repository](#3-install-into-each-repository)
4. [Verify an install](#4-verify-an-install)
5. [Backfill existing issues and PRs](#5-backfill-existing-issues-and-prs)
6. [What triggers from where](#6-what-triggers-from-where)
7. [Field mapping](#field-mapping)
8. [Troubleshooting](#troubleshooting)
9. [Known limits](#known-limits)

---

## 1. Get the token and database ID

**Token.** Open <https://www.notion.so/my-integrations>, pick the integration
already connected to the board, and copy its internal secret (`ntn_...`). If
you're creating a new one instead, open the board's database → `...` →
**Connections** → add it. Without that connection every call returns 404, even
with a valid token.

**Database ID.** Open the board as a full page and take the 32-hex chunk from
the **database** URL — not the page URL of an individual card:

```
https://www.notion.so/Penn-Electric-Racing/1f2e3d4c5b6a7890abcdef1234567890?v=...
                                           ^------------ this ------------^
```

Dashes are fine; the script strips them.

---

## 2. Add the org credentials

Set once for the org, scoped to the repos being mirrored:

```bash
gh secret set NOTION_TOKEN --org Penn-Electric-Racing --visibility selected \
  --repos Penn-Electric-Racing,car-data-server,PER-Data-Analyzer,SuboptimumG

gh variable set NOTION_DATABASE_ID --org Penn-Electric-Racing --visibility selected \
  --repos Penn-Electric-Racing,car-data-server,PER-Data-Analyzer,SuboptimumG \
  --body "your32hexdatabaseid"
```

Adding a repo later means re-running both commands with it appended to
`--repos` — the selected list is replaced, not merged.

If this repo is private, enable **Settings → Actions → General → Access →
Accessible from repositories in the organization**, or the other repos get
`repository not found` on the `uses:` line.

---

## 3. Install into each repository

### In bulk

```bash
export ORG=Penn-Electric-Racing
export REPOS="Penn-Electric-Racing car-data-server PER-Data-Analyzer SuboptimumG"

DRY_RUN=true ./scripts/rollout.sh   # preview
./scripts/rollout.sh                # for real
```

Needs `gh` authenticated with `repo` and `workflow` scopes. Repos that already
have the file are updated rather than erroring. Use `MODE=pr` to open PRs
instead of committing to the default branch, for repos with branch protection.
`REF=v1` pins callers to a tag instead of `main`.

### By hand

Copy `examples/caller-workflow.yml` into the target repo at
`.github/workflows/notion-sync.yml` and commit it to the default branch. It
already points at `Penn-Electric-Racing/notion-github-sync@main`; nothing else
needs editing.

### For new repos going forward

- **Starter workflow** — put the file in `workflow-templates/` of the org's
  `.github` repo with a small `.properties.json` beside it, and it shows up as a
  suggested workflow in every new repo.
- **Repository ruleset** (Enterprise Cloud) — Organization settings → Rulesets →
  require the workflow. Enforces rather than suggests, and applies retroactively
  to repos matching a name pattern.

---

## 4. Verify an install

```bash
node scripts/test.mjs   # mapping self-check, no network, no credentials

gh issue create --repo Penn-Electric-Racing/car-data-server \
  --title "Notion sync smoke test" --label enhancement
gh run list --repo Penn-Electric-Racing/car-data-server --workflow notion-sync.yml --limit 1
gh run view --repo Penn-Electric-Racing/car-data-server --log
```

The log prints `Created https://notion.so/...` plus a `Skipped properties:`
line. Read that skip line on the first run — it names exactly which board
columns didn't match.

---

## 5. Backfill existing issues and PRs

Run once, from this repo, to import everything that predates the workflow:

```bash
export NOTION_TOKEN=ntn_... NOTION_DATABASE_ID=...
export GITHUB_TOKEN="$(gh auth token)"
export REPOS="Penn-Electric-Racing/Penn-Electric-Racing,Penn-Electric-Racing/car-data-server,Penn-Electric-Racing/PER-Data-Analyzer,Penn-Electric-Racing/SuboptimumG"

DRY_RUN=true node scripts/backfill.mjs   # preview
node scripts/backfill.mjs                # for real
```

Note the fully-qualified `owner/repo` here, unlike `rollout.sh`.
`BACKFILL_STATE=open` limits it to open items. The script paces itself at ~3
requests/second to stay inside Notion's rate limit, so a few thousand items
takes a while. After it finishes, the webhooks take over.

---

## 6. What triggers from where

This asymmetry only matters while you're installing:

| Event | Workflow file is read from | Consequence |
|---|---|---|
| `pull_request` | the **PR's head branch** | The PR that adds this workflow will run it, and create a card for itself. |
| `issues` | the **default branch** | Issue syncing does nothing until the workflow is merged to main. |

Once installed, normal usage is unaffected. PRs sync the moment they open — an
unmerged PR sitting in review appears on the board as `In progress`, which is
the point. Only `merged` moves it to `Done`.

---

## Field mapping

| Notion property | Source | Notes |
|---|---|---|
| *title* | `{repo}#{number} <title>` | Title property is auto-detected by type, whatever it's called. Prefix configurable via `title-prefix`. |
| GitHub URL | `html_url` | The dedupe key. Works as `url` or `rich_text`. |
| Issue Number | `number` | |
| Repo | `owner/name` | Issue numbers collide across repos — `car-data-server#42` and `SuboptimumG#42` are different things. |
| Status | derived | See below. |
| Priority | label matching `P0`–`P4` | Case-insensitive, uppercased. Cleared when the label is removed. |
| Tags | labels via `config/label-map.json` | Priority labels excluded. Cleared when labels are removed. |
| Owner | assignees, falling back to author | Only logins present in `config/user-map.json`. |
| Contributors | author + assignees + requested reviewers | Same mapping requirement. |
| Due | milestone `due_on` | Date only. Cleared when the milestone is removed. |

`Created` is Notion's built-in created-time property and isn't writable, so the
GitHub creation timestamp is deliberately not synced to it.

Status transitions:

| Situation | Status written |
|---|---|
| New issue | `Not started` |
| Open issue, already in Notion | *untouched* — someone may have moved it by hand |
| PR open | `In progress` (`Not started` while draft) |
| PR merged, or issue closed | `Done` |
| PR closed unmerged | `Not started` (override with `STATUS_PR_CLOSED_UNMERGED`) |

Set `respect-manual-status: "false"` if you'd rather GitHub always win. Status is
the only property that defers to manual edits — Priority, Tags and Due are mirrored
from GitHub, so editing them in Notion is overwritten on the next event.

### Mapping GitHub people to the People columns

`config/user-map.json` maps GitHub login → Notion user UUID. List the UUIDs:

```bash
curl -s https://api.notion.com/v1/users \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" | jq '.results[] | {name, id}'
```

Add a line per member and commit it here — every mirrored repo picks it up on
the next event. Unmapped logins are dropped silently, so a new contributor
never breaks a sync; they just don't appear in Owner or Contributors.

`config/label-map.json` works the same way for GitHub label → Notion tag.

### Property names

Every property name is configurable, so nothing in Notion has to be renamed.
Either set `PROP_*` env vars, or pass them through the action:

```yaml
- uses: Penn-Electric-Racing/notion-github-sync@main
  with:
    notion-token: ${{ secrets.NOTION_TOKEN }}
    notion-database-id: ${{ vars.NOTION_DATABASE_ID }}
    property-overrides: '{"PROP_URL":"Link","PROP_REPO":"Repository"}'
```

Recognized keys: `PROP_URL`, `PROP_NUMBER`, `PROP_STATUS`, `PROP_PRIORITY`,
`PROP_TAGS`, `PROP_OWNER`, `PROP_CONTRIBUTORS`, `PROP_DUE`, `PROP_REPO`, and
`STATUS_NOT_STARTED`, `STATUS_IN_PROGRESS`, `STATUS_DONE`,
`STATUS_PR_CLOSED_UNMERGED`. Other keys are rejected.

Anything that doesn't exist on the database, or whose type the mapper can't
write, is skipped with a warning rather than failing the run. That tolerance is
what keeps the sync alive as the board schema drifts.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404 object_not_found` from Notion | Integration isn't connected to the database (section 1). |
| `Could not find database with ID` | You used a page ID, not the database ID. |
| `repository not found` on the `uses:` line | Private action repo without org-wide Actions access enabled. |
| `NOTION_DATABASE_ID is not set` | The repo isn't in the variable's selected list (section 2). |
| Workflow never runs on new issues | The file isn't on the default branch yet (section 6). |
| Nothing runs on a fork's PR | By design — fork PRs get no secrets. |
| Status never changes | That `status` option doesn't exist on the board; the API can't create status options, only `select` ones. |
| Owner/Contributors stay empty | GitHub logins missing from `config/user-map.json`. |
| Duplicate cards appear | The `GitHub URL` property was renamed or removed, so dedupe can't find matches. |
| `429` in the log | Notion rate limit; the client backs off and retries automatically. |

---

## Known limits

- **Fork PRs.** Runs from a fork have no access to secrets. The caller workflow
  skips them by design. `pull_request_target` would fix it but exposes the
  Notion token to untrusted code — don't.
- **Direction.** One-way, GitHub → Notion. Closing a card in Notion does not
  close the issue; that would need Notion webhooks.
- **Races.** Two events landing within a second on the same item could both see
  "no existing page" and create duplicates. The `concurrency` group in the
  caller workflow serializes per issue/PR number to prevent this.
- **API version.** Pinned to `2022-06-28`, where pages parent directly to a
  `database_id`. On `2025-09-03` and later, databases gain data sources:
  `parent` becomes `{data_source_id}` and queries hit
  `/data_sources/{id}/query`. Those three call sites are isolated in
  `scripts/lib/notion.mjs`.
- **Rate limit.** Notion allows roughly 3 requests/second. Each webhook uses 3
  calls, fine for normal traffic; a mass label edit across a big repo can trip
  it.
