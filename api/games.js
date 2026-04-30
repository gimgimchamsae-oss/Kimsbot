const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY

async function supabaseGet(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}

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
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    const [lines, alerts, publicBetting, protoRows] = await Promise.all([
      supabaseGet('latest_lines?select=*&order=starts_at.asc'),
      supabaseGet('alerts?select=matchup_id,alert_type,threshold&order=id.desc&limit=500'),
      supabaseGet('public_betting?select=*'),
      supabaseGet('proto_betting?select=*'),
    ])

    const currentIds = [...new Set((lines || []).map(g => g.matchup_id))]
    const openings = currentIds.length
      ? await supabaseGet(
          `opening_lines?select=matchup_id,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under&matchup_id=in.(${currentIds.join(',')})`
        )
      : []

    res.json({
      apiVersion: 'proto-date-expanded-v2',
      lines: lines || [],
      openings: openings || [],
      alerts: alerts || [],
      publicBetting: publicBetting || [],
      protoBetting: mirrorProtoBetting(protoRows || []),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
