const API = "https://api.notion.com/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({ token, version = "2022-06-28", maxRetries = 4 }) {
  if (!token) throw new Error("NOTION_TOKEN is not set.");

  async function request(path, { method = "GET", body } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": version,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2 ** attempt) * 1000;
        console.warn(`Notion ${res.status} on ${method} ${path}; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          `Notion ${method} ${path} failed (${res.status} ${json.code || ""}): ${json.message || "unknown error"}`
        );
      }
      return json;
    }
  }

  return {
    request,
    getDatabase: (id) => request(`/databases/${id}`),
    queryDatabase: (id, body) => request(`/databases/${id}/query`, { method: "POST", body }),
    createPage: (body) => request("/pages", { method: "POST", body }),
    updatePage: (id, body) => request(`/pages/${id}`, { method: "PATCH", body }),
  };
}

/** The database's title property is not always called "Name". */
export function findTitleProp(schema) {
  const entry = Object.entries(schema.properties).find(([, v]) => v.type === "title");
  if (!entry) throw new Error("Database has no title property.");
  return entry[0];
}

/** Find a page by GitHub URL; the property may be `url` or `rich_text`. */
export async function findPageByUrl(client, databaseId, schema, urlProp, url) {
  const type = schema.properties[urlProp]?.type;
  if (!type) return null;

  let filter;
  if (type === "url") filter = { property: urlProp, url: { equals: url } };
  else if (type === "rich_text") filter = { property: urlProp, rich_text: { equals: url } };
  else return null;

  const res = await client.queryDatabase(databaseId, { filter, page_size: 1 });
  return res.results[0] || null;
}
