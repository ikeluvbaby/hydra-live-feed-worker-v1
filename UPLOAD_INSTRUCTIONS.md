# Upload Instructions

Delete the old broken `netlify/functions` single-name folder first.

Then upload the contents of this ZIP into `HYDRA_LIVE_FEED_WORKER_V1`.

You should see:

```text
HYDRA_LIVE_FEED_WORKER_V1/
  netlify/
    README.md
    functions/
      hydra-live-feed-worker.js
  netlify.toml
  package.json
```

Netlify settings:

- Base directory: `HYDRA_LIVE_FEED_WORKER_V1`
- Functions directory: `netlify/functions`
