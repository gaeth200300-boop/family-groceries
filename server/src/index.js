import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { HttpError } from "./auth.js";
import { authRouter } from "./routes/auth.js";
import { listsRouter } from "./routes/lists.js";
import { pushRouter } from "./routes/push.js";

export function createApp() {
  const app = express();

  // Behind a TLS-terminating proxy (Fly, Render, nginx) so rate limiting and
  // secure cookies see the real client IP and protocol.
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          // The app is a single static HTML file with inline scripts and two
          // pinned CDN libraries. Serving it from this origin means these have
          // to be allowed explicitly; every string the app renders from data is
          // escaped in index.html.
          "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          // The app is packaged inside the binary; no remote script is needed.
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'"],
          "worker-src": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          // Kept off so the same app can be opened over plain HTTP on the
          // local machine as well as HTTPS through the tunnel.
          "upgrade-insecure-requests": null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Native apps send no Origin; browsers must match the allowlist.
        if (!origin) return cb(null, true);
        if (config.corsOrigins.length === 0) return cb(null, false);
        cb(null, config.corsOrigins.includes(origin));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.use(express.json({ limit: "3mb" })); // base64 receipt/product images
  app.use(cookieParser());

  // Initialize the schema eagerly so a bad DB path fails at boot, not on first request.
  getDb();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "family-groceries", time: new Date().toISOString() });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", listsRouter);
  app.use("/api", pushRouter);

  app.use("/api", (_req, res) => res.status(404).json({ error: "not_found", message: "No such endpoint" }));

  /* --------------------------------------------------------- PWA + mobile
   * Serving www from the API process gives the phone and the desktop one HTTPS
   * origin for the app, the session cookie, the service worker and push. The
   * small injected config file tells api.js to talk to the origin it was
   * loaded from instead of asking the user to type a server URL.
   */
  const wwwDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "www");

  app.get("/fg-config.js", (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    res
      .type("application/javascript")
      .set("Cache-Control", "no-store")
      .send(`window.FG_API_BASE = ${JSON.stringify(origin)};\n`);
  });

  app.use(
    express.static(wwwDir, {
      extensions: ["html"],
      setHeaders(res, filePath) {
        // A stale shell or service worker would keep an old build on phones.
        if (/(?:index\.html|sw\.js)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );

  // Serve a privacy-policy page if one is bundled, so the App Store URL can point here.
  const publicDir = path.resolve("public");
  if (fs.existsSync(publicDir)) {
    app.use("/legal", express.static(publicDir, { extensions: ["html"] }));
  }

  // Client-side routes (if any) fall back to the app shell.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(wwwDir, "index.html"));
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if (err?.name === "ZodError") {
      const first = err.issues?.[0];
      return res.status(400).json({
        error: "validation_failed",
        message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid input",
      });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "payload_too_large", message: "Upload is too large" });
    }
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "bad_json", message: "Request body is not valid JSON" });
    }
    console.error("[unhandled]", err);
    res.status(500).json({ error: "server_error", message: "Something went wrong" });
  });

  return app;
}

/* Entry point when run directly (works with relative paths and non-ASCII paths). */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const app = createApp();
  app.listen(config.port, config.host, () => {
    console.log(`family-groceries API listening on http://${config.host}:${config.port} [${config.env}]`);
  });
}
