'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import Script from 'next/script'
import { loginWithSpotify, getAccessToken, logout } from './_lib/auth'
import { getLikedTracks, getTopTracks, Track } from './_lib/api'
import { scoreByGenres } from './_lib/recommend'
import { usePlayer } from './_lib/usePlayer'

type Step = 'source' | 'context' | 'results'
type Source = 'liked' | 'top'
type TrackWithReason = Track & { reason?: string }

const SOURCES: { id: Source; label: string; desc: string }[] = [
  { id: 'liked', label: 'Liked Songs', desc: 'Your saved tracks' },
  { id: 'top', label: 'Top Tracks', desc: 'Your most played, last 6 months' },
]

const SCENES = ['Café', 'Library', 'Street', 'Subway', 'Park']
const MOODS  = ['Focused', 'Relaxed', 'Stressed', 'Energetic']

const IMU_MAP: Record<string, string> = {
  ACT_STILL:   'Still',
  ACT_WALKING: 'Walking',
  ACT_WORKING: 'Working',
}

const SEED_SIZE = 25

function sampleTracks<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr
  const a = [...arr]
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

// ── Sensor types ────────────────────────────────
type SensorSnapshot = {
  heart_rate: number
  noise_level: number
  imu_state: string
  activityLabel: string
  fetchedAt: number
}

async function fetchSensorSnapshot(): Promise<SensorSnapshot | null> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000'
  try {
    const res = await fetch(`${backendUrl}/latest-sensor-data`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as {
      heart_rate?: number; noise_level?: number; imu_state?: string
    }
    return {
      heart_rate:    data.heart_rate   ?? 0,
      noise_level:   data.noise_level  ?? 0,
      imu_state:     data.imu_state    ?? '',
      activityLabel: IMU_MAP[data.imu_state ?? ''] ?? 'Still',
      fetchedAt:     Date.now(),
    }
  } catch (e) {
    console.warn('[page] sensor fetch failed:', e)
    return null
  }
}

// ─────────────────────────────────────────────
// Inline SVG icons
// ─────────────────────────────────────────────
const Icon = {
  Plus:    ({ s = 14 }: { s?: number }) => <svg width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>,
  Trash:   ({ s = 14 }: { s?: number }) => <svg width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>,
  Play:    ({ s = 12 }: { s?: number }) => <svg width={s} height={s} fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>,
  Pause:   ({ s = 12 }: { s?: number }) => <svg width={s} height={s} fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>,
  Next:    ({ s = 14 }: { s?: number }) => <svg width={s} height={s} fill="currentColor" viewBox="0 0 24 24"><path d="M6 4l10 8-10 8V4zM18 4h2v16h-2z"/></svg>,
  ChevUp:  ({ s = 16 }: { s?: number }) => <svg width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>,
  ChevDn:  ({ s = 16 }: { s?: number }) => <svg width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>,
  Refresh: ({ s = 14 }: { s?: number }) => <svg width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/></svg>,
}

// ─────────────────────────────────────────────
// DotOrb — mic-reactive particle sphere
// ─────────────────────────────────────────────
function DotOrb() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const volumeRef = useRef(0)
  const rafRef    = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = 260, H = 260
    const cx = W / 2, cy = H / 2
    const BASE_R = 70
    const DOT_COUNT = 800

    const dots: { theta: number; phi: number; offset: number }[] = []
    for (let i = 0; i < DOT_COUNT; i++) {
      dots.push({
        theta:  2 * Math.PI * Math.random(),
        phi:    Math.acos(2 * Math.random() - 1),
        offset: Math.random() * Math.PI * 2,
      })
    }

    let mic: MediaStream | null = null
    let analyser: AnalyserNode | null = null
    let dataArray: Uint8Array<ArrayBuffer> | null = null

    navigator.mediaDevices?.getUserMedia({ audio: true }).then(stream => {
      mic = stream
      const audioCtx = new AudioContext()
      const source   = audioCtx.createMediaStreamSource(stream)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      dataArray = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      source.connect(analyser)
    }).catch(() => {})

    let time = 0
    function draw() {
      ctx!.clearRect(0, 0, W, H)
      time += 0.02

      let vol = 0
      if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]
        vol = sum / dataArray.length / 128
      }
      volumeRef.current += (vol - volumeRef.current) * 0.15

      const v = volumeRef.current
      const R = BASE_R + v * 40

      dots.forEach(d => {
        const noise = Math.sin(d.theta * 3 + time + d.offset) * Math.cos(d.phi * 2 + time * 0.7) * v * 18
        const r     = R + noise
        const x     = cx + r * Math.sin(d.phi) * Math.cos(d.theta)
        const y     = cy + r * Math.sin(d.phi) * Math.sin(d.theta)
        const depth = (Math.cos(d.phi) + 1) / 2
        const alpha = 0.05 + depth * 0.35 + v * 0.2
        const size  = 0.8  + depth * 0.8  + v * 0.6

        ctx!.beginPath()
        ctx!.arc(x, y, size, 0, Math.PI * 2)
        ctx!.fillStyle = v > 0.15
          ? `rgba(249,115,22,${alpha})`
          : `rgba(0,0,0,${alpha})`
        ctx!.fill()
      })

      rafRef.current = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      cancelAnimationFrame(rafRef.current)
      mic?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={260}
      height={260}
      style={{ display: 'block', margin: '0 auto' }}
    />
  )
}

