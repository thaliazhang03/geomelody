import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

interface Candidate {
  id: string
  name: string
  artist: string
  genres: string[]
}

export async function POST(req: NextRequest) {
  const { candidates, context, topN } = await req.json() as {
    candidates: Candidate[]
    context: { scene: string; activity: string; mood: string }
    topN: number
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'missing key' }, { status: 500 })

  const prompt = `You are a music curator. The listener is in a "${context.scene}" setting, doing "${context.activity}", feeling "${context.mood}".

From their personal library, pick the ${topN} tracks that best fit this moment. Prioritize mood fit, then scene, then activity. Avoid picking multiple tracks from the same artist unless unavoidable.

Candidate tracks (id | title — artist | genres):
${candidates.map(c => `${c.id} | ${c.name} — ${c.artist} | ${c.genres.join(', ') || 'unknown'}`).join('\n')}

Respond with ONLY a JSON array, no prose, no markdown fences:
[{"id":"<track id>","reason":"<5-8 word reason in English>"}]`

  const model = 'gemini-2.0-flash' // 便宜快,够 rerank 用
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 800,
        responseMimeType: 'application/json', // Gemini 的结构化输出开关
      },
    }),
  })

  if (!r.ok) {
    return NextResponse.json({ error: await r.text() }, { status: r.status })
  }
  const data = await r.json()
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
  const cleaned = text.replace(/```json|```/g, '').trim()
  try {
    const results = JSON.parse(cleaned)
    const valid = Array.isArray(results)
      ? results.filter((x: any) => typeof x?.id === 'string' && typeof x?.reason === 'string').slice(0, topN)
      : []
    return NextResponse.json({ results: valid })
  } catch {
    return NextResponse.json({ results: [] })
  }
}