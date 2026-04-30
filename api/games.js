const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY

const TEAM_ABBREV = {
  'Arizona Diamondbacks':'AZ','Atlanta Braves':'ATL','Baltimore Orioles':'BAL',
  'Boston Red Sox':'BOS','Chicago Cubs':'CHC','Chicago White Sox':'CWS',
  'Cincinnati Reds':'CIN','Cleveland Guardians':'CLE','Colorado Rockies':'COL',
  'Detroit Tigers':'DET','Houston Astros':'HOU','Kansas City Royals':'KC',
  'Los Angeles Angels':'LAA','Los Angeles Dodgers':'LAD','Miami Marlins':'MIA',
  'Milwaukee Brewers':'MIL','Minnesota Twins':'MIN','New York Mets':'NYM',
  'New York Yankees':'NYY','Athletics':'ATH','Oakland Athletics':'ATH',
  'Philadelphia Phillies':'PHI','Pittsburgh Pirates':'PIT','San Diego Padres':'SD',
  'San Francisco Giants':'SF','Seattle Mariners':'SEA','St. Louis Cardinals':'STL',
  'Tampa Bay Rays':'TB','Texas Rangers':'TEX','Toronto Blue Jays':'TOR',
  'Washington Nationals':'WSH',
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN',
  'Charlotte Hornets':'CHA','Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE',
  'Dallas Mavericks':'DAL','Denver Nuggets':'DEN','Detroit Pistons':'DET',
  'Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','Memphis Grizzlies':'MEM',
  'Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN',
  'New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC',
  'Orlando Magic':'ORL','Philadelphia 76ers':'PHI','Phoenix Suns':'PHX',
  'Portland Trail Blazers':'POR','Sacramento Kings':'SAC','San Antonio Spurs':'SAS',
  'Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WSH',
}

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

function lineGameDate(startsAt) {
  const match = String(startsAt || '').match(/^(\d{2})\/(\d{2})/)
  if (!match) return ''
  const year = new Date().getFullYear()
  return `${year}-${match[1]}-${match[2]}`
}

function buildLineCompatibleProto(lines = [], protoRows = []) {
  const compat = []
  for (const game of lines) {
    if (game.league !== 'MLB' && game.league !== 'NBA') continue
    if (/(Games\))/i.test(game.home || '') || /(Games\))/i.test(game.away || '')) continue
    const homeAbbr = TEAM_ABBREV[game.home]
    const awayAbbr = TEAM_ABBREV[game.away]
    if (!homeAbbr || !awayAbbr) continue
    const protoSport = game.sport === 'baseball' ? 'baseball' : game.sport === 'basketball' ? 'basketball' : null
    if (!protoSport) continue
    const found = protoRows.find(row =>
      row.sport === protoSport &&
      row.league === game.league &&
      (
        (row.home_abbr === homeAbbr && row.away_abbr === awayAbbr) ||
        (row.home_abbr === awayAbbr && row.away_abbr === homeAbbr)
      )
    )
    if (!found) continue
    const reversed = found.home_abbr === awayAbbr && found.away_abbr === homeAbbr
    compat.push({
      ...found,
      home: reversed ? found.away : found.home,
      away: reversed ? found.home : found.away,
      home_abbr: homeAbbr,
      away_abbr: awayAbbr,
      game_date: lineGameDate(game.starts_at),
      ml_bets_home: reversed ? found.ml_bets_away : found.ml_bets_home,
      ml_bets_away: reversed ? found.ml_bets_home : found.ml_bets_away,
      sp_bets_home: reversed ? found.sp_bets_away : found.sp_bets_home,
      sp_bets_away: reversed ? found.sp_bets_home : found.sp_bets_away,
    })
  }
  return [...compat, ...mirrorProtoBetting(protoRows)]
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
      protoBetting: buildLineCompatibleProto(lines || [], protoRows || []),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