// ─────────────────────────────────────────────
// Chip — selectable pill button
// ─────────────────────────────────────────────
function Chip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        minWidth: 0,
        padding: '6px 4px',
        borderRadius: '999px',
        border:      selected ? '1.5px solid #f97316' : '1px solid #e0e0e0',
        background:  selected ? '#fff7f0' : '#fff',
        color:       selected ? '#f97316' : '#666',
        fontSize:    '11px',
        fontWeight:  selected ? 600 : 400,
        cursor:      'pointer',
        transition:  'all 0.15s',
        fontFamily:  'inherit',
        lineHeight:  1.2,
        whiteSpace:  'nowrap',
        overflow:    'hidden',
        textOverflow:'ellipsis',
      }}
    >
      {label}
    </button>
  )
}

// ─────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────
function formatTime(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function PlaybackProgress({
  positionMs,
  durationMs,
  onSeek,
  dark = false,
  showTimes = false,
}: {
  positionMs: number
  durationMs: number
  onSeek: (positionMs: number) => void
  dark?: boolean
  showTimes?: boolean
}) {
  const safeDuration = Math.max(durationMs, 0)
  const safePosition = Math.max(0, Math.min(positionMs, safeDuration || 0))
  const percent = safeDuration > 0 ? (safePosition / safeDuration) * 100 : 0
  const disabled = safeDuration <= 0

  return (
    <div style={{ width: '100%' }}>
      <div style={{
        position: 'relative',
        height: showTimes ? '18px' : '12px',
        display: 'flex',
        alignItems: 'center',
      }}>
        <div style={{
          width: '100%',
          height: showTimes ? '6px' : '4px',
          borderRadius: '999px',
          background: dark ? 'rgba(255,255,255,0.18)' : '#e9e4dc',
          overflow: 'hidden',
          boxShadow: dark ? 'inset 0 0 0 1px rgba(255,255,255,0.04)' : 'inset 0 0 0 1px rgba(0,0,0,0.03)',
        }}>
          <div style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: 'inherit',
            background: dark
              ? 'linear-gradient(90deg, #f97316, #facc15)'
              : 'linear-gradient(90deg, #111, #f97316)',
            transition: 'width 0.2s linear',
          }} />
        </div>
        <div style={{
          position: 'absolute',
          left: `calc(${percent}% - ${showTimes ? 6 : 4}px)`,
          width: showTimes ? 12 : 8,
          height: showTimes ? 12 : 8,
          borderRadius: '50%',
          background: dark ? '#fff' : '#111',
          boxShadow: dark ? '0 2px 8px rgba(0,0,0,0.35)' : '0 2px 8px rgba(0,0,0,0.18)',
          opacity: disabled ? 0 : 1,
          transition: 'left 0.2s linear',
          pointerEvents: 'none',
        }} />
        <input
          aria-label="Playback progress"
          type="range"
          min={0}
          max={Math.max(safeDuration, 1)}
          value={safePosition}
          disabled={disabled}
          onChange={(e) => onSeek(Number(e.currentTarget.value))}
          className="geomelody-progress-input"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            opacity: 0,
            cursor: disabled ? 'default' : 'pointer',
          }}
        />
      </div>
      {showTimes && (
        <div style={{
          marginTop: '4px',
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '10px',
          color: dark ? 'rgba(255,255,255,0.55)' : '#aaa',
          fontVariantNumeric: 'tabular-nums',
        }}>
          <span>{formatTime(safePosition)}</span>
          <span>{formatTime(safeDuration)}</span>
        </div>
      )}
    </div>
  )
}

