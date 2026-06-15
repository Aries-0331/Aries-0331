import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const README_PATH = process.env.README_PATH
  ? pathToFileURL(resolve(process.env.README_PATH))
  : new URL("../README.md", import.meta.url);
const START_MARKER = "<!-- PROFILE_ACTIVITY:START -->";
const END_MARKER = "<!-- PROFILE_ACTIVITY:END -->";

const config = {
  releaseRepos: parseReleaseRepos(
    process.env.RELEASE_REPOS ||
      "Aries-0331/x-toc,Aries-0331/bookmark-assistant"
  ),
  blogFeedUrl: process.env.BLOG_FEED_URL || "https://www.arieszhou.cn/rss.xml",
  postLimit: Number(process.env.POST_LIMIT || 6),
  titleMaxLength: Number(process.env.TITLE_MAX_LENGTH || 38),
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL || "https://api.github.com",
};

const token = process.env.GITHUB_TOKEN;

const [releases, posts] = await Promise.all([
  getReleases(config.releaseRepos, config.githubApiBaseUrl),
  getPosts(config.blogFeedUrl, config.postLimit),
]);

const block = renderBlock(releases, posts);
const readme = await readFile(README_PATH, "utf8");
const nextReadme = replaceBlock(readme, block);

if (nextReadme !== readme) {
  await writeFile(README_PATH, nextReadme);
}

function parseReleaseRepos(value) {
  return value
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean)
    .map((fullName) => {
      const [owner, repo] = fullName.split("/");
      if (!owner || !repo) {
        throw new Error(`Invalid repo in RELEASE_REPOS: ${fullName}`);
      }
      return { owner, repo };
    });
}

async function getReleases(repos, githubApiBaseUrl) {
  const releases = await Promise.all(
    repos.map(async ({ owner, repo }) => {
      const url = `${githubApiBaseUrl}/repos/${owner}/${repo}/releases?per_page=10`;
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Aries-0331-profile-updater",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (response.status === 404) {
        return [];
      }

      if (!response.ok) {
        throw new Error(
          `GitHub releases request failed for ${owner}/${repo}: ${response.status}`
        );
      }

      const releases = await response.json();

      const latestRelease = releases
        .filter((release) => !release.draft)
        .sort(
          (a, b) =>
            new Date(b.published_at || b.created_at) -
            new Date(a.published_at || a.created_at)
        )[0];

      if (!latestRelease) {
        return null;
      }

      return {
        title: `${repo} ${latestRelease.name || latestRelease.tag_name}`,
        url: latestRelease.html_url,
        date: formatDate(
          latestRelease.published_at || latestRelease.created_at
        ),
        sortDate: latestRelease.published_at || latestRelease.created_at,
      };
    })
  );

  return releases
    .filter(Boolean)
    .sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate));
}

async function getPosts(feedUrl, limit) {
  const response = await fetch(feedUrl, {
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "Aries-0331-profile-updater",
    },
  });

  if (!response.ok) {
    throw new Error(`Blog feed request failed: ${response.status}`);
  }

  const xml = await response.text();
  const entries = matchAll(
    xml,
    /<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi
  );

  return entries
    .map((entry) => {
      const isAtom = /^<entry\b/i.test(entry);
      const title = textContent(entry, "title");
      const url = isAtom ? atomLink(entry) : textContent(entry, "link");
      const rawDate =
        textContent(entry, "pubDate") ||
        textContent(entry, "published") ||
        textContent(entry, "updated");

      if (!title || !url) {
        return null;
      }

      return {
        title,
        url,
        date: formatDate(rawDate),
        sortDate: rawDate || "",
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate))
    .slice(0, limit);
}

function matchAll(value, pattern) {
  return Array.from(value.matchAll(pattern), (match) => match[0]);
}

function textContent(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  );
  if (!match) {
    return "";
  }

  return decodeXml(
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

function atomLink(xml) {
  const alternate = xml.match(
    /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*>/i
  );
  const anyLink = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return decodeXml((alternate || anyLink || [])[1] || "");
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString().slice(0, 10);
}

function renderBlock(releases, posts) {
  return `${START_MARKER}
<table width="100%" cellspacing="0" cellpadding="0" style="table-layout: fixed;">
  <tr>
    <th width="600px" align="left">Latest Releases</th>
    <th width="600px" align="left">Recent Posts</th>
  </tr>
  <tr>
    <td valign="top" style="word-break: break-word;">
${renderList(releases, "No releases found yet.")}
    </td>
    <td valign="top" style="word-break: break-word;">
${renderList(posts, "No posts found yet.")}
    </td>
  </tr>
</table>
${END_MARKER}`;
}

function renderList(items, emptyLabel = "No items found yet.") {
  if (items.length === 0) {
    return escapeHtml(emptyLabel);
  }

  const lines = items.map((item) => {
    const suffix = item.date ? ` - ${escapeHtml(item.date)}` : "";
    const title = truncateMiddle(item.title, config.titleMaxLength);
    return `• <a href="${escapeHtml(item.url)}">${escapeHtml(
      title
    )}</a>${suffix}`;
  });

  return lines.join("<br>");
}

function truncateMiddle(value, maxLength) {
  const text = String(value).trim();
  if (
    !Number.isFinite(maxLength) ||
    maxLength <= 0 ||
    text.length <= maxLength
  ) {
    return text;
  }

  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }

  const edgeLength = Math.floor((maxLength - 3) / 2);
  const headLength = maxLength - 3 - edgeLength;
  return `${text.slice(0, headLength)}...${text.slice(
    text.length - edgeLength
  )}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function replaceBlock(readme, block) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    return `${readme.trimEnd()}\n\n${block}\n`;
  }

  return `${readme.slice(0, start)}${block}${readme.slice(
    end + END_MARKER.length
  )}`;
}
