'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

// Dev-account login is gated behind NEXT_PUBLIC_DEV_LOGIN_EMAILS so the
// account list never ships in the production bundle. The env var is a
// comma-separated list of emails; if it's unset (Vercel prod) the entire
// dev-login UI is omitted from the rendered page and the dev addresses
// are not present in the JS bundle either.
//
// Local dev / preview deployments opt in by setting e.g.
//   NEXT_PUBLIC_DEV_LOGIN_EMAILS=dev01@academicats.com,dev02@academicats.com
// in `.env.local` or the preview env. Build-time inlining means the value
// must be referenced as `process.env.NEXT_PUBLIC_DEV_LOGIN_EMAILS`
// directly — see node_modules/next/dist/docs/01-app/02-guides/environment-variables.md.
const DEV_ACCOUNTS: string[] = (process.env.NEXT_PUBLIC_DEV_LOGIN_EMAILS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

export default function LoginPage() {
  const [googleLoading, setGoogleLoading] = useState(false)
  const [selectedDev, setSelectedDev] = useState<string | null>(null)
  const [devPassword, setDevPassword] = useState('')
  const [devLoading, setDevLoading] = useState(false)
  const [message, setMessage] = useState('')
  const router = useRouter()

  const handleGoogleLogin = async () => {
    setGoogleLoading(true)
    setMessage('')
    const redirectTo = typeof window !== 'undefined'
      ? `${window.location.origin}/`
      : 'https://academic-ats-frontend.vercel.app/'
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    })
    if (error) {
      setMessage(error.message)
      setGoogleLoading(false)
    }
  }

  const handleDevLogin = async () => {
    if (!selectedDev || !devPassword) return
    setDevLoading(true)
    setMessage('')
    const { error } = await supabase.auth.signInWithPassword({
      email: selectedDev,
      password: devPassword,
    })
    if (error) {
      setMessage(error.message)
      setDevLoading(false)
    } else {
      router.push('/')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="w-full max-w-md space-y-4 rounded-2xl border bg-white p-8 shadow-sm">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold"><span className="text-gray-900">Academi</span><span className="text-blue-500">Cats</span></h1>
          <p className="text-sm text-gray-500">Sign in to continue</p>
        </div>

        {/* ── Google login ── */}
        <button
          onClick={handleGoogleLogin}
          disabled={googleLoading}
          className="w-full flex items-center justify-center gap-3 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {googleLoading ? (
            <span>Redirecting…</span>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
                <path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-9 20-20 0-1.2-.1-2.4-.4-3.5z" fill="#FFC107"/>
                <path d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.5 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" fill="#FF3D00"/>
                <path d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.9 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8H6.1C9.4 35.6 16.2 44 24 44z" fill="#4CAF50"/>
                <path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.5 5.5C41.7 36.2 44 30.5 44 24c0-1.2-.1-2.4-.4-3.5z" fill="#1976D2"/>
              </svg>
              Continue with Google
            </>
          )}
        </button>

        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-gray-200" />
          <span className="text-xs text-gray-400">or</span>
          <div className="flex-1 border-t border-gray-200" />
        </div>

        {/* ── Email magic link (coming soon) ── */}
        <div className="space-y-2 opacity-40 cursor-not-allowed select-none">
          <input
            type="email"
            placeholder="Enter your email"
            disabled
            className="w-full rounded-lg border px-3 py-2 text-sm bg-gray-50 text-gray-400 cursor-not-allowed"
          />
          <button
            disabled
            className="w-full rounded-lg bg-gray-200 px-4 py-2 text-sm text-gray-400 cursor-not-allowed"
          >
            Continue with Email (Coming Soon)
          </button>
        </div>

        {/* ── Dev accounts (only rendered when NEXT_PUBLIC_DEV_LOGIN_EMAILS is set) ── */}
        {DEV_ACCOUNTS.length > 0 && (
        <div className="pt-2 border-t border-dashed border-gray-200 space-y-2">
          <p className="text-xs text-gray-400">Dev accounts</p>

          {/* Account selector */}
          <div className="space-y-1">
            {DEV_ACCOUNTS.map(devEmail => (
              <button
                key={devEmail}
                onClick={() => { setSelectedDev(devEmail); setDevPassword(''); setMessage(''); }}
                className={`w-full rounded-lg border px-4 py-2 text-sm text-left transition-colors ${
                  selectedDev === devEmail
                    ? 'border-black bg-black text-white'
                    : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {devEmail}
              </button>
            ))}
          </div>

          {/* Password input — shown when an account is selected */}
          {selectedDev && (
            <div className="space-y-2 pt-1">
              <input
                type="password"
                placeholder="Password"
                value={devPassword}
                onChange={e => setDevPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleDevLogin()}
                autoFocus
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
              />
              <button
                onClick={handleDevLogin}
                disabled={devLoading || !devPassword}
                className="w-full rounded-lg bg-black px-4 py-2 text-sm text-white disabled:opacity-50 transition-opacity"
              >
                {devLoading ? 'Signing in…' : `Sign in as ${selectedDev.split('@')[0]}`}
              </button>
            </div>
          )}
        </div>
        )}

        {message && (
          <p className="text-sm text-red-500">{message}</p>
        )}
      </div>
    </div>
  )
}