export default function GeoMelodyPage() {
  // Force 127.0.0.1 to keep PKCE origin consistent
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      window.location.href = window.location.href.replace('localhost', '127.0.0.1')
    }
  }, [])

  const [token,         setToken]         = useState<string | null>(null)
  const [step,          setStep]          = useState<Step>('source')
  const [source,        setSource]        = useState<Source | null>(null)
  const [library,       setLibrary]       = useState<Track[] | null>(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState<string | null>(null)
  const [scene,         setScene]         = useState('Café')
  const [mood,          setMood]          = useState('Focused')
  const [sensor,        setSensor]        = useState<SensorSnapshot | null>(null)
  const [sensorLoading, setSensorLoading] = useState(false)
  const [results,       setResults]       = useState<TrackWithReason[]>([])

  // queue[0] is what's currently playing (or about to play)
  const [queue,          setQueue]          = useState<TrackWithReason[]>([])
  const [shownHistory,   setShownHistory]   = useState<Set<string>>(new Set())
  const [playerExpanded, setPlayerExpanded] = useState(false)
  const [expandedTrackId, setExpandedTrackId] = useState<string | null>(null)
  const lastAutoAdvanceRef = useRef<string | null>(null)

  const player = usePlayer()
  const detectedActivity = sensor?.activityLabel ?? 'Still'
  const nowPlaying       = queue[0] ?? null
  const noNextAvailable  = queue.length <= 1 && results.length === 0

  useEffect(() => { setToken(getAccessToken()) }, [])

  // ── Auto-play whenever queue[0] changes
  useEffect(() => {
    if (queue.length === 0 || !player.ready) return
    const target = queue[0]
    if (player.currentTrackId !== target.id || player.endedTrackId === target.id) {
      lastAutoAdvanceRef.current = null
      player.playTrack(target.uri)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, player.ready, player.currentTrackId, player.endedTrackId])

  // ── When Top 5 hits empty in results step, auto-refresh
  //    (error guards against infinite loops on failure)
  useEffect(() => {
    if (step !== 'results')        return
    if (results.length > 0)        return
    if (loading || sensorLoading)  return
    if (error)                     return
    if (!library)                  return
    console.log('[geomelody] Top 5 emptied → auto refreshing')
    runRecommend()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.length, step, loading, sensorLoading, error])

  // ─────────────────────────────────────────────
  // Sensor + recommendation pipeline
  // ─────────────────────────────────────────────
  async function runRecommend() {
    if (!library) return
    setLoading(true)
    setError(null)
    try {
      setSensorLoading(true)
      const snap = await fetchSensorSnapshot()
      setSensorLoading(false)
      setSensor(snap)
      const activity = snap?.activityLabel ?? 'Still'

      // Build pool: library minus shown history minus tracks already in queue
      const queueIds = new Set(queue.map(q => q.id))
      let pool = library.filter(t => !shownHistory.has(t.id) && !queueIds.has(t.id))

      // Pool exhausted → reset shown history (start a new cycle)
      if (pool.length < 5) {
        console.log('[geomelody] shownHistory exhausted, resetting')
        setShownHistory(new Set())
        pool = library.filter(t => !queueIds.has(t.id))
      }

      const seed = sampleTracks(pool, SEED_SIZE)
      const recs = await scoreByGenres(
        seed.map(t => ({ id: t.id, name: t.name, artist: t.artist, artistId: t.artistId })),
        scene, activity, mood
      )
      const resultTracks = recs
        .map(r => ({ ...library.find(t => t.id === r.id)!, reason: r.reason }))
        .filter(Boolean) as TrackWithReason[]

      setResults(resultTracks)
      setShownHistory(prev => {
        const next = new Set(prev)
        resultTracks.forEach(t => next.add(t.id))
        return next
      })

      if (step !== 'results') setStep('results')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // ── Step 1: load library
  async function handleSelectSource(s: Source) {
    setSource(s)
    setLoading(true)
    setError(null)
    try {
      const tracks = s === 'liked' ? await getLikedTracks() : await getTopTracks()
      if (tracks.length === 0) {
        setError(s === 'liked'
          ? 'No liked songs found. Try Top Tracks instead.'
          : 'No top tracks found yet — try Liked Songs.')
        return
      }
      setLibrary(tracks)
      fetchSensorSnapshot().then(setSensor)  // pre-warm
      setStep('context')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  // ─────────────────────────────────────────────
  // Track actions
  // ─────────────────────────────────────────────
  function addToQueue(track: TrackWithReason) {
    setQueue(q => q.some(t => t.id === track.id) ? q : [...q, track])
    setResults(r => r.filter(t => t.id !== track.id))
  }

  function removeFromResults(track: TrackWithReason) {
    setResults(r => r.filter(t => t.id !== track.id))
  }

  function playNow(track: TrackWithReason) {
    // Replace queue[0] with this track (or insert at head if empty)
    setQueue(q => {
      const rest = q.slice(1).filter(t => t.id !== track.id)
      return [track, ...rest]
    })
    setResults(r => r.filter(t => t.id !== track.id))
    // useEffect on `queue` change will trigger playTrack
  }

  function playNext() {
    setQueue(q => {
      // More than 1 in queue → just shift
      if (q.length > 1) return q.slice(1)
      // Queue ≤ 1 and results have something → pull from results
      if (results.length > 0) {
        const next = results[0]
        // Side-effect: remove from results
        setResults(r => r.filter(t => t.id !== next.id))
        return [next]
      }
      // Nothing left
      return []
    })
  }

  // ─────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────
  useEffect(() => {
    if (!player.endedTrackId || player.endedTrackId !== nowPlaying?.id) return
    if (lastAutoAdvanceRef.current === player.endedTrackId) return

    lastAutoAdvanceRef.current = player.endedTrackId
    playNext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.endedTrackId, nowPlaying?.id])

  const phone: React.CSSProperties = {
    width: '100%',
    maxWidth: '390px',
    minHeight: '844px',
    margin: '0 auto',
    background: '#fafaf8',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
    position: 'relative',
    overflow: 'hidden',
  }

  // ─────────────────────────────────────────────
  // Login screen
  // ─────────────────────────────────────────────
  if (!token) {
    return (
      <>
        <div style={phone}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 32px', textAlign: 'center' }}>
            <DotOrb />
            <div style={{ marginTop: '-20px' }}>
              <div style={{ fontSize: '11px', letterSpacing: '0.2em', color: '#aaa', textTransform: 'uppercase', marginBottom: '8px' }}>
                Context-Aware Music
              </div>
              <h1 style={{ fontSize: '40px', fontWeight: 700, letterSpacing: '-1px', margin: '0 0 12px', lineHeight: 1.1 }}>
                Geo<span style={{ color: '#f97316' }}>Melody</span>
              </h1>
              <p style={{ fontSize: '14px', color: '#888', lineHeight: 1.6, margin: '0 0 40px' }}>
                Music from your library,<br />matched to your moment.
              </p>
              <button
                onClick={loginWithSpotify}
                style={{
                  width: '100%', maxWidth: '280px', padding: '16px',
                  background: '#000', color: '#fff', border: 'none',
                  borderRadius: '14px', fontSize: '15px', fontWeight: 600,
                  cursor: 'pointer', letterSpacing: '0.02em', fontFamily: 'inherit',
                }}
              >
                Connect Spotify
              </button>
              <p style={{ fontSize: '11px', color: '#bbb', marginTop: '12px' }}>Requires Spotify Premium</p>
            </div>
          </div>
        </div>
        <Script src="https://sdk.scdn.co/spotify-player.js" strategy="afterInteractive" />
      </>
    )
  }

  // ─────────────────────────────────────────────
  // Main app
  // ─────────────────────────────────────────────
  return (
    <>
      <div style={phone}>

        {/* ── Header ─────────────────────────────────────── */}
        <div style={{ padding: '56px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '10px', letterSpacing: '0.2em', color: '#bbb', textTransform: 'uppercase' }}>Context-Aware</div>
            <div style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1.15 }}>
              Geo<span style={{ color: '#f97316' }}>Melody</span>
            </div>
          </div>
          <button
            onClick={() => {
              logout()
              setToken(null); setLibrary(null); setResults([])
              setSource(null); setStep('source'); setSensor(null)
              setQueue([]); setShownHistory(new Set()); setPlayerExpanded(false)
            }}
            style={{ background: 'none', border: '1px solid #e0e0e0', borderRadius: '20px', padding: '6px 14px', fontSize: '12px', color: '#888', cursor: 'pointer', marginTop: '8px', fontFamily: 'inherit' }}
          >
            Disconnect
          </button>
        </div>

        {/* ── Step 1: Source ──────────────────────────────── */}
        {step === 'source' && (
          <div style={{ flex: 1, padding: '24px 24px 40px' }}>
            <DotOrb />
            <div style={{ marginTop: '-12px' }}>
              <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '16px' }}>
                Choose source
              </div>
              {loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#aaa', fontSize: '13px', marginBottom: '12px' }}>
                  <div style={{ width: '16px', height: '16px', border: '2px solid #e0e0e0', borderTop: '2px solid #000', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  Loading…
                </div>
              )}
              {error && <p style={{ color: '#e24b4a', fontSize: '13px', marginBottom: '12px' }}>{error}</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', background: '#ebebeb', borderRadius: '16px', overflow: 'hidden' }}>
                {SOURCES.map(s => (
                  <button
                    key={s.id}
                    onClick={() => handleSelectSource(s.id)}
                    disabled={loading}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px',
                      padding: '16px', background: '#fff', border: 'none',
                      cursor: loading ? 'wait' : 'pointer', textAlign: 'left',
                      fontFamily: 'inherit', opacity: loading ? 0.6 : 1,
                    }}
                  >
                    <div style={{
                      width: 44, height: 44, borderRadius: '8px',
                      background: s.id === 'liked' ? '#1ed760' : '#000',
                      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: '18px',
                    }}>
                      {s.id === 'liked' ? '♥' : '★'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: '#111' }}>{s.label}</div>
                      <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>{s.desc}</div>
                    </div>
                    <svg width="16" height="16" fill="none" stroke="#ccc" strokeWidth="1.5" viewBox="0 0 24 24">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '11px', color: '#bbb', marginTop: '16px', lineHeight: 1.5 }}>
                Recommendations are picked from these tracks based on your context.
              </p>
            </div>
          </div>
        )}

        {/* ── Step 2: Context ─────────────────────────────── */}
        {step === 'context' && (
          <div style={{ flex: 1, padding: '24px 24px 40px' }}>
            <button
              onClick={() => setStep('source')}
              style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '13px', cursor: 'pointer', padding: '0 0 20px', display: 'flex', alignItems: 'center', gap: '4px', fontFamily: 'inherit' }}
            >
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>
              {source === 'liked' ? 'Liked Songs' : 'Top Tracks'} · {library?.length ?? 0} tracks
            </button>

            <DotOrb />

            <div style={{ marginTop: '-8px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '8px' }}>Location</div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${SCENES.length}, minmax(0, 1fr))`,
                  gap: '6px',
                  padding: '4px',
                  border: '1px solid #ece9e4',
                  borderRadius: '18px',
                  background: '#f4f1ec',
                }}>
                  {SCENES.map(s => <Chip key={s} label={s} selected={scene === s} onClick={() => setScene(s)} />)}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '8px' }}>
                  Activity
                  <span style={{ marginLeft: '8px', fontSize: '9px', color: '#f97316', letterSpacing: '0.1em' }}>AUTO</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 6px', border: '1px solid #ece9e4', borderRadius: '18px', background: '#f4f1ec' }}>
                  <span style={{
                    padding: '6px 12px', borderRadius: '999px',
                    border: '1.5px solid #f97316', background: '#fff7f0',
                    color: '#f97316', fontSize: '11px', fontWeight: 600,
                    lineHeight: 1.2, whiteSpace: 'nowrap',
                  }}>
                    {detectedActivity}
                  </span>
                  <span style={{ fontSize: '10px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sensor ? 'detected from sensor' : 'sensor offline — defaulting to Still'}
                  </span>
                </div>
              </div>

              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '8px' }}>Your current mood</div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${MOODS.length}, minmax(0, 1fr))`,
                  gap: '6px',
                  padding: '4px',
                  border: '1px solid #ece9e4',
                  borderRadius: '18px',
                  background: '#f4f1ec',
                }}>
                  {MOODS.map(m => <Chip key={m} label={m} selected={mood === m} onClick={() => setMood(m)} />)}
                </div>
              </div>

              {error && <p style={{ color: '#e24b4a', fontSize: '13px' }}>{error}</p>}

              <button
                onClick={runRecommend}
                disabled={loading}
                style={{
                  width: '100%', padding: '16px', background: '#000', color: '#fff',
                  border: 'none', borderRadius: '14px', fontSize: '15px', fontWeight: 600,
                  cursor: loading ? 'wait' : 'pointer', marginTop: '8px', fontFamily: 'inherit',
                  letterSpacing: '0.02em', opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? 'Matching…' : 'Recommend →'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Results — top 5 above + player below ── */}
        {step === 'results' && (
          <>
            {/* Scrollable content with bottom-padding so player doesn't overlap */}
            <div style={{ flex: 1, overflowY: 'auto', paddingBottom: '112px' }}>

              {/* Sensor card */}
              <div style={{ padding: '16px 24px 12px' }}>
                <div style={{
                  padding: '10px 14px',
                  borderRadius: '12px',
                  background: '#fff',
                  border: '1px solid #f0f0f0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: sensor ? '#1ed760' : '#ddd',
                    flexShrink: 0,
                    boxShadow: sensor ? '0 0 8px rgba(30,215,96,0.6)' : 'none',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '9px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '2px' }}>
                      Sensor {sensorLoading ? '· detecting…' : sensor ? '· live' : '· offline'}
                    </div>
                    {sensor ? (
                      <div style={{ fontSize: '11px', color: '#444', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <span><span style={{ color: '#aaa' }}>HR</span> <strong>{Math.round(sensor.heart_rate)}</strong></span>
                        <span><span style={{ color: '#aaa' }}>Noise</span> <strong>{Math.round(sensor.noise_level)}</strong></span>
                        <span><span style={{ color: '#aaa' }}>IMU</span> <strong>{sensor.activityLabel}</strong></span>
                      </div>
                    ) : (
                      <div style={{ fontSize: '11px', color: '#aaa' }}>Backend unreachable — using defaults</div>
                    )}
                  </div>
                  <button
                    onClick={runRecommend}
                    disabled={loading || sensorLoading}
                    title="Re-read sensor & refresh recommendations"
                    style={{
                      flexShrink: 0,
                      width: '32px', height: '32px',
                      borderRadius: '50%',
                      border: '1px solid #e0e0e0',
                      background: '#fff', color: '#666',
                      cursor: (loading || sensorLoading) ? 'wait' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      animation: (loading || sensorLoading) ? 'spin 0.8s linear infinite' : 'none',
                    }}
                  >
                    <Icon.Refresh />
                  </button>
                </div>

                {/* Context tags */}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                  {[scene, detectedActivity, mood].map(tag => (
                    <span key={tag} style={{ fontSize: '10px', padding: '3px 9px', borderRadius: '12px', border: '1px solid #e0e0e0', color: '#888', background: '#fff' }}>{tag}</span>
                  ))}
                  <button
                    onClick={() => setStep('context')}
                    style={{ fontSize: '10px', padding: '3px 9px', borderRadius: '12px', border: '1px solid #e0e0e0', background: '#fff', color: '#888', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Edit
                  </button>
                </div>
              </div>

              {/* Top 5 header */}
              <div style={{ padding: '8px 24px 12px' }}>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '4px' }}>For you</div>
                <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.3px' }}>
                  {results.length} <span style={{ color: '#f97316' }}>tracks</span>
                </div>
              </div>

              {/* Loading state */}
              {loading && results.length === 0 && (
                <div style={{ padding: '40px 24px', textAlign: 'center', color: '#aaa', fontSize: '13px' }}>
                  <div style={{ width: '20px', height: '20px', border: '2px solid #e0e0e0', borderTop: '2px solid #000', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                  Finding new tracks…
                </div>
              )}

              {/* Track list */}
              <div>
                {results.map((track, i) => {
                  const isCurrent     = nowPlaying?.id === track.id
                  const isPlayingThis = isCurrent && player.isPlaying
                  const inQueue       = queue.some(t => t.id === track.id)
                  const isExpanded    = expandedTrackId === track.id

                  return (
                    <div
                      key={track.id}
                      onClick={() => track.reason && setExpandedTrackId(prev => prev === track.id ? null : track.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '10px 18px',
                        background: i === 0 ? '#fff7f0' : 'transparent',
                        borderBottom: '0.5px solid #f0f0f0',
                        cursor: track.reason ? 'pointer' : 'default',
                      }}
                    >
                      <div style={{ color: '#ddd', fontSize: '11px', fontWeight: 700, width: '18px', textAlign: 'center', flexShrink: 0 }}>
                        {String(i + 1).padStart(2, '0')}
                      </div>

                      {track.image
                        ? <Image src={track.image} alt={track.name} width={40} height={40}
                            style={{ borderRadius: '8px', objectFit: 'cover', flexShrink: 0, filter: i === 0 ? 'none' : 'grayscale(1)' }} />
                        : <div style={{ width: 40, height: 40, borderRadius: '8px', background: '#f0f0f0', flexShrink: 0 }} />
                      }

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.name}
                        </div>
                        <div style={{ fontSize: '11px', color: '#aaa', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.artist}
                        </div>
                        {track.reason && (
                          <div style={{
                            fontSize: '10px',
                            color: '#f97316',
                            marginTop: '2px',
                            fontStyle: 'italic',
                            ...(isExpanded
                              ? { whiteSpace: 'normal', lineHeight: 1.45 }
                              : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                            ),
                          }}>
                            {track.reason}
                          </div>
                        )}
                      </div>

                      {/* Play now */}
                      <button
                        onClick={(e) => { e.stopPropagation(); playNow(track) }}
                        disabled={!player.ready}
                        title={player.ready ? 'Play now' : 'Player loading…'}
                        style={{
                          flexShrink: 0, width: '30px', height: '30px',
                          borderRadius: '50%', border: 'none',
                          background: isPlayingThis ? '#1ed760' : '#000',
                          color: '#fff',
                          cursor: player.ready ? 'pointer' : 'not-allowed',
                          opacity: player.ready ? 1 : 0.4,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Icon.Play s={11} />
                      </button>

                      {/* Add to queue */}
                      <button
                        onClick={(e) => { e.stopPropagation(); addToQueue(track) }}
                        title="Add to queue"
                        disabled={inQueue}
                        style={{
                          flexShrink: 0, width: '30px', height: '30px',
                          borderRadius: '50%', border: '1px solid #e0e0e0',
                          background: inQueue ? '#fff7f0' : '#fff',
                          color: inQueue ? '#f97316' : '#666',
                          cursor: inQueue ? 'default' : 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Icon.Plus />
                      </button>

                      {/* Remove from results */}
                      <button
                        onClick={(e) => { e.stopPropagation(); removeFromResults(track) }}
                        title="Remove from recommendations"
                        style={{
                          flexShrink: 0, width: '30px', height: '30px',
                          borderRadius: '50%', border: '1px solid #e0e0e0',
                          background: '#fff', color: '#999',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Icon.Trash />
                      </button>
                    </div>
                  )
                })}
              </div>

              {error && (
                <div style={{ padding: '12px 24px', color: '#e24b4a', fontSize: '12px' }}>
                  {error}
                  <button
                    onClick={() => { setError(null); runRecommend() }}
                    style={{ marginLeft: '8px', background: 'none', border: '1px solid #e24b4a', color: '#e24b4a', borderRadius: '12px', padding: '2px 10px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>

            {/* ── Mini player (sticky bottom) ─────────────── */}
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              height: '92px',
              background: '#000', color: '#fff',
              borderTopLeftRadius: '16px', borderTopRightRadius: '16px',
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '12px 14px 0',
              zIndex: 5,
              boxShadow: '0 -4px 20px rgba(0,0,0,0.08)',
            }}>
              <div style={{ position: 'absolute', top: '8px', left: '14px', right: '14px' }}>
                <PlaybackProgress
                  positionMs={player.positionMs}
                  durationMs={player.durationMs}
                  onSeek={player.seek}
                  dark
                />
              </div>
              {nowPlaying?.image
                ? <Image src={nowPlaying.image} alt="" width={48} height={48}
                    style={{ borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} />
                : <div style={{ width: 48, height: 48, borderRadius: '8px', background: '#222', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', color: '#555' }}>♪</div>
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nowPlaying ? nowPlaying.name : 'Nothing playing'}
                </div>
                <div style={{ fontSize: '11px', color: '#999', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nowPlaying ? nowPlaying.artist : 'Tap ▶ on a track above'}
                </div>
              </div>

              <button
                onClick={() => player.togglePlay()}
                disabled={!player.ready || !nowPlaying}
                title="Play / Pause"
                style={{
                  flexShrink: 0, width: '36px', height: '36px',
                  borderRadius: '50%', border: 'none',
                  background: '#fff', color: '#000',
                  cursor: (player.ready && nowPlaying) ? 'pointer' : 'not-allowed',
                  opacity: (player.ready && nowPlaying) ? 1 : 0.3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {player.isPlaying ? <Icon.Pause s={13} /> : <Icon.Play s={13} />}
              </button>

              <button
                onClick={playNext}
                disabled={!player.ready || noNextAvailable}
                title="Next"
                style={{
                  flexShrink: 0, width: '32px', height: '32px',
                  borderRadius: '50%', border: '1px solid #333',
                  background: 'transparent', color: '#fff',
                  cursor: noNextAvailable ? 'not-allowed' : 'pointer',
                  opacity: noNextAvailable ? 0.3 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon.Next s={12} />
              </button>

              <button
                onClick={() => setPlayerExpanded(true)}
                title="Show queue"
                style={{
                  flexShrink: 0, width: '32px', height: '32px',
                  borderRadius: '50%', border: '1px solid #333',
                  background: 'transparent', color: '#fff',
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <Icon.ChevUp />
              </button>
            </div>

            {/* ── Expanded player sheet ───────────────────── */}
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
              background: '#fafaf8',
              transform: playerExpanded ? 'translateY(0)' : 'translateY(100%)',
              transition: 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
              zIndex: 20,
              display: 'flex', flexDirection: 'column',
            }}>
              {/* Drag handle */}
              <div style={{ padding: '12px 0 4px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                <button
                  onClick={() => setPlayerExpanded(false)}
                  style={{
                    width: '40px', height: '4px', borderRadius: '2px',
                    background: '#ddd', border: 'none', cursor: 'pointer',
                  }}
                  aria-label="Collapse"
                />
              </div>
              <div style={{ padding: '0 16px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
                <button
                  onClick={() => setPlayerExpanded(false)}
                  style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', padding: '6px 8px', display: 'flex', alignItems: 'center', fontSize: '12px', fontFamily: 'inherit' }}
                  aria-label="Close"
                >
                  <Icon.ChevDn s={20} />
                </button>
              </div>

              {nowPlaying ? (
                <>
                  <div style={{ padding: '8px 32px 18px', display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
                    {nowPlaying.image
                      ? <Image src={nowPlaying.image} alt={nowPlaying.name} width={240} height={240}
                          style={{ borderRadius: '16px', objectFit: 'cover', boxShadow: '0 12px 40px rgba(0,0,0,0.18)' }} />
                      : <div style={{ width: 240, height: 240, borderRadius: '16px', background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '64px', color: '#ccc' }}>♪</div>
                    }
                  </div>

                  <div style={{ padding: '0 32px 14px', textAlign: 'center', flexShrink: 0 }}>
                    <div style={{ fontSize: '17px', fontWeight: 700, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {nowPlaying.name}
                    </div>
                    <div style={{ fontSize: '13px', color: '#888', marginTop: '4px' }}>{nowPlaying.artist}</div>
                  </div>

                  <div style={{ padding: '0 32px 18px', flexShrink: 0 }}>
                    <PlaybackProgress
                      positionMs={player.positionMs}
                      durationMs={player.durationMs}
                      onSeek={player.seek}
                      showTimes
                    />
                  </div>

                  <div style={{ padding: '0 32px 18px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '24px', flexShrink: 0 }}>
                    <button
                      onClick={() => player.togglePlay()}
                      disabled={!player.ready}
                      style={{
                        width: '60px', height: '60px',
                        borderRadius: '50%', border: 'none',
                        background: '#000', color: '#fff',
                        cursor: player.ready ? 'pointer' : 'not-allowed',
                        opacity: player.ready ? 1 : 0.4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {player.isPlaying ? <Icon.Pause s={20} /> : <Icon.Play s={20} />}
                    </button>
                    <button
                      onClick={playNext}
                      disabled={noNextAvailable}
                      style={{
                        width: '48px', height: '48px',
                        borderRadius: '50%', border: '1px solid #ddd',
                        background: '#fff', color: '#333',
                        cursor: noNextAvailable ? 'not-allowed' : 'pointer',
                        opacity: noNextAvailable ? 0.4 : 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      <Icon.Next s={16} />
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ padding: '40px 32px', textAlign: 'center', color: '#aaa', fontSize: '13px' }}>
                  Nothing playing yet. Tap ▶ on a track above.
                </div>
              )}

              {/* Up Next */}
              <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #f0f0f0', padding: '14px 0 24px' }}>
                <div style={{ padding: '0 24px 10px', fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase' }}>
                  Up Next · {Math.max(queue.length - 1, 0)}
                </div>
                {queue.length <= 1 ? (
                  <div style={{ padding: '20px 24px', fontSize: '12px', color: '#aaa', textAlign: 'center' }}>
                    Queue is empty. Add tracks from above.
                  </div>
                ) : (
                  queue.slice(1).map((track, i) => (
                    <div
                      key={track.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '12px',
                        padding: '8px 24px',
                      }}
                    >
                      <div style={{ color: '#ccc', fontSize: '11px', fontWeight: 600, width: '18px', flexShrink: 0 }}>
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      {track.image
                        ? <Image src={track.image} alt="" width={36} height={36}
                            style={{ borderRadius: '6px', objectFit: 'cover', flexShrink: 0 }} />
                        : <div style={{ width: 36, height: 36, borderRadius: '6px', background: '#eee', flexShrink: 0 }} />
                      }
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: '#222', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.name}
                        </div>
                        <div style={{ fontSize: '11px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.artist}
                        </div>
                      </div>
                      <button
                        onClick={() => setQueue(q => q.filter(t => t.id !== track.id))}
                        title="Remove from queue"
                        style={{
                          flexShrink: 0, width: '26px', height: '26px',
                          borderRadius: '50%', border: '1px solid #e0e0e0',
                          background: '#fff', color: '#aaa',
                          cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Icon.Trash s={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Player error toast */}
            {player.error && !playerExpanded && (
              <div style={{
                position: 'absolute', bottom: '100px', left: '24px', right: '24px',
                padding: '8px 12px', fontSize: '11px', color: '#e24b4a',
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px',
                zIndex: 6,
              }}>
                {player.error}
              </div>
            )}
          </>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      <Script src="https://sdk.scdn.co/spotify-player.js" strategy="afterInteractive" />
    </>
  )
}
