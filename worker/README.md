# Fashion Studio Runway — backend (Cloudflare Worker)

Small API the game calls for:
- **Share codes**: `POST /share` saves an outfit and returns a code like `HIMAL-57` (kept 30 days); `GET /share/:code` fetches it.
- **Announcer**: `POST /narrate` sends the model snapshot(s) to Claude (`claude-opus-5-5`, low effort, server-side refusal fallback on) for a short kid-friendly runway introduction, then ElevenLabs reads it aloud.
- `GET /health` reports what is configured.

API keys live only here (as Cloudflare secrets), never in the web page.

## Spending guards
- At most `DAILY_NARRATIONS` announcer calls per day in total (default 80) and `PER_IP_NARRATIONS` per network (default 40).
- If Claude fails or declines, the game still gets a template introduction (no charge).
- Rough cost: ~2–3¢ per show for Claude + ElevenLabs characters (~400 per show).

## Run locally (no keys, no cost)
```bash
cp .dev.vars.example .dev.vars   # MOCK_AI=1
npm install
npm run dev                      # http://127.0.0.1:8787
```

## Deploy (one time)
1. Create a free Cloudflare account, then log in: `npx wrangler login`
2. Create the storage for share codes and paste the printed `id` into `wrangler.toml` (`REPLACE_WITH_KV_NAMESPACE_ID`):
   `npx wrangler kv namespace create SHARES`
3. Add the keys (each command asks you to paste the key):
   `npx wrangler secret put ANTHROPIC_API_KEY` (from console.anthropic.com)
   `npx wrangler secret put ELEVENLABS_API_KEY`
4. Put your ElevenLabs voice ID in `wrangler.toml` → `ELEVENLABS_VOICE_ID`.
5. `npm run deploy` — note the `https://fashion-studio-api.<you>.workers.dev` URL and set it as `API_BASE` in `../index.html`.

Switch the narrator to the cheaper model by setting `NARRATOR_MODEL = "claude-haiku-5-5"` in `wrangler.toml`.
