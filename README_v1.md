# GeoMelody

> Context-aware background music, picked from your own Spotify library — driven by real-time sensor data.

GeoMelody surfaces the right subset of music you already love for the moment you're in. It reads your heart rate, ambient noise level, and physical activity from a wearable sensor, computes a 5-dimensional audio target, and asks Claude to pick the five best-matching tracks from your library.

**[Live demo](#) · [Case study](#)**

---

## The Idea

Most recommenders push tracks at you from outside your taste — Discover Weekly, viral hits, algorithmic radio. GeoMelody does the opposite. It stays inside your saved library and surfaces the tracks that fit *where you are and how you feel right now* — not based on your history, but on your body and environment in this moment.

---

## How It Works

1. **Connect Spotify** (PKCE — no backend secret).
2. **Pick a source** — Liked Songs or Top Tracks.
3. **Set context** — scene (Café · Library · Street · Subway · Park) and mood (Focused · Relaxed · Stressed · Energetic). Activity is detected automatically from the wearable sensor.
4. **Get five tracks** with a one-line reason for each, powered by Claude.
5. **Refresh** to re-run the recommendation with the same context, or change context to start over.

---

## Recommendation Engine

### Sensor Input

A CircuitPython-based wearable sends sensor readings to a local FastAPI server every 5 seconds:

| Field | Unit | Range |
|---|---|---|
| `heart_rate` | BPM | 40–200 |
| `noise_level` | dB | 30–100 |
| `imu_state` | string | `ACT_STILL` · `ACT_WALKING` · `ACT_WORKING` |

### 5D Target Vector (Steps 1–5)

The frontend computes a target vector across five Spotify audio dimensions before calling Claude:

1. **Location baseline** — each scene has a preset 5D coordinate (e.g. Library: high instrumentalness, low energy).
2. **Noise offset** — high ambient noise raises energy and lowers acousticness.
3. **Mood × heart rate** — mood determines which dimensions shift; heart rate (≥ 0.65 = high arousal) controls the magnitude.
4. **Activity offset** — walking raises danceability and energy; working raises instrumentalness.
5. **Clamp** — all values kept within [0.0, 1.0].

### Claude API

The computed target vector, full track list, and sensor readings are sent to Claude (`claude-sonnet-4-6`). Claude selects the five tracks from the seed list whose genre, style, and energy best match the target, and returns a one-line reason per track explaining the sensor-to-music mapping.

### Why Not Audio Features

The original plan used Spotify's audio features (energy, valence, acousticness, instrumentalness) to rank tracks by Euclidean distance. Spotify deprecated the `audio-features` endpoint for new applications in November 2024. The original feature-vector code (`lib/geomelody/ruleEngine.ts`, `lib/geomelody/euclidean.ts`) is still in the repo, unwired, as a record of the pivot.

---

## Stack

- **Next.js 14** (App Router), client-rendered
- **Spotify Web API** with PKCE OAuth — no server secret, all in the browser
- **FastAPI** — local backend that receives sensor data and serves it to the frontend
- **CircuitPython** — runs on the wearable, sends heart rate, noise level, and IMU state over WiFi
- **Claude API** (`claude-sonnet-4-6`) — picks and explains the five recommended tracks
- **Canvas-based dot orb** — 800 dots on a sphere, driven by microphone amplitude

---

## Project Structure

```
app/geomelody/
  page.tsx               # Three-step flow + DotOrb + Refresh button
  callback/page.tsx      # OAuth redirect handler

lib/geomelody/
  auth.ts                # PKCE flow + token storage
  api.ts                 # Spotify wrappers — liked tracks, top tracks
  recommend.ts           # Sensor fetch → target vector → Claude API
  ruleEngine.ts          # [unused] audio-feature target builder
  euclidean.ts           # [unused] feature-vector distance matcher

hardware/
  geomelody.py           # CircuitPython — WiFi + sensor POST loop

backend/
  main.py                # FastAPI — receives and serves sensor data
```

---

## Local Setup

```bash
pnpm install
```

Create `.env.local` in the project root:

```
NEXT_PUBLIC_SPOTIFY_CLIENT_ID=your_spotify_client_id
ANTHROPIC_API_KEY=your_anthropic_api_key
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000
```

In the Spotify Developer Dashboard, add a redirect URI:

```
http://127.0.0.1:3000/geomelody/callback
```

> Use `127.0.0.1` instead of `localhost` — the PKCE origin check requires a consistent hostname.

Start the FastAPI backend:

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Then run the Next.js dev server:

```bash
pnpm dev
```

Until your Spotify app is in extended-quota mode, add each tester under **Users and Access** in the Spotify Developer Dashboard.

---

## Notes

- Spotify Premium is required for in-app playback via the Web Playback SDK. Track recommendations work without Premium.
- If the sensor backend is unreachable, the frontend falls back to neutral defaults (resting heart rate, quiet environment, stationary) and continues without crashing.
- The dot orb reads the microphone for its animation but does not influence recommendations.
