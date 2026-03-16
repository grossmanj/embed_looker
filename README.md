# embed-looker-cloud-run

Production-ready Node.js 20 + Express app that serves a public webpage and securely embeds one configured Looker dashboard on Google Cloud Run.

## What this repo does

- Serves a public home page from Express.
- Exposes `GET /healthz` returning `{"ok":true}`.
- Exposes `GET /api/embed-url` that:
  - authenticates to Looker with `LOOKER_CLIENT_ID` and `LOOKER_CLIENT_SECRET`
  - requests a signed embed URL from Looker
  - returns `{"url":"<signed_url>"}`
- Uses one fixed embed target path from `LOOKER_EMBED_TARGET_PATH` (no user-supplied URL input).
- Protects `GET /api/embed-url` with rate limiting and `helmet`.
- Keeps Looker secrets server-side only.

## Project structure

- `src/server.js`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `package.json`
- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `.env.example`

## Environment variables

Required:

- `LOOKER_BASE_URL`
- `LOOKER_CLIENT_ID`
- `LOOKER_CLIENT_SECRET`
- `LOOKER_EMBED_TARGET_PATH` (example: `/embed/dashboards/12`)
- `LOOKER_EXTERNAL_USER_ID`
- `LOOKER_FIRST_NAME`
- `LOOKER_LAST_NAME`
- `LOOKER_PERMISSIONS` (comma-separated)
- `LOOKER_MODELS` (comma-separated)
- `LOOKER_GROUP_IDS` (comma-separated integers, can be blank)
- `LOOKER_USER_ATTRIBUTES_JSON` (JSON object string, example: `{}`)
- `PORT`

Optional:

- `LOOKER_SESSION_LENGTH` (seconds, default `3600`)
- `EMBED_URL_RATE_LIMIT_MAX` (requests per minute, default `30`)

## Local development

1. Install Node.js 20.
2. Copy env file:
   - `cp .env.example .env`
3. Fill `.env` with your Looker values.
4. Install dependencies:
   - `npm install`
5. Run:
   - `npm start`
6. Open:
   - [http://localhost:8080](http://localhost:8080)

## Deploy to Cloud Run

Example values:

- `PROJECT_ID=your-gcp-project-id`
- `REGION=us-central1`
- `SERVICE=embed-looker-web`
- `IMAGE=gcr.io/$PROJECT_ID/$SERVICE`
- `RUNTIME_SA=cloud-run-embed-looker@$PROJECT_ID.iam.gserviceaccount.com`

Build and push image:

```bash
gcloud builds submit --tag "$IMAGE"
```

Create secrets (example):

```bash
printf '%s' 'https://your-looker-instance.example.com' | gcloud secrets create LOOKER_BASE_URL --data-file=- --replication-policy=automatic
printf '%s' 'REPLACE_WITH_ROTATED_CLIENT_ID' | gcloud secrets create LOOKER_CLIENT_ID --data-file=- --replication-policy=automatic
printf '%s' 'REPLACE_WITH_ROTATED_CLIENT_SECRET' | gcloud secrets create LOOKER_CLIENT_SECRET --data-file=- --replication-policy=automatic
printf '%s' '/embed/dashboards/12' | gcloud secrets create LOOKER_EMBED_TARGET_PATH --data-file=- --replication-policy=automatic
printf '%s' 'public-dashboard-viewer' | gcloud secrets create LOOKER_EXTERNAL_USER_ID --data-file=- --replication-policy=automatic
printf '%s' 'Public' | gcloud secrets create LOOKER_FIRST_NAME --data-file=- --replication-policy=automatic
printf '%s' 'Viewer' | gcloud secrets create LOOKER_LAST_NAME --data-file=- --replication-policy=automatic
printf '%s' 'see_looks,see_user_dashboards,access_data' | gcloud secrets create LOOKER_PERMISSIONS --data-file=- --replication-policy=automatic
printf '%s' 'your_model' | gcloud secrets create LOOKER_MODELS --data-file=- --replication-policy=automatic
printf '%s' '' | gcloud secrets create LOOKER_GROUP_IDS --data-file=- --replication-policy=automatic
printf '%s' '{}' | gcloud secrets create LOOKER_USER_ATTRIBUTES_JSON --data-file=- --replication-policy=automatic
```

Allow the Cloud Run runtime service account to read secrets:

```bash
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/secretmanager.secretAccessor"
```

Deploy:

```bash
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --service-account "$RUNTIME_SA" \
  --allow-unauthenticated \
  --set-env-vars "PORT=8080" \
  --set-secrets "LOOKER_BASE_URL=LOOKER_BASE_URL:latest,LOOKER_CLIENT_ID=LOOKER_CLIENT_ID:latest,LOOKER_CLIENT_SECRET=LOOKER_CLIENT_SECRET:latest,LOOKER_EMBED_TARGET_PATH=LOOKER_EMBED_TARGET_PATH:latest,LOOKER_EXTERNAL_USER_ID=LOOKER_EXTERNAL_USER_ID:latest,LOOKER_FIRST_NAME=LOOKER_FIRST_NAME:latest,LOOKER_LAST_NAME=LOOKER_LAST_NAME:latest,LOOKER_PERMISSIONS=LOOKER_PERMISSIONS:latest,LOOKER_MODELS=LOOKER_MODELS:latest,LOOKER_GROUP_IDS=LOOKER_GROUP_IDS:latest,LOOKER_USER_ATTRIBUTES_JSON=LOOKER_USER_ATTRIBUTES_JSON:latest"
```

## Security notes

- Never expose Looker secrets in frontend code.
- Never commit real credentials or `.env` files.
- For production, secrets must come from Google Secret Manager and be injected into Cloud Run.
- Use `.env` only for local development.
- Add your deployed public site domain to the Looker embed allowlist (if your Looker instance requires domain allowlisting for embeds).

## How to use my rotated Looker service account credentials

- Service Account Name: REPLACE_WITH_SERVICE_ACCOUNT_NAME
- Client ID: REPLACE_WITH_ROTATED_CLIENT_ID
- Client Secret: REPLACE_WITH_ROTATED_CLIENT_SECRET

Operator instructions:

- Store these values in Google Secret Manager for production Cloud Run deployments.
- Use a local `.env` file only for local development.
- Rotate credentials immediately if they were ever pasted into chat, tickets, docs, or commits.
