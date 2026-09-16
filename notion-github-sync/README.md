# notion-github-sync

Mirrors GitHub issues and pull requests from every Penn Electric Racing repo
into the single Notion database behind our project board. One scheduled workflow
in `operations_monorepo` polls every listed repo — **mirrored repos carry no
workflow file and no secrets of their own.**

All commands below are run from this directory.

The GitHub URL is the primary key, so re-running is always safe — an item that
already exists is updated in place rather than duplicated.

No dependencies, plain Node 20 `fetch`. The Notion database and its properties
already exist.

---

## Contents

1. [Get the token and database ID](#1-get-the-token-and-database-id)
2. [Add the two secrets](#2-add-the-two-secrets)
3. [Map people to the Notion People columns](#3-map-people-to-the-notion-people-columns)
4. [Add a repo to the sync](#4-add-a-repo-to-the-sync)
5. [Verify](#5-verify)
6. [Backfill existing issues and PRs](#6-backfill-existing-issues-and-prs)
7. [How the poll works](#7-how-the-poll-works)
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

Dashes are fine; the script strips them. It is set once in the poll workflow's
`env:` block and in the backfill command (section 5).

---

## 2. Add the two secrets

Both live on `operations_monorepo` only — that is the one repo the workflow runs in.

```bash
gh secret set NOTION_TOKEN   --repo Penn-Electric-Racing/operations_monorepo
gh secret set GH_READ_TOKEN  --repo Penn-Electric-Racing/operations_monorepo
```

Each prompts on stdin. Never pass a token as a literal `--body` value — that
writes it to `~/.bash_history`.

| Secret | What it is |
|---|---|
| `NOTION_TOKEN` | The Notion integration secret from section 1. |
| `GH_READ_TOKEN` | A **fine-grained** PAT granted access to every repo in `REPOS`. |

`GH_READ_TOKEN` exists because the workflow's built-in `GITHUB_TOKEN` is scoped
to `operations_monorepo` alone and cannot read issues in the other repos. Note
its expiry date somewhere — when it lapses the poll fails, and nothing else
tells you.

Its permissions, all read-only:

| Scope | Permission | Used by the poller |
|---|---|---|
| Repository | Metadata *(required)* | yes |
| Repository | Issues | yes |
| Repository | Pull requests | yes |
| Organization | Projects | no — see Known limits |
| Organization | Issue Fields | no |
| Organization | Issue Types | no |

Only the three repository permissions are load-bearing. The organization ones are
granted deliberately but unused; `Projects` is the interesting one, since it is
what reading the board's own Priority field would need.

**Repository access is per-repo, not org-wide.** Adding a repo to `REPOS`
(section 3) without also granting the PAT access to it produces a `404` for that
repo and silence for the rest.

`NOTION_TOKEN` is repo-level, not an org secret: org secrets don't reach private
repos on the GitHub Free plan, and resolve to an empty string instead of erroring.

---

## 3. Map people to the Notion People columns

`config/user-map.json` maps **GitHub login → Notion user ID**. Notion's People
properties accept only user IDs, so an unmapped person leaves Owner and
Contributors blank.

List the IDs:

```bash
curl -s https://api.notion.com/v1/users \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" | jq '.results[] | {name, id}'
```

Add one line per member. Dashes in the ID are optional.

```json
{
  "alex-yang-upenn": "2b458698d1054366b74f598f6fd96357"
}
```

The key must be the **exact GitHub login**, not a display name — the lookup is
case-sensitive. Check one with `gh api users/<login> --jq .login`, or list who
actually appears in a repo:

```bash
gh api repos/Penn-Electric-Racing/<repo>/contributors --jq '.[].login'
```

Unmapped logins are skipped silently, so a new contributor never breaks a sync.
Malformed or all-zero IDs are dropped too — an ID that isn't a real workspace
user would make Notion reject the whole page.

---

## 4. Add a repo to the sync

Two steps, both one-liners:

1. Add `Penn-Electric-Racing/<name>` to `DEFAULT_REPOS` at the top of
   `scripts/backfill.mjs`.
2. Grant `GH_READ_TOKEN` access to that repo, in the PAT's settings.

Nothing is written to the target repo. `REPOS` overrides the list as a
comma-separated `owner/repo` string for a one-off run against a subset.

---

## 5. Verify

```bash
node scripts/test.mjs   # mapping self-check, no network, no credentials
```

Then a dry run — reads only, writes nothing to Notion. With the two tokens in
your environment it needs nothing else; the repo list and board ID are defaults
in the scripts, so this runs exactly what the workflow runs:

```bash
export NOTION_TOKEN=ntn_...
export GITHUB_TOKEN="$(gh auth token)"

SINCE_MINUTES=60 DRY_RUN=true node scripts/backfill.mjs
```

It prints `N issues/PRs updated since <timestamp>` per repo and a `would create`
/ `would update` line per item. Drop `SINCE_MINUTES` and the count should jump to
the full history — that is the check that the window filter is doing its job.

Narrow it to one repo with `REPOS=Penn-Electric-Racing/car-data-server`.

Then the real thing:

```bash
gh workflow run notion-poll.yml --repo Penn-Electric-Racing/operations_monorepo
gh run watch --repo Penn-Electric-Racing/operations_monorepo
```

Read the `Skipped properties:` lines on the first run — they name exactly which
board columns didn't match.

---

## 6. Backfill existing issues and PRs

**This is required once, and the poll cannot do it for you.** The poll only looks
at items updated in the last `SINCE_MINUTES`, so an issue nobody has touched
recently never enters its window — not on the first run, not ever. Everything
that predates the sync has to be imported by one full pass.

Same script as the poll, with no window, so it walks the full history:

```bash
unset REPOS SINCE_MINUTES   # in case either is left over in your shell
export NOTION_TOKEN=ntn_...
export GITHUB_TOKEN="$(gh auth token)"

BACKFILL_STATE=open DRY_RUN=true node scripts/backfill.mjs   # preview
BACKFILL_STATE=open node scripts/backfill.mjs                # for real
```

**Use `BACKFILL_STATE=open`.** The default `all` walks every issue and PR ever
opened — ~939 across these four repos — which takes 15-20 minutes at Notion's
rate limit, only to skip nearly all of them (see below).

**Closed items never create a card.** A closed issue or PR only *updates* a card
that already exists, moving it to `Done` or `Abandoned`. One with no card was
never on the board and is skipped, counted as `skipped_closed` in the run
finished work.

| Variable | Default | Effect |
|---|---|---|
| `NOTION_TOKEN` | *required* | Notion integration secret. |
| `GITHUB_TOKEN` | *required* | Reads issues and PRs. `$(gh auth token)` is fine. |
| `REPOS` | `DEFAULT_REPOS` in the script | Comma-separated `owner/repo`, to run against a subset. |
| `SINCE_MINUTES` | *unset* | Unset walks everything; set, only items updated in that window. |
| `BACKFILL_STATE` | `all` | `all`, `open` or `closed`. |
| `IMPORT_CLOSED` | `false` | `true` also creates cards for closed items that have none. |
| `DRY_RUN` | `false` | `true` prints every create/update without writing to Notion. |
| `NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID` | the board ID in `mapping.mjs` | Target a different database. |

The script paces itself at ~3 requests/second to stay inside Notion's rate
limit, so a few thousand items takes a while. It is safe to re-run and safe to
interrupt — the GitHub URL is the dedupe key, so a second pass updates in place
rather than duplicating. The poll picks up from there.

---

## 7. How the poll works

`.github/workflows/notion-poll.yml` runs `scripts/backfill.mjs` on two schedules.
`workflow_dispatch` runs it on demand.

| | cron | window | state | items |
|---|---|---|---|---|
| Fast path | `*/15 * * * *` | 24h | all | ~17 |
| Safety net | `40 4 * * *` | none | open | ~22 |

The step picks its mode from `github.event.schedule`. Manual runs take the fast
path.

**Why two.** GitHub does not honour `*/15` for free scheduled runs — observed
gaps between consecutive runs have exceeded five hours, and unserved slots are
*discarded, not queued*. The fast path's 24h window is sized to cover that gap:
an item updated inside a skipped gap and older than the window is missed
**permanently**, because `since` filters on `updated_at` and a missed item never
reappears. The window is a bet on how bad the gaps get.

The nightly removes the bet. With no window it reconciles every currently-open
issue and PR regardless of when it last changed, so a gap of *any* length is
recoverable. Scoping it to `open` is what keeps it cheap — a full `state=all`
walk is ~939 items and 15+ minutes, versus ~22 items and seconds.

Re-syncing an unchanged item is an idempotent no-op write and the `GitHub URL`
is the dedupe key, so the overlap between the two costs almost nothing.

Latency is whatever GitHub gives you — often 15 minutes, sometimes hours.
`gh workflow run notion-poll.yml` forces a run.

To see how badly the schedule is actually served:

```bash
gh run list --repo Penn-Electric-Racing/operations_monorepo \
  --workflow notion-poll.yml -L 100 \
  --json event,createdAt --jq '.[] | select(.event=="schedule") | .createdAt' | sort
```

Never set `SINCE_MINUTES` below the largest gap you see there.

A `concurrency` group prevents a slow run from overlapping the next.

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

Names are resolved against the live schema — exact, then case-insensitive, then
as a status **group** (`In progress` → that group's first option). If none match,
Status is left unwritten with a warning rather than failing the run.

### Claiming

The sync never writes `Active Claimed`. Claiming is a human move in Notion: drag a
card from `Active Unclaimed` to `Active Claimed` and it stays there through every
later GitHub event on that item.

The sync only overwrites an open item's status when the current value is one it
could have written itself — `Not started`, `Active Unclaimed`, or (on a PR)
`Hold`. Anything else was set by a person and is left alone. Two consequences:

- **`Hold` sticks on an issue, not on a PR.** On a PR, `Hold` means "draft", which
  GitHub tells us, so a PR marked ready for review moves back to `Active Unclaimed`.
  On an issue nothing in GitHub corresponds to `Hold`, so it reads as a deliberate
  park and survives.
- **Closing always wins.** Merging, closing or abandoning are facts from GitHub and
  overwrite a claim — otherwise claimed cards would never leave the board.

Set `respect-manual-status: "false"` if you'd rather GitHub always win, including
over claims.

Status is the only property that defers to manual edits — Tags and Due are
mirrored from GitHub, so editing them in Notion is overwritten on the next event.
Priority is never written at all, so it stays whatever you set by hand.

A deleted or transferred issue (`action: deleted`) **archives** its Notion page
rather than editing it. Archived pages leave the board but stay recoverable from
Notion's trash; nothing is destroyed.

### Mapping labels to Tags

`config/label-map.json` works the same way for GitHub label → Notion tag. A
value may be a string or an array, so one label can fan out to several tags. With
`tags-only-mapped: "true"` (the default) an unmapped label is dropped rather than
creating a new option on the Tags property. The `Issue`/`PR` tag does not come
from here — it's derived from the item kind and is added regardless.

**`Rookie Project` is label-driven only** — `rookie-project`, `rookie`,
`good first issue` or `onboarding`. Nothing about the issue itself is inspected.
Standardize on `good first issue`, GitHub's built-in.

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

Anything missing from the database, or of a type the mapper can't write, is
skipped with a warning rather than failing the run.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `404 object_not_found` from Notion | Integration isn't connected to the database (section 1). |
| `Could not find database with ID` | You used a page ID, not the database ID. |
| `NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID is not set` | Missing from the workflow's `env:` block (section 6). |
| `NOTION_TOKEN is not set` | No repo-level secret on `operations_monorepo`. Org secrets don't reach private repos on the Free plan (section 2). |
| `404` or `403` listing issues for one repo | `GH_READ_TOKEN` has expired, or was never granted access to that repo (section 3). |
| A repo silently stops syncing | It's missing from `REPOS`, or the PAT lost access to it. |
| Nothing has synced for days | The scheduled workflow was auto-disabled, or runs are being dropped. `gh run list --workflow notion-poll.yml`. |
| Status never changes | The configured option doesn't exist on the board and didn't resolve to a group either; the API can't create status options, only `select` ones. Look for `Status (option "X" not on database)` in the log. |
| Owner/Contributors stay empty | GitHub logins missing from `config/user-map.json`. |
| Duplicate cards appear | The `GitHub URL` property was renamed or removed, so dedupe can't find matches. |
| `429` in the log | Notion rate limit; the client backs off and retries automatically. |

---

## Known limits

- **Latency.** Up to an hour, plus whatever GitHub adds. Scheduled workflows are
  delayed under load and queued jobs may be dropped outright, so treat the board
  as eventually consistent. This is the price of not installing a workflow in
  every repo.
- **Deletions are invisible.** A deleted or transferred issue used to archive its
  Notion page, which came from the `deleted` webhook event. A poller cannot see
  something that stopped existing, so the card is left behind — remove it by hand.
- **Requested reviewers are missing.** The `/issues` endpoint omits
  `requested_reviewers`, so Contributors is author + assignees only. `draft` and
  `merged_at` are present, so Status is unaffected.
- **Inactivity disables the schedule.** GitHub disables scheduled workflows in a
  *public* repo after 60 days with no repository activity, and `operations_monorepo`
  is public on purpose: public repos get unlimited free Actions minutes, while
  private ones draw on the org's 2,000/month pool shared with all other CI. An
  15-minute poll would take ~2,880 of those, since each run bills as a full
  minute however little it does.
- **The schedule is best-effort, and cannot be made otherwise.** GitHub
  deprioritizes free scheduled runs and discards unserved slots; gaps of several
  hours between `*/15` runs are normal. There is no SLA and no retry. The only
  reliable trigger is an external scheduler calling the `workflow_dispatch` API,
  which costs a second system and a token with `actions: write` living outside
  GitHub — not worth it while drops cost latency rather than data.
- **A card can miss its move to `Done`.** If an item's close falls entirely inside
  a gap longer than the 24h window, its existing card is left showing open work:
  the nightly only reads open items, and the window has passed the close. Rare,
  and fixed by a one-off `BACKFILL_STATE=closed node scripts/backfill.mjs`, which
  only updates cards that already exist. Any commit resets the 60-day clock; a re-enable is
  manual, and it fails quietly.
- **PAT expiry.** `GH_READ_TOKEN` is the single point of failure for every repo
  at once, and it fails silently on expiry.
- **Direction.** One-way, GitHub → Notion. Closing a card in Notion does not
  close the issue; that would need Notion webhooks.
- **API version.** Pinned to `2022-06-28`, where pages parent directly to a
  `database_id`. On `2025-09-03` and later, databases gain data sources:
  `parent` becomes `{data_source_id}` and queries hit
  `/data_sources/{id}/query`. Those three call sites are isolated in
  `scripts/lib/notion.mjs`.
- **Priority is not synced — by choice, not by obstacle.** Notion's Priority
  column is manual and the sync never writes it. This was originally blocked
  twice over: `projects_v2_item` is not a supported Actions trigger, and
  `GITHUB_TOKEN` cannot read Projects v2. Both blockers are gone — the scheduled
  poller replaced the trigger, and `GH_READ_TOKEN` already holds organization
  `Projects: read-only`. What remains is the work: a GraphQL query per poll for
  the project's items and their Priority value, joined to the Notion rows on
  issue/PR URL. Don't re-derive the old "impossible" conclusion.
- **Rate limit.** Notion allows roughly 3 requests/second. Each webhook uses 3
  calls, fine for normal traffic; a mass label edit across a big repo can trip
  it.
