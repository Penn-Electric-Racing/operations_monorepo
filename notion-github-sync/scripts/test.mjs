#!/usr/bin/env node
import assert from "node:assert/strict";
import { loadConfig, normalize, decideStatus, buildProperties } from "./lib/mapping.mjs";

process.env.USER_MAP_PATH = "config/user-map.json";
process.env.LABEL_MAP_PATH = "config/label-map.json";
const cfg = { ...loadConfig(), userMap: { alice: "u-alice", bob: "u-bob" } };

const statusDef = {
  type: "status",
  status: {
    options: [
      { id: "o-not-started", name: "Not started" },
      { id: "o-unclaimed", name: "Active Unclaimed" },
      { id: "o-claimed", name: "Active Claimed" },
      { id: "o-hold", name: "Hold" },
      { id: "o-abandoned", name: "Abandoned" },
      { id: "o-done", name: "Done" },
    ],
    groups: [
      { id: "g-todo", name: "To-do", option_ids: ["o-not-started"] },
      { id: "g-doing", name: "In progress", option_ids: ["o-unclaimed", "o-claimed", "o-hold"] },
      { id: "g-done", name: "Complete", option_ids: ["o-abandoned", "o-done"] },
    ],
  },
};

const schema = {
  properties: {
    Name: { type: "title" },
    "GitHub URL": { type: "url" },
    "Issue Number": { type: "number" },
    Repo: { type: "select" },
    Status: statusDef,
    Tags: { type: "multi_select" },
    Owner: { type: "people" },
    Due: { type: "date" },
  },
};

const node = (over = {}) => ({
  title: "Thing", html_url: "https://x/1", number: 1, state: "open",
  labels: [], assignees: [], user: { login: "alice" }, ...over,
});
const build = (over, kind = "issue", isNew = true, useCfg = cfg, currentStatus = null) =>
  buildProperties({
    item: normalize({ node: node(over), repoFullName: "org/repo", kind }),
    schema, titleProp: "Name", cfg: useCfg, isNew, currentStatus,
  });

// status decisions
const st = (over, kind, ctx = {}, useCfg = cfg) =>
  decideStatus(
    normalize({ node: node(over), repoFullName: "org/repo", kind }),
    { isNew: true, ...ctx },
    useCfg
  );

assert.equal(st({}, "issue"), "Active Unclaimed", "a new issue is open work nobody has taken");
assert.equal(st({}, "pr"), "Active Unclaimed");
assert.equal(st({ draft: true }, "pr"), "Hold", "drafts park in Hold, not the backlog");
assert.equal(st({ state: "closed" }, "issue"), "Done");
assert.equal(st({ state: "closed", merged: true }, "pr"), "Done");
assert.equal(st({ state: "closed" }, "pr"), "Abandoned", "closed-unmerged PRs are abandoned");

// manual claims survive later GitHub events
for (const kind of ["issue", "pr"]) {
  assert.equal(
    st({}, kind, { isNew: false, currentStatus: "Active Claimed" }),
    null,
    `a claimed ${kind} is left alone`
  );
  assert.equal(
    st({}, kind, { isNew: false, currentStatus: "active claimed" }),
    null,
    "claim matching is case-insensitive"
  );
  assert.equal(
    st({ state: "closed", merged: true }, kind, { isNew: false, currentStatus: "Active Claimed" }),
    "Done",
    "closing still wins over a manual claim"
  );
  assert.equal(
    st({}, kind, { isNew: false, currentStatus: "Active Unclaimed" }),
    "Active Unclaimed",
    "the sync still owns a status it wrote itself"
  );
  assert.equal(
    st({}, kind, { isNew: false, currentStatus: "Not started" }),
    "Active Unclaimed",
    "cards left in the old backlog status are migrated forward"
  );
}

assert.equal(
  st({}, "pr", { isNew: false, currentStatus: "Hold" }),
  "Active Unclaimed",
  "a PR leaving draft moves out of Hold"
);
assert.equal(
  st({ draft: true }, "pr", { isNew: false, currentStatus: "Active Unclaimed" }),
  "Hold",
  "a PR converted back to draft returns to Hold"
);
assert.equal(
  st({}, "issue", { isNew: false, currentStatus: "Hold" }),
  null,
  "an issue parked in Hold by hand stays there"
);

