// app/projects/geomelody/_lib/recommend.ts
export interface RecommendResult {
  id: string
  reason: string
}

export async function scoreByGenres(
  tracks: { id: string; name: string; artist: string; artistId?: string }[],
  scene: string,
  activity: string,
  mood: string,
): Promise<RecommendResult[]> {
  const res = await fetch('/api/geomelody/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tracks: tracks.map(t => ({ id: t.id, name: t.name, artist: t.artist })),
      scene, activity, mood,
    }),
  })

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(error)
  }

  const data = await res.json() as { results: RecommendResult[]; debug?: any }
  if (data.debug && typeof window !== 'undefined') {
    console.log('[recommend] sensor :', data.debug.sensor)
    console.log('[recommend] targets:', data.debug.targets)
  }
  return data.results
}