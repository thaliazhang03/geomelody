import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 30

const SYSTEM_PROMPT = `You analyze a photo of someone's surroundings to choose the best context for music recommendation.

Rules:
- Do NOT identify or describe specific people, faces, or identities.
- Only describe the environment, lighting, mood, and activity inferred from scene cues.
- If the image is ambiguous, make your best guess and set confidence low.

Respond with ONLY a JSON object, no prose:
{
  "scene": "Café" | "Library" | "Street" | "Subway" | "Park",
  "activity": "Still" | "Working" | "Walking",
  "mood": "Focused" | "Relaxed" | "Stressed" | "Energetic",
  "vibe": ["3-5 short descriptors, e.g. warm, golden_hour, crowded, cozy, minimal"],
  "confidence": 0.0 to 1.0,
  "note": "one short sentence explaining the choice"
}`

export async function POST(req: NextRequest) {
  const { imageBase64, mimeType } = await req.json() as {
    imageBase64: string
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'missing key' }, { status: 500 })

  // Vision 任务用 pro 更稳,flash 也能跑,按需切换
  const model = 'gemini-2.0-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: 'Analyze this photo and return the JSON described in the system instruction.' },
        ],
      }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
      },
    }),
  })

  if (!r.ok) return NextResponse.json({ error: await r.text() }, { status: r.status })
  const data = await r.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return NextResponse.json(parsed)
  } catch {
    return NextResponse.json({ error: 'parse failed', raw: text }, { status: 500 })
  }
}