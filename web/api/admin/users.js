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
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  const { data: { user }, error } = await admin.auth.getUser(token)
  if (error || user?.email !== process.env.ADMIN_EMAIL)
    return res.status(403).json({ error: 'Forbidden' })

  const { data: subs } = await admin
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: false })

  const list = subs || []

  // 기기 ID 같이 반환 (중복 체험 방지 진단용)
  if (list.length > 0) {
    const userIds = list.map(s => s.user_id).filter(Boolean)
    const { data: trials } = await admin
      .from('device_trials')
      .select('user_id, device_id')
      .in('user_id', userIds)

    const deviceMap = {}
    for (const t of trials || []) {
      if (!deviceMap[t.user_id]) deviceMap[t.user_id] = []
      deviceMap[t.user_id].push(t.device_id)
    }
    for (const s of list) {
      s.device_ids = deviceMap[s.user_id] || []
    }
  }

  res.json(list)
}
