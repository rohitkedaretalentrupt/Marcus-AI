# Deploying to DigitalOcean

DigitalOcean hosts the **application** (Docker on a Droplet) and the
**database** (Managed PostgreSQL). **All files** — uploaded resumes, client
templates and generated documents — live only in a private **Cloudflare R2**
bucket. Nothing is stored on the Droplet's disk.

> Status: this runbook matches the repository's `Dockerfile` and startup
> checks, but it has **not been executed against a real DigitalOcean
> account** yet, and the Docker image has not been built in this
> environment (Docker was not installed). Do a staging run first.

## 1. Prerequisites

| Service                         | What to create                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| DigitalOcean Managed PostgreSQL | PostgreSQL 17 cluster, a database `resume_app` and a user. Add the Droplet as a **trusted source**. Use the `sslmode=require` URL. |
| DigitalOcean Droplet            | Ubuntu LTS, ≥ 2 GB RAM (document parsing and DOCX rendering run in-process), Docker Engine installed, firewall: 22, 80, 443 only.  |
| Domain                          | An A record for e.g. `resumes.example.com` pointing to the Droplet.                                                                |
| Cloudflare R2                   | A **private** bucket + a bucket-scoped API token (Object Read & Write) + CORS policy for your HTTPS origin (README → "R2 setup").  |
| MiMo                            | An API key for MiMo v2.6 Pro (README → "AI assistant").                                                                            |

## 2. Production environment file

Create `/etc/resume-formatter/app.env` on the Droplet (owner root, mode
`600`). Never commit it, never bake it into the image.

```bash
NODE_ENV=production
APP_URL=https://resumes.example.com
DATABASE_URL=postgresql://USER:PASSWORD@HOST:25060/resume_app?sslmode=require
AUTH_SECRET=<openssl rand -base64 32>

AI_PROVIDER=mimo
AI_API_KEY=<MiMo key>
# AI_MODEL=mimo-v2.6-pro  AI_TIMEOUT_MS=60000  AI_MAX_OUTPUT_TOKENS=4096

STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=<Cloudflare account id>
R2_BUCKET_NAME=<bucket>
R2_ACCESS_KEY_ID=<token access key id>
R2_SECRET_ACCESS_KEY=<token secret>

# Optional
# STORAGE_CLEANUP=true
```

Do **not** set `TEST_DATABASE_URL` or `ALLOW_DISABLED_SERVICES` in production.
In production the server **refuses to start** (exit code 1, with a log line
naming the missing variables — never their values) when:

- a required variable is missing or invalid (`DATABASE_URL`, `AUTH_SECRET` ≥ 32
  characters, `APP_URL` must be a URL, …), or
- the AI provider or R2 storage is not configured.

## 3. Build and publish the image

On a build machine (or CI) with Docker:

```bash
docker build --build-arg NEXT_PUBLIC_APP_NAME="Marcus AI" -t registry.digitalocean.com/<registry>/resume-formatter:<version> .
docker build --target migrator -t registry.digitalocean.com/<registry>/resume-formatter-migrator:<version> .
doctl registry login
docker push registry.digitalocean.com/<registry>/resume-formatter:<version>
docker push registry.digitalocean.com/<registry>/resume-formatter-migrator:<version>
```

The runtime image is the Next.js standalone server running as the non-root
user `nextjs` (uid 1001) on port 3000, with a Docker `HEALTHCHECK` on
`/api/health`. It contains no `.env`, tests or source maps of secrets
(`.dockerignore`).

## 4. Release (each deployment)

```bash
# 1. Apply database migrations (non-destructive `prisma migrate deploy`).
docker run --rm --env-file /etc/resume-formatter/app.env \
  registry.digitalocean.com/<registry>/resume-formatter-migrator:<version>

# 2. Start the new app container (stop the old one first; single instance).
docker stop resume-formatter && docker rm resume-formatter
docker run -d --name resume-formatter --restart unless-stopped \
  --env-file /etc/resume-formatter/app.env -p 127.0.0.1:3000:3000 \
  registry.digitalocean.com/<registry>/resume-formatter:<version>

# 3. Verify.
curl -fsS http://127.0.0.1:3000/api/health          # liveness  → {"data":{"status":"ok"}}
curl -fsS http://127.0.0.1:3000/api/health/ready    # readiness → database ok, ai/storage configured
docker logs resume-formatter | grep "Server configuration verified"
```

Never run `prisma migrate reset` or `db push` against production. Migrations
are additive; roll back by deploying the previous image (the schema stays
compatible).

## 5. HTTPS reverse proxy

Terminate TLS in front of the container (HTTPS is required for secure cookies,
HSTS and PWA installation). Example with Caddy (`/etc/caddy/Caddyfile`):

```
resumes.example.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 2MB   # API bodies are JSON only; files go directly to R2
    }
}
```

The proxy must overwrite `X-Forwarded-For` (Caddy does) — rate limits key on
the client IP.

## 6. Operations

- **Single instance.** Background work (resume extraction, template analysis,
  formatting) and rate-limit counters live in the app process. Run exactly
  one app container. A restart loses in-flight jobs; they become retryable
  (QUEUED/PROCESSING older than 10 minutes) from the UI.
- **Cleanup.** An hourly in-process task removes abandoned, failed and deleted
  upload objects from R2 (README → "Storage cleanup").
- **Logs** are JSON lines on stdout/stderr (`docker logs`). They never contain
  API keys, R2 credentials, signed URLs, prompts, resume text or
  AI output.
- **Backups.** Managed PostgreSQL daily backups cover metadata. R2 objects are
  not versioned by default; enable R2 bucket versioning or a lifecycle policy
  only if your retention rules require it (do not add an expiry rule to the
  whole bucket — it would delete users' files).
- **Secrets rotation.** Rotating `AUTH_SECRET` signs everyone out. Rotate the R2
  token and MiMo key by updating `app.env` and restarting the container.

## 7. Release checklist

- [ ] `npm run check` and `npm run build` pass on the release commit
- [ ] Image built; migrator run succeeded
- [ ] `/api/health/ready` returns `ready` with `ai: configured`, `storage: configured`
- [ ] `npm run test:live` passed against **staging** (real MiMo + R2, synthetic data)
- [ ] Sign up, upload a synthetic resume, add a template, format, download — on a phone
- [ ] No test users in the production database
