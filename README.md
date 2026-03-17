# embed-looker-cloud-run

Production-ready Node.js 20 + Express app that embeds Looker dashboards on Google Cloud Run using server-side signed URLs.

## URL behavior

- `https://<cloud-run-url>/1327` loads Looker dashboard `1327`
- `https://<cloud-run-url>/123` loads Looker dashboard `123`
- `https://<cloud-run-url>/` loads default dashboard `1327`

The backend only builds embed URLs in this fixed format:

- `https://nordward.cloud.looker.com/embed/dashboards/<dashboardId>`

No Looker credentials are exposed to the browser.

## API endpoints

- `GET /healthz` -> `{"ok": true}`
- `GET /api/embed-url/:dashboardId` -> `{"url":"<signed_url>","dashboardId":"<id>"}`

`dashboardId` must be numeric.

## Static settings in code

To keep configuration simple, non-sensitive values are static in
`src/server.js` (`STATIC_LOOKER_SETTINGS`):

- Looker base URL (`https://nordward.cloud.looker.com`)
- embed path prefix (`/embed/dashboards`)
- default dashboard ID (`1327`)
- embed user profile defaults (external user ID, first/last name)

`LOOKER_MODELS` is intentionally environment-based because it must match your
real Looker model names.

## Environment variables

Required:

- `LOOKER_CLIENT_ID`
- `LOOKER_CLIENT_SECRET`
- `LOOKER_MODELS` (comma-separated model names the embed user can access)

Optional:

- `PORT` (default: `8080`)
- `LOOKER_SESSION_LENGTH` (default: `3600`)
- `EMBED_URL_RATE_LIMIT_MAX` (default: `30` requests/minute)
- `LOOKER_PERMISSIONS` (defaults to `see_looks,see_user_dashboards,access_data`)
- `LOOKER_EMBED_PATH_PREFIX` (default: `/embed/dashboards`)
- `LOOKER_GROUP_IDS` (comma-separated integer IDs)
- `LOOKER_USER_ATTRIBUTES_JSON` (JSON object string)

## Local development

1. `cp .env.example .env`
2. Fill credentials in `.env`
3. `npm install`
4. `npm start`
5. Open `http://localhost:8080/1327` (or another dashboard ID)

## Deploy to Cloud Run

Example:

- `PROJECT_ID=your-gcp-project-id`
- `REGION=us-central1`
- `SERVICE=embed-looker-web`
- `IMAGE=gcr.io/$PROJECT_ID/$SERVICE`
- `RUNTIME_SA=cloud-run-embed-looker@$PROJECT_ID.iam.gserviceaccount.com`

Build:

```bash
gcloud builds submit --tag "$IMAGE"
```

Create secrets (production):

```bash
printf '%s' 'REPLACE_WITH_ROTATED_CLIENT_ID' | gcloud secrets create LOOKER_CLIENT_ID --data-file=- --replication-policy=automatic
printf '%s' 'REPLACE_WITH_ROTATED_CLIENT_SECRET' | gcloud secrets create LOOKER_CLIENT_SECRET --data-file=- --replication-policy=automatic
printf '%s' 'REPLACE_WITH_LOOKER_MODEL_NAME' | gcloud secrets create LOOKER_MODELS --data-file=- --replication-policy=automatic
```

Grant Secret Manager access to runtime service account:

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
  --set-secrets "LOOKER_CLIENT_ID=LOOKER_CLIENT_ID:latest,LOOKER_CLIENT_SECRET=LOOKER_CLIENT_SECRET:latest,LOOKER_MODELS=LOOKER_MODELS:latest"
```

## Troubleshooting `LOOKER_EMBED_FAILED`

If Cloud Run logs show `LOOKER_EMBED_FAILED`, the most common cause is a model/permission mismatch for the embed user.

1. Verify `LOOKER_MODELS` contains the exact Looker model names needed by dashboard `1327`.
2. If needed, set `LOOKER_PERMISSIONS` explicitly with the required permissions for that dashboard.
3. Check Cloud Run logs for the `details` field now included in `Embed URL generation failed` events.

## Security notes

- Never commit real credentials or `.env` files.
- For production, store secrets in Google Secret Manager and inject them into Cloud Run.
- Use `.env` only for local development.
- Add your public Cloud Run domain to the Looker embed allowlist if required by your Looker instance.
- Signed iframe embedding depends on browser cookie policy; strict third-party-cookie blocking (common in incognito) can still break authentication unless you allow third-party cookies for your Looker domain or move to Looker cookieless embed.

## How to use my rotated Looker service account credentials

- Service Account Name: REPLACE_WITH_SERVICE_ACCOUNT_NAME
- Client ID: REPLACE_WITH_ROTATED_CLIENT_ID
- Client Secret: REPLACE_WITH_ROTATED_CLIENT_SECRET

Operator instructions:

- Store them in Secret Manager for production.
- Use a local `.env` only for local development.
- Rotate immediately if they were ever pasted into chat, tickets, docs, or commits.
