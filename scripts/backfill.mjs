#!/usr/bin/env node
/**
 * One-time import of existing issues and PRs into the Notion board.
 *
 *   REPOS="org/repo-a,org/repo-b" GITHUB_TOKEN=... NOTION_TOKEN=... \
 *   NOTION_DATABASE_ID=... node scripts/backfill.mjs
 *
 * Add DRY_RUN=true to print what would happen without writing to Notion.
 */
import { createClient, findTitleProp, findPageByUrl } from "./lib/notion.mjs";
import { loadConfig, normalize, buildProperties } from "./lib/mapping.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY_RUN = process.env.DRY_RUN === "true";
const STATE = process.env.BACKFILL_STATE || "all"; // all | open | closed

async function listIssues(repo, token) {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=${STATE}&per_page=100&page=${page}`,
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
  const repos = (process.env.REPOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!repos.length) throw new Error("Set REPOS to a comma-separated list of owner/repo.");
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

  for (const repo of repos) {
    const nodes = await listIssues(repo, ghToken);
    console.log(`${repo}: ${nodes.length} issues/PRs`);

    for (const node of nodes) {
      const kind = node.pull_request ? "pr" : "issue";
      const item = normalize({ node, repoFullName: repo, kind });
      const existing = await findPageByUrl(client, cfg.databaseId, schema, cfg.props.url, item.url);
      const { props } = buildProperties({ item, schema, titleProp, cfg, isNew: !existing });

      if (DRY_RUN) {
        console.log(`${existing ? "would update" : "would create"} ${item.url}`);
      } else if (existing) {
        await client.updatePage(existing.id, { properties: props });
        updated++;
      } else {
        await client.createPage({ parent: { database_id: cfg.databaseId }, properties: props });
        created++;
      }
      await sleep(350); // Notion allows ~3 req/s
    }
  }

  console.log(`Done. created=${created} updated=${updated}${DRY_RUN ? " (dry run)" : ""}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
