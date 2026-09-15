# notion-github-sync

Mirrors GitHub issues and pull requests from every Penn Electric Racing repo
into the single Notion database behind our project board. This directory of
`operations_monorepo` holds the sync code; each mirrored repo adds one
~20-line workflow that calls it.

All commands below are run from this directory.

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

The **database ID is baked into the action** as the default for
`notion-software-project-board-database-id` (`action.yml`). It is an identifier,
not a credential — it grants nothing without the token — so it needs no secret,
no variable, and nothing to configure per repo. Point a repo at another board by
passing that input explicitly (section "Property names").

That leaves one credential, the token:

```bash
gh secret set NOTION_TOKEN --org Penn-Electric-Racing --visibility all
```

With no `--body` it prompts for the value on stdin, which keeps the token out of
your shell history. `--visibility all` means every repo — current and future —
can read it, so onboarding a new repo is just dropping in the workflow
(section 3); there is nothing to re-run here.

This needs **org owner** privileges — a plain member gets `403 You must be an org
admin`, and `gh auth refresh -s admin:org` does not help (the scope widens what
the token may do, not what the account may do). If you aren't an owner, ask one.

Worth knowing about `--visibility all`: an org secret is readable by any workflow
in any org repo, so anyone who can merge a workflow anywhere in the org can read
the Notion token.

### If the org is on GitHub Free

Org secrets do not reach **private** repos while the org is on GitHub Free —
there, `--visibility all` effectively means "all public repositories". A private
repo sees `secrets.NOTION_TOKEN` as an empty string.

The REST API is **not** a reliable check: `gh api
repos/<org>/<repo>/actions/organization-secrets` still lists the secret, because
that endpoint reports the configured visibility, not the plan gate applied at run
time. The reliable signal is the run log — open the failing job's
`Run .../notion-github-sync@main` group and read the `with:` block. GitHub omits
inputs whose value is an empty string, so on a broken run `notion-token` is
missing from the list while the defaults (`notion-version`, `user-map`, ...) are
all present.

Confirm the plan with `gh api orgs/Penn-Electric-Racing --jq .plan.name`. The fix
is a repo-level secret, which has no visibility setting and no plan gate:

```bash
gh secret set NOTION_TOKEN --repo Penn-Electric-Racing/car-data-server
```

`rollout.sh` does this across `$REPOS` when you give it the value:

```bash
export ORG=Penn-Electric-Racing
export REPOS="car-data-server telemetry ..."
read -rs NOTION_TOKEN && export NOTION_TOKEN   # keeps it out of shell history

./scripts/rollout.sh
```

`NOTION_TOKEN` is optional: leave it unset and `rollout.sh` only writes the
workflow, as before. Unlike the org-wide command this needs re-running for each
new repo.

---

## 3. Install into each repository

### In bulk

```bash
export ORG=Penn-Electric-Racing
export REPOS="operations_monorepo car-data-server SuboptimumG"

DRY_RUN=true ./scripts/rollout.sh   # preview
./scripts/rollout.sh                # for real
```

Needs `gh` authenticated with `repo` and `workflow` scopes; the script checks
the token up front and refuses to start without them.

**Public repos are excluded on purpose.** `operations_monorepo` is private, and
a workflow in a public repo cannot resolve an action from a private one — the
run fails at *Set up job* with `Unable to resolve action ..., not found`, before
any of your code executes. `rollout.sh` detects this and skips those repos with
a message rather than opening a PR that is guaranteed to fail. That is why
`PER-Data-Analyzer` is absent from the list above. To mirror it, either move
`notion-github-sync/` into its own public repo or make `operations_monorepo`
public, then add it back.

| Variable | Default | Effect |
|---|---|---|
| `ORG` | *required* | Org that owns the target repos. |
| `REPOS` | *required* | Space-separated repo **names**, not `owner/repo`. |
| `MODE` | `direct` | `pr` writes to a `chore/notion-sync` branch and opens a PR — use this for repos with branch protection, and it is harmless on repos without it. |
| `SYNC_REPO` | `$ORG/operations_monorepo` | Owner/name of the repo holding this action. |
| `REF` | `main` | Tag or branch of the action to pin callers to, e.g. `REF=v1`. |
| `DRY_RUN` | `false` | `true` prints what would happen and changes nothing. |

How it behaves:

- A repo that already has the file is **updated**, not errored — the script
  reuses the existing blob sha so the write is an update rather than a conflict.
- A repo that fails (permissions, branch protection) prints the underlying
  error and the script moves on to the next one. Every failure is repeated in a
  `Failed: ...` line at the end, so one bad repo can't hide the rest.
