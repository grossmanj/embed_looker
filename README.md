# embed-looker-cloud-run

Production-ready Node.js 20 + Express app that embeds Looker dashboards on Google Cloud Run using server-side cookieless embed tokens.

## URL behavior

- `https://<cloud-run-url>/1327` loads Looker dashboard `1327`
- `https://<cloud-run-url>/123` loads Looker dashboard `123`
- `https://<cloud-run-url>/d/production-tv` loads Looker dashboard `1200`
- `https://<cloud-run-url>/kiosk/kflax` loads the KF LaxTV ChromeOS kiosk shell
- `https://<cloud-run-url>/kiosk/fsg-sales/` loads the FSG Sales ChromeOS kiosk shell
- `https://<cloud-run-url>/` loads default dashboard `1327`

The backend only builds embed URLs in this fixed format:

- `https://nordward.cloud.looker.com/embed/dashboards/<dashboardId>`

No Looker credentials are exposed to the browser.

## API endpoints

- `GET /healthz` -> `{"ok": true}`
- `GET /api/embed-url/:dashboardRef` -> `{"url":"<embed_login_url>","dashboardId":"<id>","clientSessionId":"<id>"}` (`clientSessionId` is auto-generated for manual testing if omitted)
- `GET /api/embed-tokens/:dashboardRef` -> `{"api_token":"...","navigation_token":"..."}`
- `GET /api/kiosk-config/:kioskRef` -> non-secret kiosk display configuration

`dashboardRef` can be a numeric dashboard ID or a configured alias such as `production-tv`.

## ChromeOS kiosk route

The current kiosk route is additive and does not change the existing dashboard URLs.

- KF LaxTV route: `/kiosk/kflax`
- Time zone: `Europe/Stockholm`
- Day shift: starts `06:00`, dashboard `1200`
- Night shift: starts `18:00`, dashboard `1305`
- Debug mode: `/kiosk/kflax?debug=1`
- Force a slot for testing: `/kiosk/kflax?debug=1&slot=day` or `/kiosk/kflax?debug=1&slot=night`

- FSG Sales route: `/kiosk/fsg-sales/`
- FSG Sales dashboard: `1218`
- FSG Sales auto-scroll: enabled, `240vh` iframe height, `18px/s`, 12-second pauses at top/bottom
- FSG Sales debug mode: `/kiosk/fsg-sales/?debug=1`

The kiosk shell reuses the same cookieless Looker embed APIs as the single-dashboard routes. It refreshes the active dashboard periodically, switches dashboards at configured shift boundaries, keeps separate client session IDs per dashboard, and can slowly scroll tall dashboards by rendering a taller iframe and moving the parent viewport.

## Static settings in code

To keep configuration simple, non-sensitive values are static in
`src/server.js` (`STATIC_LOOKER_SETTINGS`):

- Looker base URL (`https://nordward.cloud.looker.com`)
- embed path prefix (`/embed/dashboards`)
- default dashboard ID (`1327`)
- dashboard aliases, including `production-tv` -> dashboard `1200`
- embed user profile defaults (external user ID, first/last name)
- default embedded permissions include folder browsing and dashboard access
- default embedded models include both `kvalitetsfisk` and `fsgdk`
- `fsgdk` dashboards automatically add the FSG Sales group (`29`) to the embed session
- no `frame-ancestors` directive is sent by default because Mango Display's embed website validator can reject otherwise valid CSP allowlists; set `FRAME_ANCESTORS` only for non-Mango deployments that need an explicit iframe allowlist
- each browser dashboard session gets a unique Looker `external_user_id` derived from the dashboard ID and client session ID, so simultaneous Mango widgets do not terminate one another's Looker sessions

Environment-provided `LOOKER_MODELS` and `LOOKER_PERMISSIONS` extend these defaults instead of replacing them.

## Environment variables

Required:

- `LOOKER_CLIENT_ID`
- `LOOKER_CLIENT_SECRET`

Optional:

- `PORT` (default: `8080`)
- `LOOKER_SESSION_LENGTH` (default: `3600`)
- `EMBED_URL_RATE_LIMIT_MAX` (default: `30` requests/minute)
- `EMBED_TOKEN_RATE_LIMIT_MAX` (default: `300` requests/minute)
- `LOOKER_PERMISSIONS` (comma-separated extra permissions to add)
- `LOOKER_MODELS` (comma-separated extra Looker models to add)
- `LOOKER_EMBED_PATH_PREFIX` (default: `/embed/dashboards`)
- `FRAME_ANCESTORS` (comma-separated CSP `frame-ancestors`; omitted by default for Mango Display compatibility)
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

1. Verify the embedded session includes the Looker model names needed by the requested dashboard.
2. If needed, set `LOOKER_PERMISSIONS` explicitly with the required permissions for that dashboard.
3. Check Cloud Run logs for the `details` field now included in `Embed URL generation failed` events.

## Security notes

- Never commit real credentials or `.env` files.
- For production, store secrets in Google Secret Manager and inject them into Cloud Run.
- Use `.env` only for local development.
- Add your public Cloud Run domain to the Looker embed allowlist if required by your Looker instance.
- This app uses Looker cookieless embed flow to reduce dependence on third-party cookies in locked-down kiosk/signage environments.
- If Mango rejects the page as non-embeddable, verify the response does not include `X-Frame-Options` or `frame-ancestors`; Mango's validator can reject otherwise valid allowlists.

## How to use my rotated Looker service account credentials

- Service Account Name: REPLACE_WITH_SERVICE_ACCOUNT_NAME
- Client ID: REPLACE_WITH_ROTATED_CLIENT_ID
- Client Secret: REPLACE_WITH_ROTATED_CLIENT_SECRET

Operator instructions:

- Store them in Secret Manager for production.
- Use a local `.env` only for local development.
- Rotate immediately if they were ever pasted into chat, tickets, docs, or commits.
