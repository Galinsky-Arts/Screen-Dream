# ScreenDream

What Instrument Omega does for albums, ScreenDream does for film: you give it a concept, and it takes the film through 38 steps to a finished, mastered, subtitled film with a trailer, poster and release package. Every step is done by AI. Every step can be **Auto** (the default: the AI does it and a QC gate checks it) or **Manual** (you supply it, or pick and approve what the AI made).

## How it works

1. **New film.** Write the concept (or **Import from Omega** to pull a concept album's seed fields), fill in any targets, and set the 38 toggles. All are Auto unless you change them. Global switches: quality tier, scope (full film, or plan only), render only the first N scenes, budget cap, "notify me" previews and rehearsal.
2. **The pipeline** runs in the background in seven stages:

| Stage | Steps |
|---|---|
| Development | T1 logline · T2 structure · T3 treatment · T4 outline · T5 screenplay (Fountain) · T6 critics and revisions (up to 3 rounds, with a clearance pass) · T7 title |
| World building | T8 characters · T10 casting · T15 look book · T9 character design (screened for resemblance to real people) · T11 voices · T12 wardrobe · T13 sets · T14 props |
| Pre-production | T16 shot list · T17 storyboards · T18 animatic · T19 schedule and budget |
| Production | T22 performance direction · T20 keyframes (from character, set and prop references) · T21 video takes · T23 dialogue · T24 lip sync · T25 continuity check (re-shoots failures) |
| Post-production | T26 edit · T27 VFX/upscale · T28 grade · T29 score (Omega) · T30 songs (Omega) · T31 ambience · T32 mix (−14 LUFS) · T33 titles and credits |
| Delivery | T34 subtitles (translated) and dubbed mixes (each character's own voice on the music-and-effects stem) · T35 trailer and poster · T36 master, vertical edition and one version per dub language |
| Release | T37 festival and platform package, and the soundtrack album created as a release in Instrument Omega · T38 press research and pitch drafts |

3. **Manual for some roles or scenes.** Steps that work per character (designs, voices, wardrobe) or per scene (shots, boards, keyframes, takes, performance, dialogue, lip sync, continuity, ambience) can stay Auto while chosen roles or scenes are Manual: those get extra candidates and wait for your pick (step page, "Manual for specific roles/scenes").
4. **Your turn.** Manual steps, hard QC gates (casting consent, budget) and "notify me" previews wait on the project page under *Waiting for you*. Previews auto-approve after the window you set.
5. **Everything is versioned.** Approving a new version of any step marks every step built on it as out of date, and Auto steps rebuild. Any earlier version can be restored.

## Your likeness

Only your own face and voice can be used, and only under a signed consent record (Your likeness page): which role sizes, voice yes/no, violence, on-screen death and age-shifting (yes, no or ask each time; age-shifting is asked when your character's age differs from yours by 10+ years), and an expiry. On the Performance step you can upload a phone video of yourself acting each of your shots; with `FAL_MOTION_MODEL` set, your movement and timing drive the take. Casting stops at its gate until your capture photos and voice recording are uploaded and every "ask each time" question is answered. Revoking consent stops new renders. No nudity or sexual content is generated with your likeness.

## Services and keys

| Service | Env var | Used for |
|---|---|---|
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | Every writing, planning, QC and research step (`claude-opus-5-5`, structured output, adaptive thinking, server-side refusal fallback) |
| fal.ai | `FAL_KEY` | Images, reference-guided keyframes, image-to-video, lip sync, optional upscaling |
| ElevenLabs | `ELEVENLABS_API_KEY` | Voice library, cloning your own voice, dialogue, ambience |
| Instrument Omega | `OMEGA_URL`, `OMEGA_PASSWORD` | Score cues and songs, made in Omega and downloaded |

Keys can also be saved in Settings (encrypted with `APP_SECRET`). A step that needs a missing key shows *Needs a key* and restarts when the key is added.

fal model ids are configurable: `FAL_IMAGE_MODEL` (default `fal-ai/flux/dev`), `FAL_BOARD_MODEL` (`fal-ai/flux/schnell`), `FAL_REF_MODEL` (`fal-ai/nano-banana/edit`), `FAL_VIDEO_MODEL` (`fal-ai/kling-video/v2.1/standard/image-to-video`), `FAL_LIPSYNC_MODEL` (`fal-ai/sync-lipsync`), `FAL_UPSCALE_MODEL` (off). Planning prices are env-configurable too (`FAL_PRICE_*`, `ELEVENLABS_PRICE_*`); the spend ledger records these estimates, not provider invoices.

Durable media: set `S3_BUCKET` (plus `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_PREFIX`, `S3_FORCE_PATH_STYLE=1`) to keep every upload and render in any S3-compatible store (Cloudflare R2, Backblaze B2, AWS S3). Without it, Render's free-plan disk is wiped on restart: generated media is re-downloaded from provider URLs, but your uploads and ffmpeg renders are lost.

Other settings: `DATABASE_URL` (required), `MEDIA_CONCURRENCY` (parallel provider jobs inside a step, default 4), `APP_PASSWORD`, `APP_SECRET`, `PUBLIC_URL` (so providers can fetch your uploads), `MEDIA_DIR`, `RENDER_WIDTH`/`RENDER_HEIGHT` (default 1920×1080), `WORKER_CONCURRENCY`, `CLAUDE_MODEL`.

## Run locally

Needs Node 20+, ffmpeg and Postgres.

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost/screendream ANTHROPIC_API_KEY=... npm start
```

## Tests (no paid calls)

```bash
DATABASE_URL=postgres://... npm test
```

`test/smoke.js` starts `test/mocks.js` (stand-ins for Claude, fal, ElevenLabs and Omega) and the app against a throwaway database, then makes a two-scene film end to end: login gate, Omega import, a Manual step, the consent gate with capture upload and death and age-shift questions, a per-scene Manual override inside an Auto step, your phone performance driving a take, all 38 steps, the master, vertical edition, a French dub and translated subtitles, the soundtrack release in Omega, durable storage (local disk wiped, files restored from the bucket), provider call shapes, the spend ledger, and stale-marking after an edit. CI runs it on every push.

## Deploy

Same pattern as Instrument Omega: a Render web service running `node:22-bookworm-slim` with start command `sh /etc/secrets/start.sh`; the app is uploaded as the secret file `app.b64`.

```bash
SCREENDREAM_SERVICE_ID=srv-... scripts/deploy-render.sh --start-script   # first deploy
SCREENDREAM_SERVICE_ID=srv-... scripts/deploy-render.sh                  # later deploys
```

## Status and limits

Working and tested against mocks: the whole pipeline, Auto/Manual per step, gates, versions and staleness, consent, uploads, budget cap, the ffmpeg animatic, edit, grade, mix, titles, subtitles, trailer and deliverables.

Not yet verified against the live services: the fal, ElevenLabs and Omega adapters follow those APIs' documented shapes but have only run against the mocks. Check the fal model ids and each model's license before a commercial release (Usage rights page).

Not built yet: signed C2PA Content Credentials (the AI disclosure is in the file metadata and the credits), a licensed face-match database for the resemblance screen (it currently asks Claude's vision model), automatic festival submission and sending pitches. The motion-transfer adapter is off until a fal model id is chosen (`FAL_MOTION_MODEL`), since input names differ between models.

Render's free plan sleeps after 15 idle minutes, and the worker sleeps with it, so a film only advances while the app is open in a browser tab (as with Omega's research). A paid instance keeps it running.
