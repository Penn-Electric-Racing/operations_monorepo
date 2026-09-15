import fs from "node:fs";

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};

const readJson = (p, fallback) => {
  if (!p) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.warn(`Could not read ${p} (${err.message}); continuing without it.`);
    return fallback;
  }
};

export function loadConfig() {
  return {
    databaseId: (env("NOTION_DATABASE_ID") || "").replace(/-/g, ""),
    props: {
      url: env("PROP_URL", "GitHub URL"),
      number: env("PROP_NUMBER", "Issue Number"),
      status: env("PROP_STATUS", "Status"),
      priority: env("PROP_PRIORITY", "Priority"),
      tags: env("PROP_TAGS", "Tags"),
      owner: env("PROP_OWNER", "Owner"),
      contributors: env("PROP_CONTRIBUTORS", "Contributors"),
      due: env("PROP_DUE", "Due"),
      repo: env("PROP_REPO", "Repo"),
    },
    status: {
      notStarted: env("STATUS_NOT_STARTED", "Not started"),
      inProgress: env("STATUS_IN_PROGRESS", "In progress"),
      done: env("STATUS_DONE", "Done"),
      prClosedUnmerged: env("STATUS_PR_CLOSED_UNMERGED", env("STATUS_NOT_STARTED", "Not started")),
    },
    tagsOnlyMapped: env("TAGS_ONLY_MAPPED", "true") === "true",
    respectManualStatus: env("RESPECT_MANUAL_STATUS", "true") === "true",
    titlePrefix: env("TITLE_PREFIX", "{repo}#{number} "),
    userMap: readJson(env("USER_MAP_PATH", "config/user-map.json"), {}),
    labelMap: readJson(env("LABEL_MAP_PATH", "config/label-map.json"), {}),
  };
}

const PRIORITY_RE = /^P[0-4]$/i;

/** Flatten a webhook `issue` / `pull_request` object. */
export function normalize({ node, repoFullName, kind }) {
  const isPr = kind === "pr";
  return {
    kind,
    title: node.title,
    url: node.html_url,
    number: node.number,
    repo: repoFullName,
    state: node.state, // "open" | "closed"
    merged: isPr ? Boolean(node.merged || node.merged_at || node.pull_request?.merged_at) : false,
    draft: Boolean(node.draft),
    labels: (node.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    assignees: (node.assignees || []).map((u) => u.login),
    author: node.user?.login,
    reviewers: (node.requested_reviewers || []).map((u) => u.login),
    dueOn: node.milestone?.due_on || null,
  };
}

export function decideStatus(item, isNew, cfg) {
  if (item.state === "closed") {
    if (item.kind === "pr" && !item.merged) return cfg.status.prClosedUnmerged;
    return cfg.status.done;
  }
  if (item.kind === "pr") return item.draft ? cfg.status.notStarted : cfg.status.inProgress;
  // Open issue: seed on creation, then leave it to humans.
  if (isNew || !cfg.respectManualStatus) return cfg.status.notStarted;
  return null; // null => leave the property alone
}

function peopleValue(logins, userMap) {
  const ids = [...new Set(logins.map((l) => userMap[l]).filter(Boolean))];
  return ids.map((id) => ({ object: "user", id }));
}

function tagValues(labels, cfg) {
  const out = [];
  for (const label of labels) {
    if (PRIORITY_RE.test(label)) continue;
    const mapped = cfg.labelMap[label];
    if (mapped) out.push(...[].concat(mapped));
    else if (!cfg.tagsOnlyMapped) out.push(label);
  }
  return [...new Set(out)];
}

/** Build a Notion `properties` payload, skipping unknown properties and types. */
export function buildProperties({ item, schema, titleProp, cfg, isNew }) {
  const props = {};
  const skipped = [];

  const set = (name, byType) => {
    if (!name) return;
    const def = schema.properties[name];
    if (!def) {
      skipped.push(`${name} (not on database)`);
      return;
    }
    const value = byType[def.type];
    if (value === undefined) {
      skipped.push(`${name} (unsupported type "${def.type}")`);
      return;
    }
    if (value === null) return; // intentional no-op
    props[name] = value;
  };

  const prefix = cfg.titlePrefix
    .replace("{repo}", item.repo.split("/")[1] || item.repo)
    .replace("{owner}", item.repo.split("/")[0] || "")
    .replace("{number}", String(item.number));
  const title = `${prefix}${item.title}`.slice(0, 2000);

  props[titleProp] = { title: [{ text: { content: title } }] };

  set(cfg.props.url, {
    url: { url: item.url },
    rich_text: { rich_text: [{ text: { content: item.url, link: { url: item.url } } }] },
  });

  set(cfg.props.number, {
    number: { number: item.number },
    rich_text: { rich_text: [{ text: { content: String(item.number) }}] },
  });

  set(cfg.props.repo, {
    select: { select: { name: item.repo } },
    multi_select: { multi_select: [{ name: item.repo }] },
    rich_text: { rich_text: [{ text: { content: item.repo } }] },
  });

  const statusName = decideStatus(item, isNew, cfg);
  set(cfg.props.status, {
    status: statusName ? { status: { name: statusName } } : null,
    select: statusName ? { select: { name: statusName } } : null,
  });

  // Labels and milestones are mirrored, so removing one clears the property.
  const priority = item.labels.find((l) => PRIORITY_RE.test(l))?.toUpperCase();
  set(cfg.props.priority, {
    select: { select: priority ? { name: priority } : null },
    multi_select: { multi_select: priority ? [{ name: priority }] : [] },
    status: priority ? { status: { name: priority } } : null, // status options can't be cleared safely
  });

  const tags = tagValues(item.labels, cfg);
  set(cfg.props.tags, {
    multi_select: { multi_select: tags.map((name) => ({ name })) },
    select: { select: tags.length ? { name: tags[0] } : null },
  });

  const owners = peopleValue(item.assignees.length ? item.assignees : [item.author], cfg.userMap);
  if (owners.length) set(cfg.props.owner, { people: { people: owners } });

  const contributors = peopleValue(
    [...new Set([item.author, ...item.reviewers, ...item.assignees].filter(Boolean))],
    cfg.userMap
  );
  if (contributors.length) set(cfg.props.contributors, { people: { people: contributors } });

  set(cfg.props.due, { date: { date: item.dueOn ? { start: item.dueOn.slice(0, 10) } : null } });

  return { props, skipped };
}
