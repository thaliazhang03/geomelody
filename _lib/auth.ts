const CLIENT_ID = process.env.NEXT_PUBLIC_SPOTIFY_CLIENT_ID!

const REDIRECT_URI = typeof window !== 'undefined'
  ? `${window.location.origin}/projects/geomelody/callback`
  : ''

const SCOPES = [
  'user-library-read',
  'playlist-read-private',
  'user-top-read',  
  'playlist-read-collaborative',
  'streaming',
  'user-read-email',
].join(' ')

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  if (window.crypto?.subtle) {
    const data = new TextEncoder().encode(verifier)
    const digest = await window.crypto.subtle.digest('SHA-256', data)
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
  // http fallback (dev only)
  return btoa(verifier)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function loginWithSpotify(): Promise<void> {
  const state = generateRandomString(16)
  const codeVerifier = generateRandomString(64)
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const method = window.crypto?.subtle ? 'S256' : 'plain'

  localStorage.setItem('spotify_auth_state', state)
  localStorage.setItem('spotify_code_verifier', codeVerifier)
  

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge_method: method,
    code_challenge: codeChallenge,
  })

  window.location.href = `https://accounts.spotify.com/authorize?${params}`
}

export async function handleCallback(): Promise<string | null> {

  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')
  const savedState = localStorage.getItem('spotify_auth_state')
  const codeVerifier = localStorage.getItem('spotify_code_verifier')

  if (!code || state !== savedState || !codeVerifier) {
    return null
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${errText}`)
  }

  const data = await res.json()

  localStorage.setItem('spotify_access_token', data.access_token)
  localStorage.removeItem('spotify_auth_state')
  localStorage.removeItem('spotify_code_verifier')

  return data.access_token
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('spotify_access_token')
}

export function logout(): void {
  localStorage.removeItem('spotify_access_token')
}