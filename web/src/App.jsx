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
  'K리그1': '🇰🇷', 'K리그2': '🇰🇷', MLS: '🇺🇸', 'A리그': '🇦🇺',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
}

const LEAGUES_BY_SPORT = {
  baseball: ['MLB', 'KBO', 'NPB'],
  soccer: ['EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'UCL', 'Europa', 'Conference'],
}

// 변동폭 계산
function diff(cur, open) {
  if (cur == null || open == null) return null
  return cur - open
}

// 변동 표시 컴포넌트
function OddsTag({ label, value, opening, highlight, lineChanged }) {
  const d = diff(value, opening)
  const hasMove = d != null && Math.abs(d) >= 0.01
  const up = d > 0
  const isSteam = hasMove && Math.abs(d) >= 0.10

  return (
    <div className={`flex flex-col items-center px-3 py-1.5 rounded-lg min-w-[60px]
      ${highlight ? 'bg-blue-600' : lineChanged ? 'bg-purple-800' : 'bg-gray-700'}`}>
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-sm font-bold ${highlight ? 'text-white' : 'text-gray-100'}`}>
        {value != null ? value.toFixed(2) : '-'}
      </span>
      {hasMove && (
        <span className={`text-xs font-semibold ${isSteam ? 'text-yellow-300' : up ? 'text-green-400' : 'text-red-400'}`}>
          {up ? '▲' : '▼'}{Math.abs(d).toFixed(2)}
          {isSteam && ' 🔥'}
        </span>
      )}
    </div>
  )
}

// 경기 전체 변동폭 (배지용)
function calcMaxMove(game, opening) {
  if (!opening) return 0
  const fields = ['ml_home', 'ml_away', 'ml_draw', 'sp_home', 'sp_away', 'ou_over', 'ou_under']
  return Math.max(...fields.map(f => Math.abs(diff(game[f], opening[f]) ?? 0)))
}

function GameCard({ game, opening }) {
  const flag = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const maxMove = calcMaxMove(game, opening)
  const hasSteam = maxMove >= 0.10
  const hasMove = maxMove >= 0.01
  const lineChanged = opening && game.sp_pts != null && opening.sp_pts != null && game.sp_pts !== opening.sp_pts
  const ouChanged  = opening && game.ou_pts != null && opening.ou_pts != null && game.ou_pts !== opening.ou_pts

  return (
    <div className={`bg-gray-800 rounded-xl p-4 mb-3 border ${hasSteam ? 'border-yellow-500' : hasMove ? 'border-blue-700' : 'border-gray-700'}`}>
      {/* 헤더 */}
      <div className="flex justify-between items-center mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{flag} {game.league}</span>
          {hasSteam && <span className="text-xs bg-yellow-500 text-black font-bold px-1.5 py-0.5 rounded">🔥 STEAM</span>}
          {!hasSteam && lineChanged && <span className="text-xs bg-purple-600 text-white font-bold px-1.5 py-0.5 rounded">📐 라인변경</span>}
          {!hasSteam && ouChanged && <span className="text-xs bg-purple-600 text-white font-bold px-1.5 py-0.5 rounded">📐 기준선변경</span>}
        </div>
        <span className="text-xs text-gray-400">⏰ {game.starts_at?.replace(' KST','')}</span>
      </div>

      {/* 팀명 */}
      <div className="mb-3">
        <div className="text-white font-semibold text-base">{game.home}</div>
        <div className="text-gray-400 text-sm">vs {game.away}</div>
      </div>

      {/* 승패 배당 */}
      <div className="flex gap-2 mb-2 flex-wrap">
        <OddsTag label="홈" value={game.ml_home} opening={opening?.ml_home} highlight />
        {isSoccer && game.ml_draw != null &&
          <OddsTag label="무" value={game.ml_draw} opening={opening?.ml_draw} />}
        <OddsTag label="원정" value={game.ml_away} opening={opening?.ml_away} />
      </div>

      {/* 핸디캡 */}
      {game.sp_pts != null && (
        <div className="flex gap-2 mb-2 flex-wrap items-center">
          {lineChanged && opening?.sp_pts != null && (
            <span className="text-xs text-purple-300 mr-1">
              기준 {opening.sp_pts >= 0 ? '+' : ''}{opening.sp_pts} → {game.sp_pts >= 0 ? '+' : ''}{game.sp_pts}
            </span>
          )}
          <OddsTag
            label={`홈 ${game.sp_pts >= 0 ? '+' : ''}${game.sp_pts}`}
            value={game.sp_home}
            opening={lineChanged ? null : opening?.sp_home}
            lineChanged={lineChanged}
          />
          <OddsTag
            label={`원정 ${(-game.sp_pts) >= 0 ? '+' : ''}${-game.sp_pts}`}
            value={game.sp_away}
            opening={lineChanged ? null : opening?.sp_away}
            lineChanged={lineChanged}
          />
        </div>
      )}

      {/* 오버언더 */}
      {game.ou_pts != null && (
        <div className="flex gap-2 flex-wrap items-center">
          {ouChanged && opening?.ou_pts != null && (
            <span className="text-xs text-purple-300 mr-1">
              기준 {opening.ou_pts} → {game.ou_pts}
            </span>
          )}
          <OddsTag
            label={`오버 ${game.ou_pts}`}
            value={game.ou_over}
            opening={ouChanged ? null : opening?.ou_over}
            lineChanged={ouChanged}
          />
          <OddsTag
            label={`언더 ${game.ou_pts}`}
            value={game.ou_under}
            opening={ouChanged ? null : opening?.ou_under}
            lineChanged={ouChanged}
          />
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [games, setGames]         = useState([])
  const [openings, setOpenings]   = useState({})
  const [sport, setSport]         = useState('all')
  const [league, setLeague]       = useState('all')
  const [loading, setLoading]     = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)

  useEffect(() => {
    fetchGames()
    const interval = setInterval(fetchGames, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  async function fetchGames() {
    setLoading(true)
    const [{ data: latest }, { data: opens }] = await Promise.all([
      supabase.from('latest_lines').select('*').order('starts_at', { ascending: true }),
      supabase.from('opening_lines').select('*'),
    ])
    setGames(latest || [])
    // matchup_id 기준 맵
    const map = {}
    for (const o of (opens || [])) map[o.matchup_id] = o
    setOpenings(map)
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

  // 변동 큰 경기 상단 정렬
  const sorted = [...filtered].sort((a, b) => {
    const ma = calcMaxMove(a, openings[a.matchup_id])
    const mb = calcMaxMove(b, openings[b.matchup_id])
    if (ma !== mb) return mb - ma
    return (a.starts_at || '').localeCompare(b.starts_at || '')
  })

  const grouped = sorted.reduce((acc, g) => {
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
              {leagueGames.map(g => (
                <GameCard key={g.matchup_id} game={g} opening={openings[g.matchup_id]} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
