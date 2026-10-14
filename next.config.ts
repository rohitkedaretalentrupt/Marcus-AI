import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy (production only: the dev server needs eval for
 * hot reloading). Scripts and styles come from our own origin; Next.js
 * injects inline bootstrap scripts, hence 'unsafe-inline' (no nonces yet).
 * The browser uploads directly to Cloudflare R2 with presigned URLs, so the
 * R2 S3 API hosts must be allowed for fetch/XHR. Downloads are navigations
 * and are not restricted by connect-src.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.r2.cloudflarestorage.com",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Baseline security headers (HSTS and CSP in production only). */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Microphone is allowed for our own origin only (future voice input).
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  ...(isProduction
    ? [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        // Sent only over HTTPS by browsers; harmless on http://localhost.
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image (set in the Dockerfile).
  // Left off locally so `npm start` works as usual.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  poweredByHeader: false,
  // Document parsers run only on the server; load them from node_modules
  // instead of bundling (pdf.js workers / dynamic requires).
  serverExternalPackages: ["unpdf", "mammoth"],
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
