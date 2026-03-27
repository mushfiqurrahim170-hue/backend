# Node.js Backend (Express)

This backend replaces the Supabase Edge Functions with a Node.js service.

## Required environment variables

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET`
- `GEMINI_API_KEY` (used by auto-signal generator when ported)
- `GEMINI_MODEL`
- `GEMINI_BASE_URL`
- `NEWS_API_KEY`
- `NEWS_ENDPOINT`
- `BACKEND_BASE_URL` (optional, used by cron jobs; defaults to `http://127.0.0.1:PORT`)
- `CRON_ENABLED` (optional, set to `false` to disable cron)
- `AUTO_SIGNAL_CRON` (optional, default `* * * * *`)
- `POSITION_MONITOR_CRON` (optional, default `* * * * *`)

## Run locally

```bash
cd backend
npm install
npm run dev
```

## Routes

- `POST /api/exchange-api` (ported)
- `POST /api/assign-admin-role` (ported)
- `POST /api/tradingview-webhook` (TODO: port)
- `POST /api/auto-signal-generator` (TODO: port)
- `POST /api/position-monitor` (TODO: port)

