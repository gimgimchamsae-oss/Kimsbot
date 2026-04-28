import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const token = req.headers.authorization?.replace('Bearer ', '')
  const { data: { user }, error } = await admin.auth.getUser(token)
  if (error || user?.email !== process.env.ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' })

  const { userId, days } = req.body

  const { data: existing } = await admin
    .from('subscriptions').select('sub_expires_at').eq('user_id', userId).maybeSingle()

  const base = existing?.sub_expires_at && new Date(existing.sub_expires_at) > new Date()
    ? new Date(existing.sub_expires_at)
    : new Date()
  base.setDate(base.getDate() + days)

  await admin.from('subscriptions').upsert({
    user_id: userId,
    sub_expires_at: base.toISOString(),
    plan: `${days}일`,
  }, { onConflict: 'user_id' })

  res.json({ ok: true, expires_at: base.toISOString() })
}
