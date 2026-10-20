const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/giu;
const MAX_DEPTH = 8;

function unescapeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function addUrl(out, value) {
  const text = unescapeHtml(value).trim();
  if (!text) return;
  for (const match of text.match(URL_PATTERN) ?? []) {
    const url = match.replace(/[),.;!?]+$/u, "");
    if (url) out.add(url);
  }
}

function walk(value, out, depth = 0) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    addUrl(out, value);
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        walk(JSON.parse(trimmed), out, depth + 1);
      } catch {
        // Not JSON; the URL scan above is enough.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const owner = value.uin ?? value.hostuin ?? value.hostUin ?? value.owner;
  const tid = value.tid ?? value.topicId;
  if (owner && tid && /^\d+$/u.test(String(owner))) {
    out.add(`https://user.qzone.qq.com/${String(owner)}/mood/${String(tid)}`);
  }
  for (const item of Object.values(value)) walk(item, out, depth + 1);
}

export function collectLinkStrings(value) {
  const out = new Set();
  walk(value, out);
  return [...out];
}

export function parseQzonePostLink(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith("qzone.qq.com")) return null;

  let owner = "";
  let tid = "";
  const mood = url.pathname.match(/^\/(\d+)\/mood\/([A-Za-z0-9_-]+)/u);
  if (mood) {
    owner = mood[1];
    tid = mood[2];
  }
  const queryOwner =
    url.searchParams.get("uin") ??
    url.searchParams.get("hostuin") ??
    url.searchParams.get("hostUin") ??
    url.searchParams.get("owner");
  const queryTid =
    url.searchParams.get("tid") ??
    url.searchParams.get("topicId") ??
    url.searchParams.get("topicid");
  if (!owner && queryOwner && /^\d+$/u.test(queryOwner)) owner = queryOwner;
  if (!tid && queryTid && /^[A-Za-z0-9_-]+$/u.test(queryTid)) tid = queryTid;
  if (!owner || !tid) return null;
  return {
    owner,
    tid,
    url: `https://user.qzone.qq.com/${owner}/mood/${tid}`,
  };
}

export function parseQzonePostLinks(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const parsed = parseQzonePostLink(value);
    if (!parsed) continue;
    const key = `${parsed.owner}_${parsed.tid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

export function extractQzonePostLinks(...values) {
  const links = new Set();
  for (const value of values) {
    for (const link of collectLinkStrings(value)) links.add(link);
  }
  return parseQzonePostLinks([...links]);
}
