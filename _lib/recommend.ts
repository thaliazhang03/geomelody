// ============================================================
// recommend.ts  —  GeoMelody Engine (Claude API version)
// Replaces the old Last.fm tag-based scoring system.
//
// Flow:
//   1. fetchSensorData()   — GET /latest-sensor-data from FastAPI
//   2. computeTargets()    — Steps 1–5 from Logic Prompt (pure math)
//   3. callClaudeAPI()     — send targets + tracks, get recommendations
//   4. scoreByGenres()     — main export, drop-in replacement
// ============================================================

// ============================================================
// Types
// ============================================================
export interface RecommendResult {
  id: string
  reason: string
}

interface SensorData {
  heart_rate: number  // normalised 0.0–1.0
  noise_level: number // normalised 0.0–1.0
}

interface TargetVector {
  energy: number
  danceability: number
  acousticness: number
  valence: number
  instrumentalness: number
}

interface ClaudeRecommendation {
  track_name: string
  artist: string
  reason: string
}

interface ClaudeResponse {
  calculated_targets: TargetVector
  recommendations: ClaudeRecommendation[]
}

// ============================================================
// Step 1 — Location baselines
// ============================================================
const LOCATION_BASELINES: Record<string, TargetVector> = {
  Café:    { energy: 0.45, danceability: 0.40, acousticness: 0.60, valence: 0.70, instrumentalness: 0.30 },
  Library: { energy: 0.30, danceability: 0.20, acousticness: 0.50, valence: 0.50, instrumentalness: 0.85 },
  Street:  { energy: 0.70, danceability: 0.75, acousticness: 0.20, valence: 0.60, instrumentalness: 0.20 },
  Subway:  { energy: 0.85, danceability: 0.60, acousticness: 0.05, valence: 0.40, instrumentalness: 0.20 },
  Park:    { energy: 0.55, danceability: 0.50, acousticness: 0.80, valence: 0.85, instrumentalness: 0.60 },
}

// ============================================================
// Step 5 — Clamp helper
// ============================================================
const clamp = (v: number): number => Math.max(0, Math.min(1, v))

// ============================================================
// Steps 1–5: Compute 5D target vector
// ============================================================
export function computeTargets(
  scene: string,
  activity: string,
  mood: string,
  sensor: SensorData,
): TargetVector {
  const baseline = LOCATION_BASELINES[scene]
  if (!baseline) throw new Error(`[recommend] Unknown scene: ${scene}`)

  // Step 1 — copy baseline
  const t = { ...baseline }
  const { heart_rate: sHr, noise_level: sNoise } = sensor

  // Step 2 — Environmental noise offset
  t.acousticness -= sNoise * 0.40
  t.energy       += sNoise * 0.15

  // Step 3 — Mood × Heart Rate offset
  // High = S_hr >= 0.65 | Low = S_hr < 0.65
  const highHr = sHr >= 0.65

  switch (mood) {
    case 'Focused':
      t.instrumentalness += highHr ? 0.20 : 0.10
      t.energy           -= highHr ? 0.15 : 0.05
      break
    case 'Relaxed':
      // Regardless of S_hr
      t.energy       -= 0.20
      t.danceability -= 0.15
      break
    case 'Stressed':
      t.energy  -= highHr ? 0.25 : 0.10
      t.valence += highHr ? 0.20 : 0.10
      break
    case 'Energetic':
      t.energy       += highHr ? 0.20 : 0.08
      t.danceability += highHr ? 0.15 : 0.08
      break
  }

  // Step 4 — Activity (IMU) offset
  switch (activity) {
    case 'Still':
      t.danceability     -= 0.10
      break
    case 'Walking':
      t.danceability     += 0.15
      t.energy           += 0.10
      break
    case 'Working':
      t.instrumentalness += 0.10
      t.energy           -= 0.05
      break
  }

  // Step 5 — Clamp all dimensions to [0.0, 1.0]
  return {
    energy:           clamp(t.energy),
    danceability:     clamp(t.danceability),
    acousticness:     clamp(t.acousticness),
    valence:          clamp(t.valence),
    instrumentalness: clamp(t.instrumentalness),
  }
}

// ============================================================
// Step 1 — Fetch & normalise sensor data from FastAPI
//
// Raw ranges assumed:
//   heart_rate : 40–200 bpm  → normalised to 0.0–1.0
//   noise_level: 30–100 dB   → normalised to 0.0–1.0
//
// Falls back to neutral defaults if backend is unreachable.
// ============================================================
export async function fetchSensorData(): Promise<SensorData> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000'

  try {
    const res = await fetch(`${backendUrl}/latest-sensor-data`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const raw = await res.json() as { heart_rate?: number; noise_level?: number }

    if (raw.heart_rate == null || raw.noise_level == null) {
      throw new Error('Sensor data incomplete')
    }

    return {
      heart_rate:  clamp((raw.heart_rate  - 40)  / 160), // 40–200 bpm
      noise_level: clamp((raw.noise_level - 30)  / 70),  // 30–100 dB
    }
  } catch (e) {
    console.warn('[recommend] Sensor fetch failed — using neutral defaults:', e)
    // Neutral defaults: resting HR, quiet environment
    return { heart_rate: 0.40, noise_level: 0.20 }
  }
}

