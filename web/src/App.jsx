import { useState, useEffect } from 'react'
import { supabase } from './supabase'

const SPORTS = [
  { key: 'all',      label: '전체' },
  { key: 'baseball', label: '⚾ 야구' },
  { key: 'soccer',   label: '⚽ 축구' },
]

const LEAGUE_FLAGS = {
  MLB: '🇺🇸', KBO: '🇰🇷', NPB: '🇯🇵',
  EPL: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Bundesliga: '🇩🇪', 'Serie A': '🇮🇹',
  'Ligue 1': '🇫🇷', 'La Liga': '🇪🇸',
  'K리그1': '🇰🇷', MLS: '🇺🇸',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
}

const LEAGUES_BY_SPORT = {
  baseball: ['MLB', 'KBO', 'NPB'],
  soccer: ['EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'MLS', 'UCL', 'Europa', 'Conference'],
}

const ALERT_LABELS = {
  instant_ml: '⚡ML',
  instant_sp: '⚡핸디',
  instant_ou: '⚡O/U',
  line_sp:    '🔄핸디',
  line_ou:    '🔄O/U',
}

function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3))
    : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005

  return (
    <div className={`flex flex-col items-center px-3 py-1.5 rounded-lg ${highlight ? 'bg-blue-600' : 'bg-gray-700'}`}>
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-sm font-bold ${highlight ? 'text-white' : 'text-gray-100'}`}>{value?.toFixed(2) ?? '-'}</span>
      {hasDiff && (
        <span className={`text-xs font-semibold ${diff > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      )}
    </div>
  )
}

function SharpBadge({ alertTypes }) {
  if (!alertTypes || alertTypes.length === 0) return null
  const unique = [...new Set(alertTypes)]
  return (
    <div className="flex gap-1 flex-wrap mb-2">
      {unique.map(t => (
        <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-yellow-500 text-gray-900 font-bold">
          {ALERT_LABELS[t] || t}
        </span>
      ))}
    </div>
  )
}

function GameCard({ game }) {
  const flag    = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op      = game.opening || {}

  return (
    <div className="bg-gray-800 rounded-xl p-4 mb-3 border border-gray-700">
      {/* 헤더 */}
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-gray-400">{flag} {game.league}</span>
        <span className="text-xs text-gray-400">⏰ {game.starts_at?.replace(' KST','')}</span>
      </div>

      {/* 샤프 시그널 */}
      <SharpBadge alertTypes={game.recentAlerts} />

      {/* 팀명 */}
      <div className="mb-3">
        <div className="text-white font-semibold text-base">{game.home}</div>
        <div className="text-gray-400 text-sm">vs {game.away}</div>
      </div>

      {/* 승패 배당 */}
      <div className="flex gap-2 mb-2 flex-wrap">
        <OddsTag label="홈" value={game.ml_home} openValue={op.ml_home} highlight />
        {isSoccer && game.ml_draw && <OddsTag label="무" value={game.ml_draw} openValue={op.ml_draw} />}
        <OddsTag label="원정" value={game.ml_away} openValue={op.ml_away} />
      </div>

      {/* 핸디캡 */}
      {game.sp_pts != null && (
        <div className="flex gap-2 mb-2 flex-wrap">
          <OddsTag
            label={`홈 ${game.sp_pts >= 0 ? '+' : ''}${game.sp_pts}`}
            value={game.sp_home}
            openValue={op.sp_home}
          />
          <OddsTag
            label={`원정 ${(-game.sp_pts) >= 0 ? '+' : ''}${-game.sp_pts}`}
            value={game.sp_away}
            openValue={op.sp_away}
          />
        </div>
      )}

      {/* 오버언더 */}
      {game.ou_pts != null && (
        <div className="flex gap-2 flex-wrap">
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
      supabase.from('alerts').select('matchup_id,alert_type').order('id', { ascending: false }).limit(500),
    ])

    const openingsMap = Object.fromEntries(
      (openingsRes.data || []).map(o => [o.matchup_id, o])
    )

    // 현재 표시 중인 경기 ID 집합 (오래된 알림 제외용)
    const currentIds = new Set((linesRes.data || []).map(g => g.matchup_id))

    const alertsMap = {}
    for (const a of (alertsRes.data || [])) {
      if (!currentIds.has(a.matchup_id)) continue
      if (!alertsMap[a.matchup_id]) alertsMap[a.matchup_id] = new Set()
      alertsMap[a.matchup_id].add(a.alert_type)
    }

    const merged = (linesRes.data || []).map(g => ({
      ...g,
      opening:      openingsMap[g.matchup_id] || null,
      recentAlerts: alertsMap[g.matchup_id] ? [...alertsMap[g.matchup_id]] : [],
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
