// Crashlytics 이슈 뷰어 - firebase CLI(`firebase login`) 인증 사용
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = Number(process.env.PORT) || 5177;
const CRASHLYTICS = "https://firebasecrashlytics.googleapis.com/v1alpha";
const FIREBASE = "https://firebase.googleapis.com/v1beta1";

function intervalParams(days) {
  return {
    "filter.interval.start_time": new Date(Date.now() - days * 86400000).toISOString(),
    "filter.interval.end_time": new Date().toISOString(),
  };
}

function projectNumber(appId) {
  return appId.split(":")[1];
}

// firebase CLI의 OAuth 클라이언트 (firebase-tools 소스에 공개된 값)
const FIREBASE_CLI_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
const FIREBASE_CLI_CONFIG = path.join(os.homedir(), ".config/configstore/firebase-tools.json");
let cachedToken = { value: null, expiresAt: 0 };

function firebaseCliConfig() {
  try {
    return JSON.parse(fs.readFileSync(FIREBASE_CLI_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

async function accessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt - 60000) return cachedToken.value;
  const refreshToken = firebaseCliConfig().tokens?.refresh_token;
  if (!refreshToken) throw new Error("터미널에서 `firebase login`을 먼저 실행하세요.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`토큰 갱신 실패(${body.error || res.status}). 터미널에서 \`firebase login --reauth\`를 실행하세요.`);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.value;
}

async function gapi(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) cachedToken = { value: null, expiresAt: 0 };
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return body;
}

const routes = {
  async "/api/me"() {
    return { email: firebaseCliConfig().user?.email || null };
  },

  async "/api/projects"(req) {
    const { results = [] } = await gapi(`${FIREBASE}/projects?pageSize=100`);
    return results.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      displayName: p.displayName,
    }));
  },

  async "/api/apps"(req, q) {
    const project = q.get("project");
    const platform = q.get("platform");
    if (!project || !platform) throw new Error("project와 platform이 필요합니다.");
    const endpoint = platform === "ios" ? "iosApps" : "androidApps";
    const { apps = [] } = await gapi(`${FIREBASE}/projects/${project}/${endpoint}?pageSize=100`);
    return apps.map((a) => ({
      appId: a.appId,
      name: a.displayName || (platform === "ios" ? a.bundleId : a.packageName),
      platform,
    }));
  },

  async "/api/issues"(req, q) {
    const appId = q.get("appId");
    const days = Math.min(Number(q.get("days")) || 7, 90);
    const params = new URLSearchParams({ page_size: "50", ...intervalParams(days) });
    const body = await gapi(`${CRASHLYTICS}/projects/${projectNumber(appId)}/apps/${appId}/reports/topIssues?${params}`);
    return (body.groups || []).map((g) => ({
      id: g.issue?.id,
      title: g.issue?.title,
      subtitle: g.issue?.subtitle,
      errorType: g.issue?.errorType,
      events: Number(g.metrics?.[0]?.eventsCount || 0),
      users: Number(g.metrics?.[0]?.impactedUsersCount || 0),
    }));
  },

  async "/api/issue"(req, q) {
    const appId = q.get("appId");
    const issueId = q.get("issueId");
    const days = Math.min(Number(q.get("days")) || 7, 90);

    const issueDetail = await gapi(`${CRASHLYTICS}/projects/${projectNumber(appId)}/apps/${appId}/issues/${issueId}`);

    const events = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        page_size: String(Math.min(100 - events.length, 100)),
        ...intervalParams(days),
        "filter.issue.id": issueId,
      });
      if (pageToken) params.set("page_token", pageToken);
      const body = await gapi(`${CRASHLYTICS}/projects/${projectNumber(appId)}/apps/${appId}/events?${params}`);
      events.push(...(body.events || []));
      pageToken = body.nextPageToken;
    } while (pageToken && events.length < 100);

    return {
      issue: {
        id: issueDetail.id,
        title: issueDetail.title,
        subtitle: issueDetail.subtitle,
        errorType: issueDetail.errorType,
        state: issueDetail.state,
      },
      events: events.map((e) => ({
        eventId: e.eventId,
        eventTime: e.eventTime,
        version: e.version?.displayName,
        device: e.device?.displayName,
        os: e.operatingSystem?.displayName,
        logs: (e.logs || []).map((l) => ({ time: l.logTime, message: l.message })),
      })),
    };
  },
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") return res.end();

    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const data = await route(req, url.searchParams, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Crashlytics 이슈 뷰어: http://localhost:${PORT}`));
