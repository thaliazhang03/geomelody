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

// Maps imu_state from backend → display label + scoreByGenres key
const IMU_MAP: Record<string, string> = {
  ACT_STILL:   'Still',
  ACT_WALKING: 'Walking',
  ACT_WORKING: 'Working',
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
        padding: '6px 14px',
        borderRadius: '20px',
        border:      selected ? '1.5px solid #f97316' : '1px solid #e0e0e0',
        background:  selected ? '#fff7f0' : '#fff',
        color:       selected ? '#f97316' : '#666',
        fontSize:    '13px',
        fontWeight:  selected ? 600 : 400,
        cursor:      'pointer',
        transition:  'all 0.15s',
        fontFamily:  'inherit',
      }}
    >
      {label}
    </button>
  )
}

// ─────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────
export default function GeoMelodyPage() {
  // Force 127.0.0.1 to keep PKCE origin consistent
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      window.location.href = window.location.href.replace('localhost', '127.0.0.1')
    }
  }, [])

  const [token,            setToken]            = useState<string | null>(null)
  const [step,             setStep]             = useState<Step>('source')
  const [source,           setSource]           = useState<Source | null>(null)
  const [library,          setLibrary]          = useState<Track[] | null>(null)
  const [loading,          setLoading]          = useState(false)
  const [error,            setError]            = useState<string | null>(null)
  const [scene,            setScene]            = useState('Café')
  const [mood,             setMood]             = useState('Focused')
  const [detectedActivity, setDetectedActivity] = useState<string>('Still')   // fetched from backend
  const [results,          setResults]          = useState<TrackWithReason[]>([])

  const player = usePlayer()

  useEffect(() => { setToken(getAccessToken()) }, [])

  // ── Fetch activity (IMU state) from FastAPI ──────────────
  async function fetchActivity(): Promise<string> {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000'
    try {
      const res  = await fetch(`${backendUrl}/latest-sensor-data`, { cache: 'no-store' })
      const data = await res.json() as { imu_state?: string }
      return IMU_MAP[data.imu_state ?? ''] ?? 'Still'
    } catch {
      console.warn('[page] Could not fetch activity — defaulting to Still')
      return 'Still'
    }
  }

  // ── Step 1: pick Liked Songs or Top Tracks ───────────────
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
      setStep('context')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2 → 3: call Claude API for recommendations ──────
  async function handleRecommend() {
    if (!library) return
    setLoading(true)
    setError(null)
    try {
      // Fetch activity from backend (IMU sensor)
      const activity = await fetchActivity()
      setDetectedActivity(activity)

      const recommendations = await scoreByGenres(
        library.map(t => ({ id: t.id, name: t.name, artist: t.artist, artistId: t.artistId })),
        scene, activity, mood
      )
      const resultTracks = recommendations
        .map(r => ({
          ...library.find(t => t.id === r.id)!,
          reason: r.reason,
        }))
        .filter(Boolean)

      setResults(resultTracks)
      setStep('results')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Refresh: re-run Claude with same scene/mood ───────────
  async function handleRefresh() {
    if (!library) return
    setLoading(true)
    setError(null)
    try {
      const activity = await fetchActivity()
      setDetectedActivity(activity)

      const recommendations = await scoreByGenres(
        library.map(t => ({ id: t.id, name: t.name, artist: t.artist, artistId: t.artistId })),
        scene, activity, mood
      )
      const resultTracks = recommendations
        .map(r => ({
          ...library.find(t => t.id === r.id)!,
          reason: r.reason,
        }))
        .filter(Boolean)

      setResults(resultTracks)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // ─────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────
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
    overflowX: 'hidden',
  }

  // ─────────────────────────────────────────────────────────
  // Login screen
  // ─────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────
  // Main app
  // ─────────────────────────────────────────────────────────
  return (
    <>
      <div style={phone}>

        {/* ── Header ─────────────────────────────────────── */}
        <div style={{ padding: '56px 24px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
              setSource(null); setStep('source')
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

            <div style={{ marginTop: '-8px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Where */}
              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '10px' }}>Where</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {SCENES.map(s => <Chip key={s} label={s} selected={scene === s} onClick={() => setScene(s)} />)}
                </div>
              </div>

              {/* Activity — auto-detected from sensor, shown as read-only badge */}
              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '10px' }}>
                  Activity
                  <span style={{ marginLeft: '8px', fontSize: '9px', color: '#f97316', letterSpacing: '0.1em' }}>AUTO</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    padding: '6px 14px', borderRadius: '20px',
                    border: '1.5px solid #f97316', background: '#fff7f0',
                    color: '#f97316', fontSize: '13px', fontWeight: 600,
                  }}>
                    {detectedActivity}
                  </span>
                  <span style={{ fontSize: '11px', color: '#bbb' }}>detected from sensor</span>
                </div>
              </div>

              {/* Mood */}
              <div>
                <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '10px' }}>Mood</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {MOODS.map(m => <Chip key={m} label={m} selected={mood === m} onClick={() => setMood(m)} />)}
                </div>
              </div>

              {error && <p style={{ color: '#e24b4a', fontSize: '13px' }}>{error}</p>}

              <button
                onClick={handleRecommend}
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

        {/* ── Step 3: Results ─────────────────────────────── */}
        {step === 'results' && (
          <div style={{ flex: 1, padding: '24px 0 40px' }}>
            {player.error && (
              <div style={{ padding: '8px 24px', fontSize: '11px', color: '#e24b4a', background: '#fef2f2', marginBottom: '8px' }}>
                {player.error}
              </div>
            )}

            {/* Results header row */}
            <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={() => setStep('context')}
                style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', padding: 0, fontFamily: 'inherit' }}
              >
                <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>
                Back
              </button>
              {/* Context tags: scene + detected activity + mood */}
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {[scene, detectedActivity, mood].map(tag => (
                  <span key={tag} style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '12px', border: '1px solid #e0e0e0', color: '#888' }}>{tag}</span>
                ))}
              </div>
            </div>

            {/* Track count */}
            <div style={{ padding: '0 24px', marginBottom: '20px' }}>
              <div style={{ fontSize: '10px', letterSpacing: '0.18em', color: '#bbb', textTransform: 'uppercase', marginBottom: '4px' }}>For you</div>
              <div style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-0.3px' }}>
                {results.length} <span style={{ color: '#f97316' }}>tracks</span>
              </div>
            </div>

            {/* Track list */}
            <div>
              {results.map((track, i) => {
                const isTop          = i === 0
                const isCurrent      = player.currentTrackId === track.id
                const isPlayingThis  = isCurrent && player.isPlaying

                return (
                  <div
                    key={track.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '14px',
                      padding: '12px 24px',
                      background: isTop ? '#fff7f0' : 'transparent',
                      borderBottom: '0.5px solid #f0f0f0',
                    }}
                  >
                    <div style={{ color: '#ddd', fontSize: '11px', fontWeight: 700, width: '18px', textAlign: 'center', flexShrink: 0 }}>
                      {String(i + 1).padStart(2, '0')}
                    </div>

                    {track.image
                      ? <Image src={track.image} alt={track.name} width={48} height={48}
                          style={{ borderRadius: '10px', objectFit: 'cover', flexShrink: 0, filter: (isTop || isCurrent) ? 'none' : 'grayscale(1)' }} />
                      : <div style={{ width: 48, height: 48, borderRadius: '10px', background: '#f0f0f0', flexShrink: 0 }} />
                    }

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: isCurrent ? '#1ed760' : '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {track.name}
                      </div>
                      <div style={{ fontSize: '12px', color: '#aaa', marginTop: '2px' }}>{track.artist}</div>
                      {track.reason && (
                        <div style={{ fontSize: '11px', color: '#f97316', marginTop: '4px', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.reason}
                        </div>
                      )}
                    </div>

                    {/* Play / Pause */}
                    <button
                      onClick={() => isPlayingThis ? player.togglePlay() : player.playTrack(track.uri)}
                      disabled={!player.ready}
                      title={player.ready ? (isPlayingThis ? 'Pause' : 'Play here') : 'Player loading…'}
                      style={{
                        flexShrink: 0, width: '32px', height: '32px',
                        borderRadius: '50%', border: 'none',
                        background: isPlayingThis ? '#1ed760' : '#000',
                        color: '#fff',
                        cursor: player.ready ? 'pointer' : 'not-allowed',
                        opacity: player.ready ? 1 : 0.4,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {isPlayingThis
                        ? <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>
                        : <svg width="10" height="10" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      }
                    </button>

                    {/* Open in Spotify */}
                    <a
                      href={`https://open.spotify.com/track/${track.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open in Spotify"
                      style={{
                        flexShrink: 0, width: '32px', height: '32px',
                        borderRadius: '50%', border: '1px solid #e0e0e0',
                        background: '#fff', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        color: '#888', textDecoration: 'none',
                      }}
                    >
                      <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M7 17L17 7M17 7H7M17 7V17"/>
                      </svg>
                    </a>
                  </div>
                )
              })}
            </div>

            {/* Bottom action buttons */}
            <div style={{ padding: '24px 24px 0', display: 'flex', flexDirection: 'column', gap: '10px' }}>

              {/* Refresh — re-call Claude with same scene/mood */}
              <button
                onClick={handleRefresh}
                disabled={loading}
                style={{
                  width: '100%', padding: '14px', background: '#000', color: '#fff',
                  border: 'none', borderRadius: '14px', fontSize: '14px', fontWeight: 600,
                  cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit',
                  opacity: loading ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                }}
              >
                {loading
                  ? <>
                      <div style={{ width: '14px', height: '14px', border: '2px solid #444', borderTop: '2px solid #fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                      Refreshing…
                    </>
                  : <>
                      {/* Refresh icon */}
                      <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                        <path d="M3.51 9a9 9 0 0114.36-3.36L23 10M1 14l5.13 4.36A9 9 0 0020.49 15"/>
                      </svg>
                      Try different tracks
                    </>
                }
              </button>

              {/* Change context — go back to scene/mood selection */}
              <button
                onClick={() => setStep('context')}
                style={{
                  width: '100%', padding: '14px', background: 'transparent',
                  border: '1px solid #e0e0e0', borderRadius: '14px',
                  fontSize: '14px', color: '#666', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Change context
              </button>
            </div>

            {error && (
              <p style={{ color: '#e24b4a', fontSize: '13px', padding: '12px 24px 0' }}>{error}</p>
            )}
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>

      <Script src="https://sdk.scdn.co/spotify-player.js" strategy="afterInteractive" />
    </>
  )
}
