#!/usr/bin/env node
// Self-check for the mapping layer: node scripts/test.mjs
import assert from "node:assert/strict";
import { loadConfig, normalize, decideStatus, buildProperties } from "./lib/mapping.mjs";

process.env.USER_MAP_PATH = "config/user-map.json";
process.env.LABEL_MAP_PATH = "config/label-map.json";
const cfg = { ...loadConfig(), userMap: { alice: "u-alice", bob: "u-bob" } };

const schema = {
  properties: {
    Name: { type: "title" },
    "GitHub URL": { type: "url" },
    "Issue Number": { type: "number" },
    Repo: { type: "select" },
    Status: { type: "status" },
    Priority: { type: "select" },
    Tags: { type: "multi_select" },
    Owner: { type: "people" },
    Due: { type: "date" },
  },
};

const node = (over = {}) => ({
  title: "Thing", html_url: "https://x/1", number: 1, state: "open",
  labels: [], assignees: [], user: { login: "alice" }, ...over,
});
const build = (over, kind = "issue", isNew = true) =>
  buildProperties({
    item: normalize({ node: node(over), repoFullName: "org/repo", kind }),
    schema, titleProp: "Name", cfg, isNew,
  });

// Status
const st = (over, kind, isNew = true) =>
  decideStatus(normalize({ node: node(over), repoFullName: "org/repo", kind }), isNew, cfg);
assert.equal(st({}, "issue"), "Not started");
assert.equal(st({}, "issue", false), null, "existing open issue keeps its manual status");
assert.equal(st({ state: "closed" }, "issue"), "Done");
assert.equal(st({ draft: true }, "pr"), "Not started");
assert.equal(st({}, "pr"), "In progress");
assert.equal(st({ state: "closed", merged: true }, "pr"), "Done");
assert.equal(st({ state: "closed" }, "pr"), "Not started");

// Title, dedupe key, repo
const { props, skipped } = build({ labels: [{ name: "bug" }, { name: "p1" }], milestone: { due_on: "2026-01-02T00:00:00Z" } });
assert.equal(props.Name.title[0].text.content, "repo#1 Thing");
assert.deepEqual(props["GitHub URL"], { url: "https://x/1" });
assert.deepEqual(props.Repo, { select: { name: "org/repo" } });
assert.deepEqual(props.Priority, { select: { name: "P1" } }, "priority label is uppercased");
assert.deepEqual(props.Tags, { multi_select: [{ name: "Bug" }] }, "priority labels stay out of Tags");
assert.deepEqual(props.Due, { date: { start: "2026-01-02" } });
assert.deepEqual(props.Owner, { people: [{ object: "user", id: "u-alice" }] }, "author is the fallback owner");
assert.deepEqual(skipped, ["Contributors (not on database)"]);

// Removing a label or milestone clears the property.
const bare = build({}).props;
assert.deepEqual(bare.Tags, { multi_select: [] });
assert.deepEqual(bare.Priority, { select: null });
assert.deepEqual(bare.Due, { date: null });

// Unmapped labels and logins are dropped, never fabricated.
const unmapped = build({ labels: [{ name: "wontfix" }], assignees: [{ login: "nobody" }] }).props;
assert.deepEqual(unmapped.Tags, { multi_select: [] });
assert.equal(unmapped.Owner, undefined);

console.log("ok");
