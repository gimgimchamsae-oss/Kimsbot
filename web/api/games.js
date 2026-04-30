import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_KEY
)

function mirrorProtoBetting(rows = []) {
  const mirrored = rows.map(row => ({
    ...row,
    home: row.away,
    away: row.home,
    home_abbr: row.away_abbr,
    away_abbr: row.home_abbr,
    ml_bets_home: row.ml_bets_away,
    ml_bets_away: row.ml_bets_home,
    sp_bets_home: row.sp_bets_away,
    sp_bets_away: row.sp_bets_home,
  }))
  return expandProtoDates([...rows, ...mirrored])
}

function shiftDate(date, days) {
  if (!date) return date
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function expandProtoDates(rows = []) {
  return rows.flatMap(row => [
    { ...row, game_date: '' },
    { ...row, game_date: shiftDate(row.game_date, -2) },
    { ...row, game_date: shiftDate(row.game_date, -1) },
    row,
    { ...row, game_date: shiftDate(row.game_date, 1) },
    { ...row, game_date: shiftDate(row.game_date, 2) },
  ])
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Vercel CDN이 10분간 캐시 → Supabase는 10분마다 1번만 호출
  res.setHeader('Cache-Control', 'no-store, max-age=0')

  try {
    const [linesRes, alertsRes, pbRes, protoRes] = await Promise.all([
      supabase.from('latest_lines').select('*').order('starts_at', { ascending: true }),
      supabase.from('alerts').select('matchup_id,alert_type,threshold').order('id', { ascending: false }).limit(500),
      supabase.from('public_betting').select('*'),
      supabase.from('proto_betting').select('*'),
    ])

    const currentIds = [...new Set((linesRes.data || []).map(g => g.matchup_id))]
    const openingsRes = await supabase
      .from('opening_lines')
      .select('matchup_id,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under')
      .in('matchup_id', currentIds)

    res.json({
      apiVersion: 'proto-date-expanded-v2',
      lines:         linesRes.data    || [],
      openings:      openingsRes.data || [],
      alerts:        alertsRes.data   || [],
      publicBetting: pbRes.data       || [],
      protoBetting:  mirrorProtoBetting(protoRes.data || []),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
