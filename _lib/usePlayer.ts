'use client'

import { useEffect, useRef, useState } from 'react'
import { getAccessToken } from './auth'

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void
    Spotify?: SpotifySDK
  }
}

type SpotifyError = { message: string }

type SpotifyPlaybackState = {
  paused: boolean
  position: number
  duration: number
  track_window?: {
    current_track?: {
      id?: string | null
    }
  }
}

type SpotifyPlayerOptions = {
  name: string
  getOAuthToken: (cb: (token: string) => void) => void
  volume: number
}

type SpotifyPlayer = {
  addListener(event: 'ready', cb: (payload: { device_id: string }) => void): void
  addListener(event: 'not_ready', cb: () => void): void
  addListener(event: 'player_state_changed', cb: (state: SpotifyPlaybackState | null) => void): void
  addListener(event: 'initialization_error' | 'authentication_error' | 'account_error', cb: (payload: SpotifyError) => void): void
  connect(): Promise<boolean>
  disconnect(): void
  getCurrentState(): Promise<SpotifyPlaybackState | null>
  togglePlay(): Promise<void>
  seek(positionMs: number): Promise<void>
}

type SpotifySDK = {
  Player: new (options: SpotifyPlayerOptions) => SpotifyPlayer
}

export interface PlayerState {
  ready: boolean
  deviceId: string | null
  currentTrackId: string | null
  isPlaying: boolean
  positionMs: number
  durationMs: number
  endedTrackId: string | null
  error: string | null
}

const RETRYABLE_PLAY_STATUS = new Set([502, 503, 504])

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

async function readSpotifyError(res: Response) {
  const text = await res.text().catch(() => '')

  if (res.status === 401) {
    return 'Play failed: session expired. Please log in again.'
  }

  if (res.status === 403) {
    return `Play failed: Spotify rejected this request. Make sure the account is Premium and log in again to grant playback control. ${text}`
  }

  if (res.status === 502) {
    return `Play failed: Spotify returned 502 Bad Gateway. The browser player may still be waking up, or Spotify is temporarily unavailable. ${text}`
  }

  return `Play failed: ${res.status} ${text}`
}

export function usePlayer() {
  const [state, setState] = useState<PlayerState>({
    ready: false,
    deviceId: null,
    currentTrackId: null,
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    endedTrackId: null,
    error: null,
  })
  const playerRef = useRef<SpotifyPlayer | null>(null)
  const progressTimerRef = useRef<number | null>(null)
  const lastSnapshotRef = useRef<{
    trackId: string | null
    isPlaying: boolean
    positionMs: number
    durationMs: number
  } | null>(null)
  const endedTrackRef = useRef<string | null>(null)

  useEffect(() => {
    const token = getAccessToken()
    if (!token) return

    // SDK 可能比这个 effect 先就绪,也可能后就绪。两种情况都处理
    function init() {
      if (!window.Spotify || playerRef.current) return

      function clearProgressTimer() {
        if (progressTimerRef.current !== null) {
          window.clearInterval(progressTimerRef.current)
          progressTimerRef.current = null
        }
      }

      function applySpotifyState(st: SpotifyPlaybackState | null) {
        if (!st) return

        const trackId = st.track_window?.current_track?.id ?? null
        const positionMs = Math.max(0, st.position ?? 0)
        const durationMs = Math.max(0, st.duration ?? 0)
        const isPlaying = !st.paused
        const previous = lastSnapshotRef.current
        const previousNearEnd = Boolean(
          previous &&
          previous.durationMs > 0 &&
          previous.positionMs >= previous.durationMs - 1800
        )
        const currentNearEnd = durationMs > 0 && positionMs >= durationMs - 1200
        const endedTrackId =
          trackId &&
          previous?.trackId === trackId &&
          previous.isPlaying &&
          !isPlaying &&
          (currentNearEnd || previousNearEnd)
            ? trackId
            : null

        if (endedTrackId && endedTrackRef.current !== endedTrackId) {
          endedTrackRef.current = endedTrackId
        }

        lastSnapshotRef.current = { trackId, isPlaying, positionMs, durationMs }

        setState(s => ({
          ...s,
          currentTrackId: trackId,
          isPlaying,
          positionMs,
          durationMs,
          endedTrackId: endedTrackId ? endedTrackRef.current : s.endedTrackId,
        }))
      }

      const player = new window.Spotify.Player({
        name: 'GeoMelody Player',
        getOAuthToken: (cb: (t: string) => void) => {
          const t = getAccessToken()
          if (t) cb(t)
        },
        volume: 0.7,
      })

      player.addListener('ready', ({ device_id }: { device_id: string }) => {
        setState(s => ({ ...s, ready: true, deviceId: device_id, error: null }))
        clearProgressTimer()
        progressTimerRef.current = window.setInterval(async () => {
          const st = await player.getCurrentState().catch(() => null)
          applySpotifyState(st)
        }, 500)
      })

      player.addListener('not_ready', () => {
        setState(s => ({ ...s, ready: false }))
        clearProgressTimer()
      })

      player.addListener('player_state_changed', (st: SpotifyPlaybackState | null) => {
        applySpotifyState(st)
      })

      player.addListener('initialization_error', ({ message }: SpotifyError) =>
        setState(s => ({ ...s, error: `Init: ${message}` }))
      )
      player.addListener('authentication_error', ({ message }: SpotifyError) =>
        setState(s => ({ ...s, error: `Auth: ${message}` }))
      )
      player.addListener('account_error', ({ message }: SpotifyError) =>
        setState(s => ({ ...s, error: `Account: ${message} (Premium required)` }))
      )

      player.connect()
      playerRef.current = player
    }

    if (window.Spotify) {
      init()
    } else {
      window.onSpotifyWebPlaybackSDKReady = init
    }

    return () => {
      if (progressTimerRef.current !== null) {
        window.clearInterval(progressTimerRef.current)
      }
      playerRef.current?.disconnect()
      playerRef.current = null
    }
  }, [])

  // 把指定 track 在我们的 player 上播放
  async function playTrack(trackUri: string) {
    const token = getAccessToken()
    if (!token || !state.deviceId) {
      setState(s => ({ ...s, error: 'Player not ready' }))
      return
    }

    const url = `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`
    const request: RequestInit = {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: [trackUri] }),
    }

    let res = await fetch(url, request)

    if (RETRYABLE_PLAY_STATUS.has(res.status)) {
      await wait(500)
      res = await fetch(url, request)
    }

    if (!res.ok) {
      const err = await readSpotifyError(res)
      setState(s => ({ ...s, error: err }))
      return
    }

    setState(s => ({ ...s, error: null }))
    endedTrackRef.current = null
    lastSnapshotRef.current = null
    setState(s => ({ ...s, endedTrackId: null, positionMs: 0 }))
  }

  async function togglePlay() {
    await playerRef.current?.togglePlay()
  }

  async function seek(positionMs: number) {
    const safePosition = Math.max(0, Math.min(positionMs, state.durationMs || positionMs))
    await playerRef.current?.seek(safePosition)
    setState(s => ({ ...s, positionMs: safePosition, endedTrackId: null }))
    endedTrackRef.current = null
  }

  return { ...state, playTrack, togglePlay, seek }
}
