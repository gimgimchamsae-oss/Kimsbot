import { useState, useEffect } from 'react'
import { supabase } from './supabase'

const SPORTS = [
  { key: 'all',        label: '전체' },
  { key: 'baseball',   label: '⚾ 야구' },
  { key: 'soccer',     label: '⚽ 축구' },
  { key: 'basketball', label: '🏀 농구' },
  { key: 'hockey',     label: '🏒 하키' },
]

const LEAGUE_FLAGS = {
  MLB: '🇺🇸', KBO: '🇰🇷', NPB: '🇯🇵',
  EPL: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Bundesliga: '🇩🇪', 'Serie A': '🇮🇹',
  'Ligue 1': '🇫🇷', 'La Liga': '🇪🇸',
  'K리그1': '🇰🇷', MLS: '🇺🇸',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸', KBL: '🇰🇷',
  NHL: '🇺🇸',
}

const LEAGUES_BY_SPORT = {
  baseball:   ['MLB', 'KBO', 'NPB'],
  soccer:     ['EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'MLS', 'UCL', 'Europa', 'Conference'],
  basketball: ['NBA', 'KBL'],
  hockey:     ['NHL'],
}

// highlight: null | 'blue' | 'red'
function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3))
    : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005

  const bg = highlight === 'red' ? 'bg-red-600' : highlight === 'blue' ? 'bg-blue-600' : 'bg-gray-700'

  return (
    <div className={`flex-1 flex flex-col items-center py-3 rounded-lg ${bg}`}>
      <span className="text-xs text-gray-300 mb-1">{label}</span>
      <span className={`text-lg font-bold leading-tight ${highlight ? 'text-white' : 'text-gray-100'}`}>{value?.toFixed(2) ?? '-'}</span>
      {hasDiff ? (
        <span className={`text-xs font-semibold mt-1 ${diff > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      ) : <span className="text-xs mt-1 opacity-0">-</span>}
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
          <span key={type} className="text-xs px-2 py-0.5 rounded bg-yellow-500 text-gray-900 font-bold">
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

  // 오프닝 대비 낙폭이 큰 쪽 → 파란(0.10미만) / 빨강(0.10이상)
  function dropHighlight(curA, openA, curB, openB) {
    if (curA == null || openA == null || curB == null || openB == null) return [null, null]
    const dA = curA - openA  // 음수 = 하락
    const dB = curB - openB
    if (dA === dB) return [null, null]
    const favA = dA < dB  // A가 더 많이 떨어짐
    const drop = favA ? Math.abs(dA) : Math.abs(dB)
    const color = drop >= 0.10 ? 'red' : 'blue'
    return favA ? [color, null] : [null, color]
  }

  const [mlHomeHL, mlAwayHL] = dropHighlight(game.ml_home, op.ml_home, game.ml_away, op.ml_away)
  const [spHomeHL, spAwayHL] = dropHighlight(game.sp_home, op.sp_home, game.sp_away, op.sp_away)

  return (
    <div className="bg-gray-800 rounded-xl p-4 mb-3 border border-gray-700">
      {/* 헤더 */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-gray-400">{flag} {game.league}</span>
        <span className="text-xs text-gray-400">⏰ {game.starts_at?.replace(' KST','')}</span>
      </div>

      {/* 샤프 시그널 */}
      <SharpBadge alerts={game.recentAlerts} game={game} />

      {/* 팀명 — 한 줄 */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-white font-bold text-base">{game.home}</span>
        <span className="text-gray-500 text-sm font-normal">vs</span>
        <span className="text-white font-bold text-base">{game.away}</span>
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
          <OddsTag label={`오버 ${game.ou_pts}`} value={game.ou_over} openValue={op.ou_over} />
          <OddsTag label={`언더 ${game.ou_pts}`} value={game.ou_under} openValue={op.ou_under} />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [games, setGames]           = useState([])
  const [sport, setSport]           = useState('all')
  const [league, setLeague]         = useState('all')
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

    // 현재 표시 중인 경기 ID 집합 (오래된 알림 제외용)
    const currentIds = new Set((linesRes.data || []).map(g => g.matchup_id))

    // 게임당 alert_type별로 최신 1개씩 (instant는 최대 threshold 유지)
    const alertsMap = {}
    for (const a of (alertsRes.data || [])) {
      if (!currentIds.has(a.matchup_id)) continue
      if (!alertsMap[a.matchup_id]) alertsMap[a.matchup_id] = {}
      const cur = alertsMap[a.matchup_id][a.alert_type]
      if (!cur) {
        alertsMap[a.matchup_id][a.alert_type] = { type: a.alert_type, threshold: a.threshold }
      } else if (a.alert_type.startsWith('instant_')) {
        // 스팀무브는 최대 변동폭으로 업데이트
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

  const leagues = sport === 'all'
    ? Object.values(LEAGUES_BY_SPORT).flat()
    : (LEAGUES_BY_SPORT[sport] || [])

  const filtered = games.filter(g => {
    if (sport !== 'all' && g.sport !== sport) return false
    if (league !== 'all' && g.league !== league) return false
    return true
  })

  const grouped = filtered.reduce((acc, g) => {
    if (!acc[g.league]) acc[g.league] = []
    acc[g.league].push(g)
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* 헤더 */}
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 px-4 pt-4 pb-2">
        <div className="flex justify-between items-center mb-3">
          <h1 className="text-lg font-bold">📊 Pinnacle RLM</h1>
          <span className="text-xs text-gray-500">{lastUpdate && `갱신 ${lastUpdate}`}</span>
        </div>

        {/* 스포츠 탭 */}
        <div className="flex gap-2 mb-2">
          {SPORTS.map(s => (
            <button
              key={s.key}
              onClick={() => { setSport(s.key); setLeague('all') }}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                ${sport === s.key ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 리그 필터 */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button
            onClick={() => setLeague('all')}
            className={`px-3 py-1 rounded-full text-xs whitespace-nowrap
              ${league === 'all' ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            전체
          </button>
          {leagues.map(l => (
            <button
              key={l}
              onClick={() => setLeague(l)}
              className={`px-3 py-1 rounded-full text-xs whitespace-nowrap
                ${league === l ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-400'}`}
            >
              {LEAGUE_FLAGS[l]} {l}
            </button>
          ))}
        </div>
      </div>

      {/* 경기 목록 */}
      <div className="px-4 py-4">
        {loading ? (
          <div className="text-center text-gray-500 py-20">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">경기 없음</div>
        ) : (
          Object.entries(grouped).map(([leagueName, leagueGames]) => (
            <div key={leagueName} className="mb-6">
              <div className="text-sm font-semibold text-gray-400 mb-2 px-1">
                {LEAGUE_FLAGS[leagueName]} {leagueName} ({leagueGames.length})
              </div>
              {leagueGames.map(g => <GameCard key={g.matchup_id} game={g} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
