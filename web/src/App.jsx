import { useState, useEffect } from 'react'
import { supabase } from './supabase'

function isInPast(startsAt) {
  if (!startsAt) return false
  try {
    const m = startsAt.match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
    if (!m) return false
    const year = new Date().getFullYear()
    const utcMs = Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[3]) - 9, parseInt(m[4]))
    return utcMs < Date.now()
  } catch { return false }
}

const LEAGUE_FLAGS = {
  MLB: '🇺🇸', KBO: '🇰🇷', NPB: '🇯🇵',
  EPL: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Bundesliga: '🇩🇪', 'Serie A': '🇮🇹',
  'Ligue 1': '🇫🇷', 'La Liga': '🇪🇸',
  'K리그1': '🇰🇷', MLS: '🇺🇸',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸',
  NHL: '🇺🇸',
}

const ALL_LEAGUES = [
  'MLB', 'KBO', 'NPB',
  'EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'MLS', 'UCL', 'Europa', 'Conference',
  'NBA',
  'NHL',
]

// highlight: null | 'blue' | 'red'
function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3))
    : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005

  const bg = highlight === 'red' ? 'bg-red-600' : highlight === 'blue' ? 'bg-blue-600' : 'bg-gray-700'

  return (
    <div className={`flex-1 flex flex-col items-center py-2 rounded-lg ${bg}`}>
      <span className="text-xs text-gray-300">{label}</span>
      <span className={`text-base font-bold leading-tight ${highlight ? 'text-white' : 'text-gray-100'}`}>{value?.toFixed(2) ?? '-'}</span>
      {hasDiff ? (
        <span className={`text-xs font-semibold ${diff > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      ) : <span className="text-xs opacity-0">-</span>}
    </div>
  )
}

function SharpBadge({ alerts, game }) {
  if (!alerts || alerts.length === 0) return null
  const op = game.opening || {}
  const fmtPts = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'

  return (
    <div className="flex gap-1 flex-wrap mb-2">
      {alerts.map(({ type, threshold }) => {
        let label, detail
        switch (type) {
          case 'instant_ml':
            label = '⚡ML'
            detail = threshold ? `${parseFloat(threshold).toFixed(2)}` : ''
            break
          case 'instant_sp':
            label = '⚡핸디'
            detail = threshold ? `${parseFloat(threshold).toFixed(2)}` : ''
            break
          case 'instant_ou':
            label = '⚡O/U'
            detail = threshold ? `${parseFloat(threshold).toFixed(2)}` : ''
            break
          case 'line_sp':
            label = '🔄핸디'
            detail = `${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)}`
            break
          case 'line_ou':
            label = '🔄O/U'
            detail = op.ou_pts != null ? `${op.ou_pts}→${game.ou_pts}` : ''
            break
          default:
            label = type
            detail = threshold || ''
        }
        return (
          <span key={type} className="text-sm px-3 py-1 rounded-lg bg-yellow-500 text-gray-900 font-bold">
            {label}{detail ? ` ${detail}` : ''}
          </span>
        )
      })}
    </div>
  )
}

function GameCard({ game }) {
  const flag     = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op       = game.opening || {}

  function dropHighlight(curA, openA, curB, openB) {
    if (curA == null || openA == null || curB == null || openB == null) return [null, null]
    const dA = curA - openA
    const dB = curB - openB
    if (dA === dB) return [null, null]
    const favA = dA < dB
    const drop = favA ? Math.abs(dA) : Math.abs(dB)
    const color = drop >= 0.10 ? 'red' : 'blue'
    return favA ? [color, null] : [null, color]
  }

  const [mlHomeHL, mlAwayHL] = dropHighlight(game.ml_home, op.ml_home, game.ml_away, op.ml_away)
  const [spHomeHL, spAwayHL] = dropHighlight(game.sp_home, op.sp_home, game.sp_away, op.sp_away)
  const [ouOverHL, ouUnderHL] = dropHighlight(game.ou_over, op.ou_over, game.ou_under, op.ou_under)

  return (
    <div className="bg-gray-800 rounded-xl p-4 mb-3 border border-gray-700">
      {/* 리그 */}
      <div className="mb-1">
        <span className="text-base font-bold text-gray-200">{flag} {game.league}</span>
      </div>

      {/* 팀명 */}
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-white font-bold text-xl">{game.home}</span>
        <span className="text-gray-500 text-lg font-normal">vs</span>
        <span className="text-white font-bold text-xl">{game.away}</span>
      </div>

      {/* 샤프 시그널 */}
      <SharpBadge alerts={game.recentAlerts} game={game} />

      {/* 경기시간 */}
      <div className="mb-3">
        <span className="text-base font-semibold text-gray-300">⏰ {game.starts_at?.replace(' KST','')}</span>
      </div>

      {/* 승패 배당 */}
      <div className="flex gap-1.5 mb-1.5">
        <OddsTag label="홈" value={game.ml_home} openValue={op.ml_home} highlight={mlHomeHL} />
        {isSoccer && game.ml_draw && <OddsTag label="무" value={game.ml_draw} openValue={op.ml_draw} />}
        <OddsTag label="원정" value={game.ml_away} openValue={op.ml_away} highlight={mlAwayHL} />
      </div>

      {/* 핸디캡 */}
      {game.sp_pts != null && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag
            label={`홈 ${game.sp_pts >= 0 ? '+' : ''}${game.sp_pts}`}
            value={game.sp_home}
            openValue={op.sp_home}
            highlight={spHomeHL}
          />
          <OddsTag
            label={`원정 ${(-game.sp_pts) >= 0 ? '+' : ''}${-game.sp_pts}`}
            value={game.sp_away}
            openValue={op.sp_away}
            highlight={spAwayHL}
          />
        </div>
      )}

      {/* 오버언더 */}
      {game.ou_pts != null && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${game.ou_pts}`} value={game.ou_over} openValue={op.ou_over} highlight={ouOverHL} />
          <OddsTag label={`언더 ${game.ou_pts}`} value={game.ou_under} openValue={op.ou_under} highlight={ouUnderHL} />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [games, setGames]           = useState([])
  const [tab, setTab]               = useState('all')
  const [pastLeague, setPastLeague] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)

  useEffect(() => {
    fetchGames()
    const interval = setInterval(fetchGames, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  async function fetchGames() {
    setLoading(true)

    const [linesRes, openingsRes, alertsRes] = await Promise.all([
      supabase.from('latest_lines').select('*').order('starts_at', { ascending: true }),
      supabase.from('opening_lines').select('matchup_id,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under'),
      supabase.from('alerts').select('matchup_id,alert_type,threshold').order('id', { ascending: false }).limit(500),
    ])

    const openingsMap = Object.fromEntries(
      (openingsRes.data || []).map(o => [o.matchup_id, o])
    )

    const currentIds = new Set((linesRes.data || []).map(g => g.matchup_id))

    const alertsMap = {}
    for (const a of (alertsRes.data || [])) {
      if (!currentIds.has(a.matchup_id)) continue
      if (!alertsMap[a.matchup_id]) alertsMap[a.matchup_id] = {}
      const cur = alertsMap[a.matchup_id][a.alert_type]
      if (!cur) {
        alertsMap[a.matchup_id][a.alert_type] = { type: a.alert_type, threshold: a.threshold }
      } else if (a.alert_type.startsWith('instant_')) {
        if (parseFloat(a.threshold) > parseFloat(cur.threshold)) {
          cur.threshold = a.threshold
        }
      }
    }

    const merged = (linesRes.data || []).map(g => ({
      ...g,
      opening:      openingsMap[g.matchup_id] || null,
      recentAlerts: alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
    }))

    setGames(merged)
    setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
    setLoading(false)
  }

  const isPastView = tab === 'past'

  const filtered = games.filter(g => {
    const past = isInPast(g.starts_at)
    if (isPastView) {
      if (!past) return false
      if (pastLeague !== 'all' && g.league !== pastLeague) return false
      return true
    }
    if (past) return false
    if (tab !== 'all' && g.league !== tab) return false
    return true
  })

  const sorted = [...filtered].sort((a, b) =>
    isPastView
      ? (b.starts_at > a.starts_at ? 1 : -1)
      : (a.starts_at > b.starts_at ? 1 : -1)
  )

  // 탭 목록: 전체 + 데이터 있는 리그만 + 지난경기
  const activeLegues = ALL_LEAGUES.filter(l =>
    games.some(g => g.league === l && !isInPast(g.starts_at))
  )

  // 지난경기 안 리그 탭: 지난경기 있는 리그만
  const pastLeagues = ALL_LEAGUES.filter(l =>
    games.some(g => g.league === l && isInPast(g.starts_at))
  )

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* 헤더 */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 px-4 pt-4 pb-3">
        <div className="flex justify-between items-center mb-3">
          <h1 className="text-2xl font-bold">⚡ 샤프시그널</h1>
          <span className="text-sm text-gray-400">{lastUpdate && `갱신 ${lastUpdate}`}</span>
        </div>

        {/* 탭: 전체 + 리그별 + 지난경기 */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button
            onClick={() => setTab('all')}
            className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors
              ${tab === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            전체
          </button>
          {activeLegues.map(l => (
            <button
              key={l}
              onClick={() => setTab(l)}
              className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors
                ${tab === l ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
            >
              {LEAGUE_FLAGS[l]} {l}
            </button>
          ))}
          <button
            onClick={() => { setTab('past'); setPastLeague('all') }}
            className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors
              ${tab === 'past' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
          >
            🕐 지난경기
          </button>
        </div>

        {/* 지난경기 리그 탭 */}
        {isPastView && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button
              onClick={() => setPastLeague('all')}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors
                ${pastLeague === 'all' ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}
            >
              전체
            </button>
            {pastLeagues.map(l => (
              <button
                key={l}
                onClick={() => setPastLeague(l)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors
                  ${pastLeague === l ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}
              >
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 경기 목록 */}
      <div className="px-4 py-4">
        {loading ? (
          <div className="text-center text-gray-500 py-20">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">경기 없음</div>
        ) : (
          sorted.map(g => <GameCard key={g.matchup_id} game={g} />)
        )}
      </div>
    </div>
  )
}
