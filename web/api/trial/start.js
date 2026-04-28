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
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' })

  const { deviceId } = req.body
  if (!deviceId) return res.status(400).json({ error: 'No device ID' })

  // 동일 기기 체험 중복 방지
  const { data: existing } = await admin
    .from('device_trials')
    .select('device_id')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (existing) return res.status(400).json({ error: 'device_already_used' })

  // 체험 시작
  const now = new Date().toISOString()
  await admin.from('subscriptions').upsert(
    { user_id: user.id, email: user.email, trial_started_at: now },
    { onConflict: 'user_id' }
  )

  // 기기 등록
  await admin.from('device_trials').insert({ device_id: deviceId, user_id: user.id })

  res.json({ ok: true })
}
