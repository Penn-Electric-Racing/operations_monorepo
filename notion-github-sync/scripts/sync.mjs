#!/usr/bin/env node
import fs from "node:fs";
import { createClient, findTitleProp, findPageByUrl, pageStatusName } from "./lib/notion.mjs";
import { loadConfig, normalize, buildProperties } from "./lib/mapping.mjs";

async function main() {
  const cfg = loadConfig();
  if (!cfg.databaseId) throw new Error("NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID is not set.");

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) throw new Error("No GITHUB_EVENT_PATH available.");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));

  const eventName = process.env.GITHUB_EVENT_NAME;
  const repoFullName = payload.repository?.full_name || process.env.GITHUB_REPOSITORY;

  let node, kind;
  if (payload.pull_request) {
    node = payload.pull_request;
    kind = "pr";
  } else if (payload.issue) {
    node = payload.issue;
    kind = payload.issue.pull_request ? "pr" : "issue";
  } else {
    console.log(`Event "${eventName}" has no issue or pull_request payload; nothing to sync.`);
    return;
  }

  const client = createClient({
    token: process.env.NOTION_TOKEN,
    version: process.env.NOTION_VERSION || "2022-06-28",
  });

  const schema = await client.getDatabase(cfg.databaseId);
  const titleProp = findTitleProp(schema);
  const item = normalize({ node, repoFullName, kind });

  const existing = await findPageByUrl(client, cfg.databaseId, schema, cfg.props.url, item.url);

  if (payload.action === "deleted") {
    if (existing) {
      await client.updatePage(existing.id, { archived: true });
      console.log(`Archived Notion page for ${item.url}`);
    }
    return;
  }

  const { props, skipped } = buildProperties({
    item,
    schema,
    titleProp,
    cfg,
    isNew: !existing,
    currentStatus: pageStatusName(existing, cfg.props.status),
  });

  if (skipped.length) console.warn(`Skipped properties: ${skipped.join(", ")}`);

  if (existing) {
    await client.updatePage(existing.id, { properties: props, archived: false });
    console.log(`Updated ${existing.url} from ${item.url}`);
  } else {
    const page = await client.createPage({
      parent: { database_id: cfg.databaseId },
      properties: props,
    });
    console.log(`Created ${page.url} from ${item.url}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
