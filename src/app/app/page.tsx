'use client'

import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

export default function AppPage() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const router = useRouter()

  useEffect(() => {
    const loadUser = async () => {
      const { data } = await supabase.auth.getUser()

      if (!data.user) {
        router.push('/login')
        return
      }

      setUser(data.user)
      setLoading(false)
    }

    loadUser()
  }, [router])

  if (loading || !user) return <div>Loading...</div>

  return (
    <div style={{ padding: 24 }}>
      <h1>Welcome</h1>
      <p>{user.email}</p>
    </div>
  )
}