- Under `MODE=pr`, a `chore/notion-sync` branch that already exists is reused
  and an already-open PR is left alone, so re-running is safe.

### By hand

Copy `examples/caller-workflow.yml` into the target repo at
`.github/workflows/notion-sync.yml` and commit it to the default branch. It
already points at `Penn-Electric-Racing/operations_monorepo/notion-github-sync@main`; nothing else
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
export NOTION_TOKEN=ntn_... NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID=...
export GITHUB_TOKEN="$(gh auth token)"
export REPOS="Penn-Electric-Racing/operations_monorepo,Penn-Electric-Racing/car-data-server,Penn-Electric-Racing/SuboptimumG"

DRY_RUN=true node scripts/backfill.mjs   # preview
node scripts/backfill.mjs                # for real
```

Note the fully-qualified `owner/repo` here, unlike `rollout.sh`.

| Variable | Default | Effect |
|---|---|---|
| `REPOS` | *required* | Comma-separated `owner/repo`. |
| `GITHUB_TOKEN` | *required* | Reads issues and PRs. `$(gh auth token)` is fine. |
| `BACKFILL_STATE` | `all` | `all`, `open` or `closed`. |
| `DRY_RUN` | `false` | `true` prints every create/update without writing to Notion. |

The script paces itself at ~3 requests/second to stay inside Notion's rate
limit, so a few thousand items takes a while. It is safe to re-run and safe to
interrupt — the GitHub URL is the dedupe key, so a second pass updates in place
rather than duplicating. After it finishes, the webhooks take over.

---

## 6. What triggers from where

This asymmetry only matters while you're installing:

| Event | Workflow file is read from | Consequence |
|---|---|---|
| `pull_request` | the **PR's head branch** | The PR that adds this workflow will run it, and create a card for itself. |
| `issues` | the **default branch** | Issue syncing does nothing until the workflow is merged to main. |

Once installed, normal usage is unaffected. PRs sync the moment they open — an
unmerged PR sitting in review appears on the board as `Active Unclaimed`, which
is the point. Only `merged` moves it to `Done`.

---

## Field mapping

| Notion property | Source | Notes |
|---|---|---|
| *title* | `{repo}#{number} <title>` | Title property is auto-detected by type, whatever it's called. Prefix configurable via `title-prefix`. |
| GitHub URL | `html_url` | The dedupe key. Works as `url` or `rich_text`. |
| Issue Number | `number` | **Off by default** — the number is already in the title. Turn it on with `PROP_NUMBER`. |
| Repo | `owner/name` | Issue numbers collide across repos — `car-data-server#42` and `SuboptimumG#42` are different things. |
| Status | derived | See below. |
| Tags | `Issue`/`PR` from the item kind, plus labels via `config/label-map.json` | Cleared when labels are removed. Kind tag off via `KIND_TAGS=false`. `Rookie Project` is label-driven only — see below. |
| Owner | assignees, falling back to author | Only logins present in `config/user-map.json`. |
| Contributors | author + assignees + requested reviewers | Same mapping requirement. |
| Due | milestone `due_on` | Date only. Cleared when the milestone is removed. |

`Created` is Notion's built-in created-time property and isn't writable, so the
GitHub creation timestamp is deliberately not synced to it.

Status transitions:

| Situation | Status written |
|---|---|
| Issue or PR open | `Active Unclaimed` |
| PR open, still a draft | `Hold` |
| PR merged, or issue closed | `Done` |
| PR closed unmerged | `Abandoned` (override with `STATUS_PR_CLOSED_UNMERGED`) |
| Open item someone claimed in Notion | *untouched* — see below |

These names must match the board's status **options**, not its status **groups**.
Notion's API cannot create status options, so a name the database doesn't know
would otherwise fail the whole run with `400 validation_error`. The mapper
resolves the configured name against the live schema first: exact match, then
case-insensitive, then a **group** name — `In progress` resolves to
`Active Unclaimed`, that group's first option. Only if none of those hit is
Status left unwritten, with a warning.

### Claiming

The sync never writes `Active Claimed`. Claiming is a human move in Notion: drag a
card from `Active Unclaimed` to `Active Claimed` and it stays there through every
later GitHub event on that item.

The rule is that the sync only overwrites an open item's status when the status
currently on the page is one it could have written itself — `Not started`,
`Active Unclaimed`, or (on a PR) `Hold`. Anything else was put there by a person, so
it is left alone. Two consequences worth knowing:

- **`Hold` sticks on an issue, not on a PR.** On a PR, `Hold` means "draft", which
  GitHub tells us, so a PR marked ready for review moves back to `Active Unclaimed`.
  On an issue nothing in GitHub corresponds to `Hold`, so it reads as a deliberate
  park and survives.
