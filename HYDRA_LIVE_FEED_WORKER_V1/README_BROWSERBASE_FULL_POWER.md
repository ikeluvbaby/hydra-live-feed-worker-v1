# HYDRA Live Feed Worker V1 — Browserbase Full Power

Replace only:
- `netlify/functions/hydra-live-feed-worker.js`
- `package.json`
- `netlify.toml`

Then deploy without cache.

Test URLs:
- `/.netlify/functions/hydra-live-feed-worker?selftest=1`
- `/.netlify/functions/hydra-live-feed-worker?bbtest=1`
- `/.netlify/functions/hydra-live-feed-worker?bbsearch=need%20car%20bad%20credit`
- `/.netlify/functions/hydra-live-feed-worker`

Target example:

```json
[
  {
    "name": "Hydra Cars Browserbase Search",
    "source_type": "browserbase_search",
    "query": "need car bad credit denied financing",
    "num_results": 5,
    "open_results": 3,
    "vertical_hint": "Cars"
  }
]
```

Force Browserbase URL extraction:

```json
[
  {
    "name": "Hydra Cars Browserbase URL Test",
    "source_type": "browserbase_url",
    "url": "https://example.com",
    "vertical_hint": "Cars"
  }
]
```
