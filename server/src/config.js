import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Load .env if present, using Node's built-in loader (no dotenv dependency).
// Real environment variables always win over the file.
try {
  const envFile = path.resolve(".env");
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envFile);
  }
} catch {
  // A malformed .env should not stop the process here; validation reports it.
}

/** Throws a readable error if required environment is missing or malformed. */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().default("./data/app.db"),

  // 32+ bytes of entropy, base64 or hex. Rotating this invalidates all access tokens.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  // Short-lived by design: it is never persisted client-side and is silently
  // renewed using the refresh token below.
  ACCESS_TOKEN_TTL: z.string().default("15m"),

  /**
   * How long a signed-in member stays signed in.
   *
   * The refresh token is single-use and ROTATED on every refresh, with its
   * expiry reset from that moment. So this is a sliding window: an active member
   * who opens the app at least once a year effectively never logs in again,
   * which is what a family app should do. Revoking a member kills every one of
   * their sessions immediately regardless of this value.
   */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(3650).default(365),

  // Comma-separated list of origins allowed to call the API from a browser.
  CORS_ORIGINS: z.string().default(""),

  // Set true behind a TLS-terminating proxy so secure cookies are honoured.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  /**
   * One-time secret required to create the very first account.
   *
   * This exists so REQUIRE_INVITE can stay true permanently. Without it you
   * would have to switch the invite gate off to claim the household, leaving a
   * window in which anyone who finds the URL first becomes the owner.
   */
  SETUP_TOKEN: z.string().min(16).optional(),

  // Legacy bootstrap switch. Leave true in production; prefer SETUP_TOKEN.
  REQUIRE_INVITE: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Extra throttle on credential endpoints, per IP.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(15 * 60 * 1000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  port: env.PORT,
  host: env.HOST,
  databasePath: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET,
  accessTokenTtl: env.ACCESS_TOKEN_TTL,
  refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  trustProxy: env.TRUST_PROXY,
  setupToken: env.SETUP_TOKEN ?? null,
  requireInvite: env.REQUIRE_INVITE,
  authRateLimit: { max: env.AUTH_RATE_LIMIT_MAX, windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS },
  corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
};

if (config.isProd && config.jwtSecret === "change-me-change-me-change-me-change-me32") {
  console.error("\nRefusing to start: JWT_SECRET is still the example value.\n");
  process.exit(1);
}