- **Closing always wins.** Merging, closing or abandoning are facts from GitHub and
  overwrite a claim — otherwise claimed cards would never leave the board.

Cards still sitting in `Not started` from an earlier version of this sync are
migrated forward to `Active Unclaimed` on their next event.

Set `respect-manual-status: "false"` if you'd rather GitHub always win, including
over claims.

Status is the only property that defers to manual edits — Tags and Due are
mirrored from GitHub, so editing them in Notion is overwritten on the next event.
Priority is never written at all, so it stays whatever you set by hand.

A deleted or transferred issue (`action: deleted`) **archives** its Notion page
rather than editing it. Archived pages leave the board but stay recoverable from
Notion's trash; nothing is destroyed.

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

`config/label-map.json` works the same way for GitHub label → Notion tag. A
value may be a string or an array, so one label can fan out to several tags. With
`tags-only-mapped: "true"` (the default) an unmapped label is dropped rather than
creating a new option on the Tags property. The `Issue`/`PR` tag does not come
from here — it's derived from the item kind and is added regardless.

**There is no heuristic for rookie issues.** An issue gets the `Rookie Project` tag
only if someone applied one of the mapped labels on GitHub — by default
`rookie-project`, `rookie`, `good first issue` or `onboarding`. `good first issue`
is GitHub's built-in label and is the one to standardize on. Nothing about the
issue's title, body, author or size is inspected, so an unlabeled rookie issue
syncs with just the `Issue` tag.

### Property names

Every property name is configurable, so nothing in Notion has to be renamed.
Either set `PROP_*` env vars, or pass them through the action:

```yaml
- uses: Penn-Electric-Racing/operations_monorepo/notion-github-sync@main
  with:
    notion-token: ${{ secrets.NOTION_TOKEN }}
    property-overrides: '{"PROP_URL":"Link","PROP_REPO":"Repository"}'
```

Recognized keys: `PROP_URL`, `PROP_NUMBER`, `PROP_STATUS`,
`PROP_TAGS`, `PROP_OWNER`, `PROP_CONTRIBUTORS`, `PROP_DUE`, `PROP_REPO`;
`STATUS_NOT_STARTED`, `STATUS_IN_PROGRESS`, `STATUS_CLAIMED`, `STATUS_HOLD`,
`STATUS_DONE`, `STATUS_PR_CLOSED_UNMERGED`; and `TAG_ISSUE`, `TAG_PR`. Other keys
are rejected.

Anything that doesn't exist on the database, or whose type the mapper can't
write, is skipped with a warning rather than failing the run. That tolerance is
what keeps the sync alive as the board schema drifts.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404 object_not_found` from Notion | Integration isn't connected to the database (section 1). |
| `Could not find database with ID` | You used a page ID, not the database ID. |
| `Changes must be made through a pull request` (409) from `rollout.sh` | Branch protection on that repo. Re-run as `MODE=pr ./scripts/rollout.sh`. |
| `gh: Not Found (HTTP 404)` from `rollout.sh` | Token lacks the `workflow` scope — writes under `.github/workflows/` 404 rather than 403. `gh auth refresh -h github.com -s workflow`. |
| `Unable to resolve action ..., not found` at *Set up job* | The calling repo is public and the action repo is private. Public repos cannot use private actions; see section 3. |
| `repository not found` on the `uses:` line | Private action repo without org-wide Actions access enabled. |
| `NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID is not set` | The caller workflow passes an empty `notion-software-project-board-database-id`. Drop that line and let the action's default apply (section 2). |
| `NOTION_TOKEN is not set` | The org secret isn't reaching this repo — on the Free plan it never reaches private ones. Set it repo-level (section 2). |
| Workflow never runs on new issues | The file isn't on the default branch yet (section 6). |
| Nothing runs on a fork's PR | By design — fork PRs get no secrets. |
| Status never changes | The configured option doesn't exist on the board and didn't resolve to a group either; the API can't create status options, only `select` ones. Look for `Status (option "X" not on database)` in the log. |
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
- **Priority is not synced.** The board's Priority lives in GitHub Projects v2,
  which this action cannot read: `projects_v2_item` is not a supported Actions
  trigger, and `GITHUB_TOKEN` cannot hold the `read:project` scope. Mirroring it
  would need a scheduled reconciler plus a PAT. Notion's Priority column is
  manual and the sync never touches it.
- **Rate limit.** Notion allows roughly 3 requests/second. Each webhook uses 3
  calls, fine for normal traffic; a mass label edit across a big repo can trip
  it.
