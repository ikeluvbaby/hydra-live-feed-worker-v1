# HYDRA_LIVE_FEED_WORKER_V1

Browserbase + OpenAI live-feed worker for Hydra.

## What it does

`Browserbase -> public page/search extraction -> OpenAI leverage classifier -> Hydra webhook`

This worker is designed for signal discovery, not spam:
- no auto-DM
- no auto-comment
- no login automation
- no mass messaging
- no scraping private content
- owner review remains required inside Hydra

## Install

```bash
npm install
cp .env.example .env
```

Fill `.env`.

## Local test

```bash
npm run test:config
npm run start:local
```

## Vercel

1. Create GitHub repo.
2. Upload these files.
3. Import repo into Vercel.
4. Add environment variables from `.env.example`.
5. Deploy.
6. Visit:

```text
https://YOUR-VERCEL-APP.vercel.app/api/hydra-live-feed-worker?secret=YOUR_SECRET
```

## Feed targets

Best option: set `HYDRA_FEED_TARGETS_JSON` in Vercel env.

Example:

```json
[
  {
    "name": "Cars - buyer urgency",
    "type": "search",
    "query": "Ontario need car ASAP denied financing bad credit",
    "vertical": "Cars",
    "source_channel": "Browserbase Search",
    "enabled": true
  }
]
```

Target types:
- `search`: uses a search engine page inside Browserbase
- `url`: opens a public URL and extracts visible text

## Hydra webhook payload

The worker sends multiple compatible aliases:
- `raw_text`
- `raw_signal`
- `message`
- `vertical`
- `vertical_hint`
- `source_type`
- `source_channel`
- `source_name`
- `source_url`
- `primary_friction`
- `leverage_density`
- `conversion_probability`

## Production rule

Start with `HYDRA_DRY_RUN=true`. When logs look clean, set `HYDRA_DRY_RUN=false`.
Initial Vercel deployment trigger.
