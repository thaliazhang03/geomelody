'use client'

import { useEffect, useRef, useState } from 'react'
import { getAccessToken } from './auth'

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady: () => void
    Spotify: any
  }
}

export interface PlayerState {
  ready: boolean
  deviceId: string | null
  currentTrackId: string | null
  isPlaying: boolean
  error: string | null
}

export function usePlayer() {
  const [state, setState] = useState<PlayerState>({
    ready: false,
    deviceId: null,
    currentTrackId: null,
    isPlaying: false,
    error: null,
  })
  const playerRef = useRef<any>(null)

  useEffect(() => {
    const token = getAccessToken()
    if (!token) return

    // SDK 可能比这个 effect 先就绪,也可能后就绪。两种情况都处理
    function init() {
      if (!window.Spotify || playerRef.current) return

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
      })

      player.addListener('not_ready', () => {
        setState(s => ({ ...s, ready: false }))
      })

      player.addListener('player_state_changed', (st: any) => {
        if (!st) return
        setState(s => ({
          ...s,
          currentTrackId: st.track_window?.current_track?.id ?? null,
          isPlaying: !st.paused,
        }))
      })

      player.addListener('initialization_error', ({ message }: any) =>
        setState(s => ({ ...s, error: `Init: ${message}` }))
      )
      player.addListener('authentication_error', ({ message }: any) =>
        setState(s => ({ ...s, error: `Auth: ${message}` }))
      )
      player.addListener('account_error', ({ message }: any) =>
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

    const res = await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${state.deviceId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uris: [trackUri] }),
      }
    )

    if (!res.ok) {
      const err = await res.text().catch(() => '')
      setState(s => ({ ...s, error: `Play failed: ${res.status} ${err}` }))
    }
  }

  async function togglePlay() {
    await playerRef.current?.togglePlay()
  }

  return { ...state, playTrack, togglePlay }
}