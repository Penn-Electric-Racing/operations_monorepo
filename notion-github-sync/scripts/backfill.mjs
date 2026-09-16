#!/usr/bin/env node
import { createClient, findTitleProp, findPageByUrl, pageStatusName } from "./lib/notion.mjs";
import { loadConfig, normalize, buildProperties } from "./lib/mapping.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY_RUN = process.env.DRY_RUN === "true";
const STATE = process.env.BACKFILL_STATE || "all";

const SINCE_MINUTES = Number(process.env.SINCE_MINUTES) || 0;
const SINCE = SINCE_MINUTES
  ? new Date(Date.now() - SINCE_MINUTES * 60000).toISOString()
  : "";

const DEFAULT_REPOS = [
  "Penn-Electric-Racing/car-data-server",
  "Penn-Electric-Racing/Penn-Electric-Racing",
  "Penn-Electric-Racing/PER-Data-Analyzer",
  "Penn-Electric-Racing/SuboptimumG",
];

async function listIssues(repo, token) {
  const out = [];
  const since = SINCE ? `&since=${SINCE}` : "";
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=${STATE}&per_page=100&page=${page}${since}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub ${repo} page ${page}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 100) return out;
    await sleep(250);
  }
}

async function main() {
  const cfg = loadConfig();
  const repos = (process.env.REPOS || DEFAULT_REPOS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!repos.length) throw new Error("REPOS is set but empty.");
  const bad = repos.filter((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
  if (bad.length) {
    throw new Error(
      `REPOS must be comma-separated owner/repo. Bad entries: ${bad.join(", ")}\n` +
        `If this is left over from another command, run: unset REPOS`
    );
  }
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error("GITHUB_TOKEN is not set.");

  const client = createClient({
    token: process.env.NOTION_TOKEN,
    version: process.env.NOTION_VERSION || "2022-06-28",
  });
  const schema = await client.getDatabase(cfg.databaseId);
  const titleProp = findTitleProp(schema);

  let created = 0;
  let updated = 0;
  const warned = new Set();

  for (const repo of repos) {
    const nodes = await listIssues(repo, ghToken);
    console.log(`${repo}: ${nodes.length} issues/PRs${SINCE ? ` updated since ${SINCE}` : ""}`);

    for (const node of nodes) {
      const kind = node.pull_request ? "pr" : "issue";
      const item = normalize({ node, repoFullName: repo, kind });
      const existing = await findPageByUrl(client, cfg.databaseId, schema, cfg.props.url, item.url);
      const { props, skipped } = buildProperties({
        item, schema, titleProp, cfg,
        isNew: !existing,
        currentStatus: pageStatusName(existing, cfg.props.status),
      });

      for (const msg of skipped) {
        if (warned.has(msg)) continue;
        warned.add(msg);
        console.warn(`Skipped property: ${msg}`);
      }

      if (DRY_RUN) {
        const status = props[cfg.props.status]?.status?.name || props[cfg.props.status]?.select?.name || "(unset)";
        const tags = (props[cfg.props.tags]?.multi_select || []).map((t) => t.name).join(", ") || "(none)";
        console.log(
          `${existing ? "would update" : "would create"} ${item.url} [status=${status}] [tags=${tags}]`
        );
      } else if (existing) {
        await client.updatePage(existing.id, { properties: props });
        updated++;
      } else {
        await client.createPage({ parent: { database_id: cfg.databaseId }, properties: props });
        created++;
      }
      await sleep(350);
    }
  }

  console.log(`Done. created=${created} updated=${updated}${DRY_RUN ? " (dry run)" : ""}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
