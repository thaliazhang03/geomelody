'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { handleCallback } from '../_lib/auth'

export default function CallbackPage() {
  const router = useRouter()
  const called = useRef(false)

  useEffect(() => {
    if (called.current) return
    called.current = true

    handleCallback().then(token => {
      if (token) {
        router.replace('/projects/geomelody')
      } else {
        router.replace('/projects/geomelody?error=auth_failed')
      }
    })
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950">
      <div className="text-center">
        <div className="text-4xl mb-4">🎵</div>
        <p className="text-neutral-400 text-sm">正在连接 Spotify…</p>
      </div>
    </div>
  )
}