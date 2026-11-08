
 // SharkByte: one small server for the whole app. No framework needed.
 //   /                static front-end (public/)
 //   /advisor.html    degree-audit chat
 //   /api/*           advisor + scheduler (API keys stay here, never in the browser)

const http = require("http");
const fs = require("fs");
const path = require("path");

require("./src/env").loadEnv();

const { HttpError } = require("./src/errors");
const advisor = require("./src/advisor");
const scheduler = require("./src/scheduler");

// Gemini Schedule Master integration
const {
  buildScheduleFromAdvisor
} = require("./src/gemini-agent/scheduleBridge");

const PUBLIC = path.join(__dirname, "public");
const MAX_BODY = 100 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

// Routes that cost money (AI calls) are rate limited per client.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = Number(process.env.RATE_LIMIT_PER_10_MIN || 60);

const hits = new Map();

function rateLimited(req) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";

  const now = Date.now();

  const recent = (hits.get(ip) || []).filter(
    (t) => now - t < WINDOW_MS
  );

  recent.push(now);
  hits.set(ip, recent);

  return recent.length > MAX_HITS;
}

setInterval(() => {
  const now = Date.now();

  for (const [ip, list] of hits) {
    const recent = list.filter(
      (t) => now - t < WINDOW_MS
    );

    recent.length
      ? hits.set(ip, recent)
      : hits.delete(ip);
  }
}, WINDOW_MS).unref();

// API routes
const AI_ROUTES = {
  "POST /api/chat": (b) => advisor.chat(b),

  "POST /api/ask": (b) => advisor.ask(b),

  // Original schedule builder
  "POST /api/schedule": (b) =>
    scheduler.generateSchedule(b),

  "POST /api/replan": (b) =>
    scheduler.replanSchedule(b && b.input, b && b.change),

  // Gemini Schedule Master
  // Receives dynamic JSON from frontend
  "POST /api/gemini/schedules": (b) =>
    buildScheduleFromAdvisor(b),
};

function send(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(obj));
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (c) => {
      size += c.length;

      if (size > MAX_BODY) {
        reject(new HttpError(413, "Request too large"));
        req.destroy();
        return;
      }

      chunks.push(c);
    });

    req.on("end", () => {
      try {
        resolve(
          JSON.parse(
            Buffer.concat(chunks).toString("utf8") || "{}"
          )
        );
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      req.url.split("?")[0]
    );
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/advisor") pathname = "/advisor.html";

  const full = path.resolve(PUBLIC, "." + pathname);

  if (
    full !== PUBLIC &&
    !full.startsWith(PUBLIC + path.sep)
  ) {
    res.writeHead(403);
    return res.end();
  }

  fs.readFile(full, (err, content) => {
    if (err) {
      res.writeHead(404, {
        "Content-Type": "text/plain"
      });

      return res.end("Not found");
    }

    const ext = path.extname(full).toLowerCase();

    // Pages and scripts are never cached
    const cache = [".html", ".js", ".css"].includes(ext)
      ? "no-cache"
      : "public, max-age=86400";

    res.writeHead(200, {
      "Content-Type":
        MIME[ext] || "application/octet-stream",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff"
    });

    res.end(content);
  });
}

async function handler(req, res) {
  try {
    const route =
      `${req.method} ${req.url.split("?")[0]}`;

    if (route === "GET /api/health") {
      return send(res, 200, {
        ok: true,
        swarmsKeySet: !!process.env.SWARMS_API_KEY,
        geminiKeySet: !!process.env.GEMINI_API_KEY
      });
    }

    if (route === "GET /api/targets") {
      return send(res, 200, advisor.listTargets());
    }

    if (AI_ROUTES[route]) {
      if (rateLimited(req)) {
        throw new HttpError(
          429,
          "Too many requests. Please wait a few minutes."
        );
      }

      return send(
        res,
        200,
        await AI_ROUTES[route](
          await readJSONBody(req)
        )
      );
    }

    if (req.url.startsWith("/api/")) {
      throw new HttpError(404, "Unknown API route");
    }

    if (
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      throw new HttpError(405, "Method not allowed");
    }

    serveStatic(req, res);

  } catch (err) {
    if (err instanceof HttpError) {
      return send(res, err.status, {
        error: err.message
      });
    }

    console.error(err);

    send(res, 500, {
      error: "Something went wrong on the server."
    });
  }
}

const createServer = () => http.createServer(handler);

module.exports = { createServer };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;

  createServer().listen(PORT, () => {
    console.log(
      `SharkByte running at http://localhost:${PORT}`
    );

    if (!process.env.SWARMS_API_KEY) {
      console.warn(
        "  ! SWARMS_API_KEY is not set: the AI advisor will not answer."
      );
    }

    if (!process.env.GEMINI_API_KEY) {
      console.warn(
        "  ! GEMINI_API_KEY is not set: AI-powered schedule features are unavailable."
      );
    }
  });
}
