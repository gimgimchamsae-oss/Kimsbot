import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_KEY
)

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

function normalizeProtoOu(rows = []) {
  return rows.map(row => ({
    ...row,
    ou_bets_over: row.ou_bets_under,
    ou_bets_under: row.ou_bets_over,
  }))
}

function lineGameDate(startsAt) {
  const match = String(startsAt || '').match(/^(\d{2})\/(\d{2})/)
  if (!match) return ''
  const year = new Date().getFullYear()
  return `${year}-${match[1]}-${match[2]}`
}

function todayKstDate() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

function isCurrentOrFutureLine(game) {
  const gameDate = lineGameDate(game.starts_at)
  return !gameDate || gameDate >= todayKstDate()
}

const SOCCER_TEAM_ALIASES = {
  oaklandfc: 'aucklandfc',
  gangwon: 'gangwonfc',
  fcanyang: 'anyang',
  bucheonfc: 'bucheonfc1995',
  gimpo: 'gimpofc',
  gyeongnam: 'gyeongnamfc',
  hwaseong: 'hwaseongfc',
  gimhae: 'gimhaefc',
  yongin: 'yonginfc',
  cheongjufc: 'chungbukcheongju',
  suwonbluewings: 'suwonsamsung',
  lafc: 'losangelesfc',
  lagalaxy: 'losangelesgalaxy',
  newyorkcityfc: 'newyorkcity',
  stlouiscity: 'stlouiscitysc',
  inter: 'internazionale',
  intermilian: 'internazionale',
  intermilano: 'internazionale',
  intermilans: 'internazionale',
  intermilan: 'internazionale',
}

function normTeam(value) {
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return SOCCER_TEAM_ALIASES[key] || key
}

function protoSportForGame(game) {
  if (game.sport === 'baseball') return 'baseball'
  if (game.sport === 'basketball') return 'basketball'
  if (game.sport === 'soccer') return 'soccer'
  return null
}

function lineTeamNames(game) {
  if (game.league === 'MLB' || game.league === 'NBA') {
    const homeAbbr = TEAM_ABBREV[game.home]
    const awayAbbr = TEAM_ABBREV[game.away]
    if (!homeAbbr || !awayAbbr) return null
    return { homeAbbr, awayAbbr }
  }
  if (game.sport === 'soccer') {
    return { homeAbbr: game.home, awayAbbr: game.away }
  }
  return null
}

function buildLineCompatibleProto(lines = [], protoRows = []) {
  const compat = []
  for (const game of lines) {
    if (/(Games\))/i.test(game.home || '') || /(Games\))/i.test(game.away || '')) continue
    const names = lineTeamNames(game)
    if (!names) continue
    const { homeAbbr, awayAbbr } = names
    const protoSport = protoSportForGame(game)
    if (!protoSport) continue
    const found = protoRows.find(row =>
      row.sport === protoSport &&
      (protoSport === 'soccer' || row.league === game.league) &&
      (
        (normTeam(row.home_abbr) === normTeam(homeAbbr) && normTeam(row.away_abbr) === normTeam(awayAbbr)) ||
        (normTeam(row.home_abbr) === normTeam(awayAbbr) && normTeam(row.away_abbr) === normTeam(homeAbbr))
      )
    )
    if (!found) continue
    const reversed = normTeam(found.home_abbr) === normTeam(awayAbbr) && normTeam(found.away_abbr) === normTeam(homeAbbr)
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

function findProtoUnmatched(lines = [], protoRows = []) {
  return lines
    .filter(game => !/(Games\))/i.test(game.home || '') && !/(Games\))/i.test(game.away || ''))
    .filter(isCurrentOrFutureLine)
    .map(game => {
      const names = lineTeamNames(game)
      const protoSport = protoSportForGame(game)
      if (!names || !protoSport) return null
      const { homeAbbr, awayAbbr } = names
      const matched = protoRows.some(row =>
        row.sport === protoSport &&
        (protoSport === 'soccer' || row.league === game.league) &&
        (
          (normTeam(row.home_abbr) === normTeam(homeAbbr) && normTeam(row.away_abbr) === normTeam(awayAbbr)) ||
          (normTeam(row.home_abbr) === normTeam(awayAbbr) && normTeam(row.away_abbr) === normTeam(homeAbbr))
        )
      )
      if (matched) return null
      const candidates = protoRows
        .filter(row => row.sport === protoSport && (protoSport === 'soccer' || row.league === game.league))
        .slice(0, 5)
        .map(row => `${row.home_abbr} vs ${row.away_abbr}`)
      return {
        sport: game.sport,
        league: game.league,
        home: game.home,
        away: game.away,
        starts_at: game.starts_at,
        expected_home: homeAbbr,
        expected_away: awayAbbr,
        candidates,
      }
    })
    .filter(Boolean)
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

    const normalizedProtoRows = normalizeProtoOu(protoRes.data || [])

    res.json({
      apiVersion: 'proto-debug-unmatched-v1',
      lines:         linesRes.data    || [],
      openings:      openingsRes.data || [],
      alerts:        alertsRes.data   || [],
      publicBetting: pbRes.data       || [],
      protoBetting:  buildLineCompatibleProto(linesRes.data || [], normalizedProtoRows),
      protoUnmatched: findProtoUnmatched(linesRes.data || [], normalizedProtoRows),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