// ============================================================
// Build system prompt for Claude
// ============================================================
function buildPrompt(
  targets: TargetVector,
  tracks: { id: string; name: string; artist: string }[],
  sensor: SensorData,
  scene: string,
  activity: string,
  mood: string,
): string {
  const tracksJson = JSON.stringify(
    tracks.map(t => ({ id: t.id, name: t.name, artist: t.artist }))
  )

  return `You are the GeoMelody Engine — a music recommendation system.
Your task: select exactly 5 tracks from the seed list that best match the target audio profile.

== Sensor Context ==
Location  : ${scene}
Activity  : ${activity}
Mood      : ${mood}
S_hr      : ${sensor.heart_rate.toFixed(2)}  (heart rate arousal, 0.0–1.0)
S_noise   : ${sensor.noise_level.toFixed(2)} (environment noise, 0.0–1.0)

== Target Audio Profile (pre-computed) ==
energy           : ${targets.energy.toFixed(4)}
danceability     : ${targets.danceability.toFixed(4)}
acousticness     : ${targets.acousticness.toFixed(4)}
valence          : ${targets.valence.toFixed(4)}
instrumentalness : ${targets.instrumentalness.toFixed(4)}

== Seed List (${tracks.length} tracks) ==
${tracksJson}

== Instructions ==
1. Select exactly 5 unique tracks from the seed list.
2. Choose tracks whose genre, style, and energy best match the target profile above.
3. Write a "reason" per track (max 12 words) explaining the sensor-to-music mapping.
   Example: "High noise drives energy up; this track cuts through."
4. Return ONLY valid JSON — no markdown fences, no preamble, no explanation.

== Required Output Format ==
{
  "calculated_targets": {
    "energy": ${targets.energy.toFixed(4)},
    "danceability": ${targets.danceability.toFixed(4)},
    "acousticness": ${targets.acousticness.toFixed(4)},
    "valence": ${targets.valence.toFixed(4)},
    "instrumentalness": ${targets.instrumentalness.toFixed(4)}
  },
  "recommendations": [
    { "track_name": "string", "artist": "string", "reason": "string" }
  ]
}`
}

// ============================================================
// Call Claude API
//
// ⚠️  API key must be kept server-side.
//     In Next.js: use a Route Handler (app/api/recommend/route.ts)
//     and call this function from there, not from the browser.
// ============================================================
async function callClaudeAPI(
  targets: TargetVector,
  tracks: { id: string; name: string; artist: string }[],
  sensor: SensorData,
  scene: string,
  activity: string,
  mood: string,
): Promise<ClaudeResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('[recommend] ANTHROPIC_API_KEY is not set')

  const prompt = buildPrompt(targets, tracks, sensor, scene, activity, mood)

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`[recommend] Claude API error ${res.status}: ${err}`)
  }

  const data = await res.json() as { content: { type: string; text: string }[] }
  const rawText = data.content?.find(b => b.type === 'text')?.text ?? ''

  try {
    return JSON.parse(rawText) as ClaudeResponse
  } catch {
    // Strip accidental markdown fences
    const clean = rawText.replace(/```json|```/g, '').trim()
    return JSON.parse(clean) as ClaudeResponse
  }
}

// ============================================================
// Main export — drop-in replacement for old scoreByGenres()
//
// Signature is intentionally identical to the old version so
// Page.tsx requires zero changes.
// ============================================================
export async function scoreByGenres(
  tracks: { id: string; name: string; artist: string; artistId?: string }[],
  scene: string,
  activity: string,
  mood: string,
): Promise<RecommendResult[]> {

  // 1. Fetch & normalise sensor data
  const sensor = await fetchSensorData()

  // 2. Compute 5D target vector (pure math, Steps 1–5)
  const targets = computeTargets(scene, activity, mood, sensor)

  if (typeof window !== 'undefined') {
    console.log('[recommend] sensor :', sensor)
    console.log('[recommend] targets:', targets)
  }

  // 3. Ask Claude to pick the best matching tracks
  const claudeRes = await callClaudeAPI(targets, tracks, sensor, scene, activity, mood)

  // 4. Map Claude's name/artist back to track ids
  //    (Claude returns names, Page.tsx needs ids)
  const results: RecommendResult[] = claudeRes.recommendations
    .map(rec => {
      const match = tracks.find(
        t =>
          t.name.toLowerCase().trim()   === rec.track_name.toLowerCase().trim() &&
          t.artist.toLowerCase().trim() === rec.artist.toLowerCase().trim()
      )
      if (!match) {
        console.warn(`[recommend] No id match for "${rec.track_name}" by "${rec.artist}"`)
        return null
      }
      return { id: match.id, reason: rec.reason }
    })
    .filter((r): r is RecommendResult => r !== null)
    .slice(0, 5)

  if (results.length === 0) {
    throw new Error('[recommend] Claude returned no matching tracks from the seed list.')
  }

  return results
}
