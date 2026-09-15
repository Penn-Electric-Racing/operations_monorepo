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
    databaseId: (env("NOTION_SOFTWARE_PROJECT_BOARD_DATABASE_ID") || "").replace(/-/g, ""),
    props: {
      url: env("PROP_URL", "GitHub URL"),
      number: env("PROP_NUMBER", ""),
      status: env("PROP_STATUS", "Status"),
      tags: env("PROP_TAGS", "Tags"),
      owner: env("PROP_OWNER", "Owner"),
      contributors: env("PROP_CONTRIBUTORS", "Contributors"),
      due: env("PROP_DUE", "Due"),
      repo: env("PROP_REPO", "Repo"),
    },
    status: {
      notStarted: env("STATUS_NOT_STARTED", "Not started"),
      inProgress: env("STATUS_IN_PROGRESS", "Active Unclaimed"),
      claimed: env("STATUS_CLAIMED", "Active Claimed"),
      hold: env("STATUS_HOLD", "Hold"),
      done: env("STATUS_DONE", "Done"),
      prClosedUnmerged: env("STATUS_PR_CLOSED_UNMERGED", "Abandoned"),
    },
    tagsOnlyMapped: env("TAGS_ONLY_MAPPED", "true") === "true",
    kindTags: env("KIND_TAGS", "true") === "true",
    tagIssue: env("TAG_ISSUE", "Issue"),
    tagPr: env("TAG_PR", "PR"),
    respectManualStatus: env("RESPECT_MANUAL_STATUS", "true") === "true",
    titlePrefix: env("TITLE_PREFIX", "{repo}#{number} "),
    userMap: readJson(env("USER_MAP_PATH", "config/user-map.json"), {}),
    labelMap: readJson(env("LABEL_MAP_PATH", "config/label-map.json"), {}),
  };
}

export function normalize({ node, repoFullName, kind }) {
  const isPr = kind === "pr";
  return {
    kind,
    title: node.title,
    url: node.html_url,
    number: node.number,
    repo: repoFullName,
    state: node.state,
    merged: isPr ? Boolean(node.merged || node.merged_at || node.pull_request?.merged_at) : false,
    draft: Boolean(node.draft),
    labels: (node.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
    assignees: (node.assignees || []).map((u) => u.login),
    author: node.user?.login,
    reviewers: (node.requested_reviewers || []).map((u) => u.login),
    dueOn: node.milestone?.due_on || null,
  };
}

// Anything outside this set was put on an open page by a person. Hold is ours on a
// PR only, where it means "draft"; on an issue it is a deliberate park.
function syncOwnedOpenStatuses(item, cfg) {
  const owned = [cfg.status.notStarted, cfg.status.inProgress];
  if (item.kind === "pr") owned.push(cfg.status.hold);
  return owned.filter(Boolean).map((n) => n.toLowerCase());
}

export function decideStatus(item, ctx, cfg) {
  const { isNew = false, currentStatus = null } =
    typeof ctx === "boolean" ? { isNew: ctx } : ctx || {};

  if (item.state === "closed") {
    if (item.kind === "pr" && !item.merged) return cfg.status.prClosedUnmerged;
    return cfg.status.done;
  }

  const wanted = item.kind === "pr" && item.draft ? cfg.status.hold : cfg.status.inProgress;

  if (isNew || !cfg.respectManualStatus) return wanted;
  if (!currentStatus) return wanted;
  if (syncOwnedOpenStatuses(item, cfg).includes(currentStatus.toLowerCase())) return wanted;
  return null;
}

function peopleValue(logins, userMap) {
  const ids = [...new Set(logins.map((l) => userMap[l]).filter(Boolean))];
  return ids.map((id) => ({ object: "user", id }));
}

function tagValues(item, cfg) {
  const out = [];
  if (cfg.kindTags) out.push(item.kind === "pr" ? cfg.tagPr : cfg.tagIssue);
  for (const label of item.labels) {
    const mapped = cfg.labelMap[label];
    if (mapped) out.push(...[].concat(mapped));
    else if (!cfg.tagsOnlyMapped) out.push(label);
  }
  return [...new Set(out)];
}

// The API cannot create status options, so an unknown name is a hard 400. Match the
// live schema by name, then case-insensitively, then by group.
function resolveStatusName(def, wanted) {
  const options = def?.status?.options || [];
  const groups = def?.status?.groups || [];

  const exact = options.find((o) => o.name === wanted);
  if (exact) return exact.name;

  const lower = String(wanted).toLowerCase();
  const insensitive = options.find((o) => o.name.toLowerCase() === lower);
  if (insensitive) return insensitive.name;

  const group = groups.find((g) => g.name.toLowerCase() === lower);
  if (group) {
    const first = (group.option_ids || []).map((id) => options.find((o) => o.id === id)).find(Boolean);
    if (first) return first.name;
  }

  return null;
}

export function buildProperties({ item, schema, titleProp, cfg, isNew, currentStatus = null }) {
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
    if (value === null) return;
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

  const wantedStatus = decideStatus(item, { isNew, currentStatus }, cfg);
  const statusDef = cfg.props.status ? schema.properties[cfg.props.status] : undefined;
  let statusName = wantedStatus;
  if (wantedStatus && statusDef?.type === "status") {
    statusName = resolveStatusName(statusDef, wantedStatus);
    if (!statusName) skipped.push(`${cfg.props.status} (option "${wantedStatus}" not on database)`);
  }
  set(cfg.props.status, {
    status: statusName ? { status: { name: statusName } } : null,
    select: statusName ? { select: { name: statusName } } : null,
  });

  const tags = tagValues(item, cfg);
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