const forceCfg = { ...cfg, respectManualStatus: false };
assert.equal(
  st({}, "issue", { isNew: false, currentStatus: "Active Claimed" }, forceCfg),
  "Active Unclaimed"
);

assert.equal(st({}, "issue", { isNew: false, currentStatus: null }), "Active Unclaimed");

assert.equal(
  decideStatus(normalize({ node: node({}), repoFullName: "org/repo", kind: "pr" }), true, cfg),
  "Active Unclaimed"
);

// status resolution against the live schema
assert.deepEqual(build({}, "pr").props.Status, { status: { name: "Active Unclaimed" } });

const groupCfg = { ...cfg, status: { ...cfg.status, inProgress: "In progress" } };
const grouped = build({}, "pr", true, groupCfg);
assert.deepEqual(
  grouped.props.Status,
  { status: { name: "Active Unclaimed" } },
  "a group name resolves to that group's first option"
);
assert.ok(
  !grouped.skipped.some((m) => m.startsWith("Status")),
  "resolving via a group is not a skip"
);

const caseCfg = { ...cfg, status: { ...cfg.status, inProgress: "ACTIVE UNCLAIMED" } };
assert.deepEqual(build({}, "pr", true, caseCfg).props.Status, { status: { name: "Active Unclaimed" } });

assert.equal(
  build({}, "pr", false, cfg, "Active Claimed").props.Status,
  undefined,
  "a manual claim produces no Status write at all"
);

const badCfg = { ...cfg, status: { ...cfg.status, inProgress: "Nonexistent" } };
const bad = build({}, "pr", true, badCfg);
assert.equal(bad.props.Status, undefined, "an unknown status is left unwritten, not sent");
assert.ok(
  bad.skipped.includes('Status (option "Nonexistent" not on database)'),
  "an unresolvable status is reported as skipped"
);

// properties
const { props, skipped } = build({ labels: [{ name: "bug" }, { name: "p1" }], milestone: { due_on: "2026-01-02T00:00:00Z" } });
assert.equal(props.Name.title[0].text.content, "repo#1 Thing");
assert.deepEqual(props["GitHub URL"], { url: "https://x/1" });
assert.deepEqual(props.Repo, { select: { name: "org/repo" } });
assert.deepEqual(
  props.Tags,
  { multi_select: [{ name: "Issue" }, { name: "Bug" }] },
  "kind tag leads; an unmapped p1 label is dropped"
);
assert.equal(props.Priority, undefined, "Priority is never written — it is manual in Notion");
assert.deepEqual(props.Due, { date: { start: "2026-01-02" } });
assert.deepEqual(props.Owner, { people: [{ object: "user", id: "u-alice" }] }, "author is the fallback owner");
assert.equal(props["Issue Number"], undefined, "Issue Number is off by default");
assert.deepEqual(skipped, ["Contributors (not on database)"]);

// tags
const bare = build({}).props;
assert.deepEqual(bare.Tags, { multi_select: [{ name: "Issue" }] });
assert.deepEqual(bare.Due, { date: null });

assert.deepEqual(build({}, "pr").props.Tags, { multi_select: [{ name: "PR" }] });
assert.deepEqual(
  build({ labels: [{ name: "documentation" }] }, "pr").props.Tags,
  { multi_select: [{ name: "PR" }, { name: "Documentation" }] }
);
assert.deepEqual(
  build({ labels: [{ name: "good first issue" }] }).props.Tags,
  { multi_select: [{ name: "Issue" }, { name: "Rookie Project" }] }
);

const unmapped = build({ labels: [{ name: "wontfix" }], assignees: [{ login: "nobody" }] }).props;
assert.deepEqual(unmapped.Tags, { multi_select: [{ name: "Issue" }] }, "unmapped labels are dropped");
assert.equal(unmapped.Owner, undefined);

const noKind = build({}, "issue", true, { ...cfg, kindTags: false }).props;
assert.deepEqual(noKind.Tags, { multi_select: [] }, "KIND_TAGS=false disables the kind tag");

// PROP_NUMBER override still works
const numbered = build({}, "issue", true, { ...cfg, props: { ...cfg.props, number: "Issue Number" } }).props;
assert.deepEqual(numbered["Issue Number"], { number: 1 });

console.log("ok");
