# GeoMelody

> Context-aware background music, picked from your own Spotify library.

GeoMelody surfaces the right *subset* of music you already love for the moment you're in — a quiet library, a noisy subway, a walk in the park — by matching your current scene, activity, and mood against the genres of the artists in your playlists.

**[Live demo](#) · [Case study](#)**

---

## The Idea

Most recommenders push tracks at you from outside your taste — Discover Weekly, viral hits, algorithmic radio. GeoMelody does the opposite. It stays inside a playlist you already love and surfaces the four or five tracks that fit *where you are right now*.

You're in a café working. You don't want to learn a new song. You want the tracks from your saved list that are actually café-shaped.

## How It Works

1. **Connect Spotify** (PKCE — no backend secret).
2. **Pick a playlist** of your own.
3. **Set context** — scene (Café · Library · Street · Subway · Park), activity (Still · Working · Walking), mood (Focused · Relaxed · Stressed · Energetic).
4. **Get five tracks** with a one-line reason for each.

Matching is a keyword score against artist genres pulled from Spotify's `/v1/artists` endpoint. Each context value maps to a curated genre vocabulary (e.g. *Library* → `ambient · classical · instrumental · post-rock · minimal · drone · lo-fi`). The tracks whose artist genres overlap the combined vocabulary the most win.

## Why Genres Instead of Audio Features

The original plan was the obvious one: target vectors over Spotify's audio features (energy, valence, acousticness, instrumentalness), rank by Euclidean distance. The `library` profile would be `{ energy: 0.3, valence: 0.4, acousticness: 0.7, instrumentalness: 0.8 }`, and a track's distance from that vector would be its score.

Spotify deprecated `audio-features` for new applications in November 2024.

The fallback became artist-level genres, which Spotify still exposes. It's coarser — a single artist is often both a "café" artist *and* a "subway" artist depending on the track — but for most personal playlists, where genre clusters are consistent, it holds up. The original feature-vector code (`lib/geomelody/ruleEngine.ts`, `lib/geomelody/euclidean.ts`) is still in the repo, unwired, as a record of the pivot.

## Stack

- **Next.js 14** (App Router), client-rendered
- **Spotify Web API** with PKCE OAuth — no server secret, all in the browser
- **Canvas-based dot orb** — 800 dots distributed on a sphere, driven by microphone amplitude, purely decorative
- **Tailwind + inline styles** for the iPhone-frame mobile UI

## Project Structure

```
app/geomelody/
  page.tsx               # Three-step flow + DotOrb
  callback/page.tsx      # OAuth redirect handler

lib/geomelody/
  auth.ts                # PKCE flow + token storage
  api.ts                 # Spotify wrappers — playlists, tracks, artists
  recommend.ts           # Context → genre keywords → scored matches
  ruleEngine.ts          # [unused] audio-feature target builder
  euclidean.ts           # [unused] feature-vector distance matcher
```

## Local Setup

```bash
pnpm install
```

Create `.env.local`:

```
NEXT_PUBLIC_SPOTIFY_CLIENT_ID=your_client_id
```

In the Spotify Developer Dashboard, add a redirect URI:

```
http://localhost:3000/geomelody/callback
```

Until your app is in extended-quota mode, you'll also need to add each user under **Users and Access**.

## Roadmap

The genre-keyword approach has obvious ceilings — Spotify's genre tags are sparse, and they're attached to artists rather than tracks. What's next:

- **Last.fm tags** for crowd-sourced mood and scene labels Spotify doesn't carry (`coffeehouse`, `study`, `melancholic`, `rainy day`). Map free tags onto a controlled vocabulary.
- **LLM tagging** for the long tail where Last.fm has nothing. Feed `(name, artist, album)` to Claude, get back `{ mood, scene, activity }`, cache per track.
- **Sensor input** for a mobile build — pace from the accelerometer, ambient noise from the mic, time-of-day weighting.

## Notes

- Spotify Premium isn't required for recommendations. It would be required for in-app playback control via the Web Playback SDK, which isn't shipped yet.
- The dot orb reads the microphone but doesn't influence recommendations. It's there because the auth screen otherwise felt dead.
- An earlier prototype lives at `/playground/mood-music`. It uses server-side OAuth and the now-deprecated audio-features endpoint, and predates the genre pivot. Kept for reference, not actively maintained.
