import { useState, useEffect } from 'react'
import { supabase } from './supabase'

// 팀 풀네임 → 약자 매핑 (MLB + NBA + NHL)
const TEAM_ABBREV = {
  // MLB
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
  // NBA
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
  // NHL
  'Anaheim Ducks':'ANA','Arizona Coyotes':'ARI','Boston Bruins':'BOS',
  'Buffalo Sabres':'BUF','Calgary Flames':'CGY','Carolina Hurricanes':'CAR',
  'Chicago Blackhawks':'CHI','Colorado Avalanche':'COL','Columbus Blue Jackets':'CBJ',
  'Dallas Stars':'DAL','Detroit Red Wings':'DET','Edmonton Oilers':'EDM',
  'Florida Panthers':'FLA','Los Angeles Kings':'LAK','Minnesota Wild':'MIN',
  'Montreal Canadiens':'MTL','Nashville Predators':'NSH','New Jersey Devils':'NJD',
  'New York Islanders':'NYI','New York Rangers':'NYR','Ottawa Senators':'OTT',
  'Philadelphia Flyers':'PHI','Pittsburgh Penguins':'PIT','San Jose Sharks':'SJS',
  'Seattle Kraken':'SEA','St. Louis Blues':'STL','Tampa Bay Lightning':'TBL',
  'Toronto Maple Leafs':'TOR','Utah Hockey Club':'UTA','Vancouver Canucks':'VAN',
  'Vegas Golden Knights':'VGK','Washington Capitals':'WSH','Winnipeg Jets':'WPG',
}

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
  'K리그1': '🇰🇷', 'K리그2': '🇰🇷', MLS: '🇺🇸', 'A리그': '🇦🇺', 'J리그': '🇯🇵',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸', NHL: '🇺🇸',
}

const ALL_LEAGUES = [
  'MLB', 'KBO', 'NPB',
  'EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'UCL', 'Europa', 'Conference',
  'NBA', 'NHL',
]

const SPORT_GROUPS = [
  { key: 'baseball',   label: '⚾ 야구', leagues: ['MLB', 'KBO', 'NPB'] },
  { key: 'soccer',     label: '⚽ 축구', leagues: ['EPL', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'UCL', 'Europa', 'Conference'] },
  { key: 'basketball', label: '🏀 농구', leagues: ['NBA'] },
  { key: 'hockey',     label: '🏒 하키', leagues: ['NHL'] },
]

function minsAgo(ts) {
  if (!ts) return null
  try {
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
    if (diff < 1) return '방금'
    return `${diff}분 전`
  } catch { return null }
}

function hoursUntil(startsAt) {
  if (!startsAt) return null
  try {
    const m = startsAt.match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
    if (!m) return null
    const year = new Date().getFullYear()
    const utcMs = Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[3]) - 9, parseInt(m[4]))
    return (utcMs - Date.now()) / 3600000
  } catch { return null }
}

function fmtTime(ts) {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${min}`
  } catch { return '' }
}

// 샤프 시그널: 실제 alert 기록이 있는 마켓만 표시 (드리프트 노이즈 제거)
function sharpSignals(game) {
  const op = game.opening || {}
  const alerts = game.recentAlerts || []
  const hasSteamMl = alerts.some(a => a.type === 'instant_ml')
  const hasSteamSp = alerts.some(a => a.type === 'instant_sp')
  const hasSteamOu = alerts.some(a => a.type === 'instant_ou')
  const hasLineSp  = alerts.some(a => a.type === 'line_sp')
  const hasLineOu  = alerts.some(a => a.type === 'line_ou')

  // ② 시간 가중: 경기 4h 이내이면 +1
  const hours = hoursUntil(game.starts_at)
  const timeBoost = (hours !== null && hours >= 0 && hours <= 4) ? 1 : 0

  const signals = []

  // ── ML: 스팀무브 alert 있을 때만 ──────────────────────────
  if (hasSteamMl) {
    const dropHome = (op.ml_home && game.ml_home) ? op.ml_home - game.ml_home : 0
    const dropAway = (op.ml_away && game.ml_away) ? op.ml_away - game.ml_away : 0
    const [label, drop] = dropHome >= dropAway ? ['홈 ML', dropHome] : ['원정 ML', dropAway]
    const steamVal = parseFloat(alerts.find(a => a.type === 'instant_ml')?.threshold || 0)
    const base = steamVal >= 0.20 ? 3 : 2
    signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
  }

  // ── 핸디: 스팀 or 라인변경 alert 있을 때만 ────────────────
  if (hasSteamSp || hasLineSp) {
    if (hasLineSp && op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts) {
      const delta = game.sp_pts - op.sp_pts
      const label = delta < 0 ? '홈 핸디' : '원정 핸디'
      const base = hasSteamSp ? 3 : 2
      signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
    } else if (hasSteamSp) {
      const dropHome = (op.sp_home && game.sp_home) ? op.sp_home - game.sp_home : 0
      const dropAway = (op.sp_away && game.sp_away) ? op.sp_away - game.sp_away : 0
      const [label, drop] = dropHome >= dropAway ? ['홈 핸디', dropHome] : ['원정 핸디', dropAway]
      const steamVal = parseFloat(alerts.find(a => a.type === 'instant_sp')?.threshold || 0)
      const base = steamVal >= 0.20 ? 3 : 2
      signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
    }
  }

  // ── O/U: 스팀 or 라인변경 alert 있을 때만 ──────────────────
  if (hasSteamOu || hasLineOu) {
    if (hasLineOu && op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts) {
      const delta = game.ou_pts - op.ou_pts
      const label = delta < 0 ? '언더' : '오버'
      const base = hasSteamOu ? 3 : 2
      signals.push({ label, drop: Math.abs(delta), score: Math.min(3, base + timeBoost) })
    } else if (hasSteamOu) {
      const dropOver  = (op.ou_over  && game.ou_over)  ? op.ou_over  - game.ou_over  : 0
      const dropUnder = (op.ou_under && game.ou_under) ? op.ou_under - game.ou_under : 0
      const [label, drop] = dropOver >= dropUnder ? ['오버', dropOver] : ['언더', dropUnder]
      const steamVal = parseFloat(alerts.find(a => a.type === 'instant_ou')?.threshold || 0)
      const base = steamVal >= 0.20 ? 3 : 2
      signals.push({ label, drop, score: Math.min(3, base + timeBoost) })
    }
  }

  // ④ 연속 하락 통합
  const streakMap = {
    streak_ml_home: '홈 ML', streak_ml_away: '원정 ML',
    streak_sp_home: '홈 핸디', streak_sp_away: '원정 핸디',
    streak_ou_over: '오버', streak_ou_under: '언더',
  }
  for (const a of alerts) {
    const lbl = streakMap[a.type]
    if (!lbl) continue
    const count = parseInt(a.threshold) || 0
    let sig = signals.find(s => s.label === lbl)
    if (!sig) {
      sig = { label: lbl, drop: 0, score: 1 }
      signals.push(sig)
    }
    sig.score = Math.min(3, sig.score + 1)
    sig.streak = count
  }

  // ① 멀티마켓 확인: ML + 핸디 같은 방향이면 각각 +1
  const mlSig = signals.find(s => s.label.endsWith('ML'))
  const spSig = signals.find(s => s.label.endsWith('핸디'))
  if (mlSig && spSig) {
    const mlHome = mlSig.label.startsWith('홈')
    const spHome = spSig.label.startsWith('홈')
    if (mlHome === spHome) {
      mlSig.score = Math.min(3, mlSig.score + 1)
      spSig.score = Math.min(3, spSig.score + 1)
      mlSig.multi = true
      spSig.multi = true
    }
  }

  return signals.filter(s => s.score > 0)
}

function SharpSignals({ signals }) {
  if (!signals || signals.length === 0) return null
  return (
    <div className="flex gap-2 flex-wrap">
      {signals.map(s => {
        const color = s.score === 3 ? 'text-red-400' : s.score === 2 ? 'text-yellow-400' : 'text-blue-400'
        return (
          <div key={s.label} className="flex items-center gap-0.5 bg-gray-700 rounded-lg px-2 py-1">
            <span className="text-sm font-semibold text-gray-200">{s.label}</span>
            <span className={`text-sm font-bold ${color}`}> {'★'.repeat(s.score)}{'☆'.repeat(3 - s.score)}</span>
            {s.streak ? <span className="text-xs text-orange-400 ml-1">{s.streak}연속</span> : null}
            {s.multi ? <span className="text-xs text-purple-400 ml-1">멀티</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// highlight: null | 'blue' | 'red'
function OddsTag({ label, value, openValue, highlight }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3)) : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005
  const bg = highlight === 'red' ? 'bg-red-600' : highlight === 'blue' ? 'bg-blue-600' : 'bg-gray-700'
  return (
    <div className={`flex-1 flex flex-col items-center py-2 rounded-lg ${bg}`}>
      <span className="text-xs text-gray-300">{label}</span>
      <span className={`text-base font-bold leading-tight ${highlight ? 'text-white' : 'text-gray-100'}`}>
        {value?.toFixed(2) ?? '-'}
      </span>
      {/* 오프닝 대비 등락 */}
      {hasDiff ? (
        <div className="flex flex-col items-center leading-tight">
          <span className="text-xs text-gray-400">오픈 {openValue.toFixed(2)}</span>
          <span className={`text-sm font-bold ${diff > 0 ? 'text-green-400' : 'text-red-300'}`}>
            {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
          </span>
        </div>
      ) : <span className="text-sm opacity-0">-</span>}
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
          case 'instant_ml': label = '⚡ML'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'instant_sp': label = '⚡핸디'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'instant_ou': label = '⚡O/U'; detail = threshold ? parseFloat(threshold).toFixed(2) : ''; break
          case 'line_sp':
            if (op.sp_pts == null || game.sp_pts == null || op.sp_pts === game.sp_pts) return null
            label = '🔄핸디'; detail = `${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)}`; break
          case 'line_ou':
            if (op.ou_pts == null || game.ou_pts == null || op.ou_pts === game.ou_pts) return null
            label = '🔄O/U'; detail = `${op.ou_pts}→${game.ou_pts}`; break
          case 'streak_ml_home':  label = '📉홈 ML';    detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ml_away':  label = '📉원정 ML';  detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_sp_home':  label = '📉홈 핸디';  detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_sp_away':  label = '📉원정 핸디'; detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ou_over':  label = '📉오버';     detail = threshold ? `${threshold}연속` : ''; break
          case 'streak_ou_under': label = '📉언더';     detail = threshold ? `${threshold}연속` : ''; break
          default: label = type; detail = threshold || ''
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

// ③ SVG 차트
function OddsChart({ snapshots, mktTab, isSoccer }) {
  const data = [...snapshots].reverse() // 시간순
  if (data.length < 2) return null

  const W = 300, H = 80, PX = 8, PY = 8

  const series = mktTab === 'ml'
    ? [
        { values: data.map(s => s.ml_home),  color: '#60a5fa', label: '홈' },
        { values: data.map(s => s.ml_away),  color: '#f87171', label: '원정' },
        ...(isSoccer ? [{ values: data.map(s => s.ml_draw), color: '#9ca3af', label: '무' }] : []),
      ]
    : mktTab === 'sp'
    ? [
        { values: data.map(s => s.sp_home), color: '#60a5fa', label: '홈' },
        { values: data.map(s => s.sp_away), color: '#f87171', label: '원정' },
      ]
    : [
        { values: data.map(s => s.ou_over),  color: '#34d399', label: '오버' },
        { values: data.map(s => s.ou_under), color: '#fbbf24', label: '언더' },
      ]

  const allVals = series.flatMap(s => s.values).filter(v => v != null)
  if (allVals.length < 2) return null
  const lo = Math.min(...allVals), hi = Math.max(...allVals)
  const range = hi - lo || 0.1

  function path(values) {
    const pts = values.map((v, i) => {
      if (v == null) return null
      const x = PX + (i / (values.length - 1)) * (W - PX * 2)
      const y = PY + (1 - (v - lo) / range) * (H - PY * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).filter(Boolean)
    return pts.length < 2 ? null : `M ${pts.join(' L ')}`
  }

  // Y축 레이블 (최소/최대)
  const yMin = lo.toFixed(2), yMax = hi.toFixed(2)

  return (
    <div className="mb-3 bg-gray-800 rounded-lg p-2">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
          {/* 그리드 */}
          {[0.25, 0.5, 0.75].map(t => (
            <line key={t} x1={PX} x2={W - PX}
              y1={PY + t * (H - PY * 2)} y2={PY + t * (H - PY * 2)}
              stroke="#374151" strokeWidth="1" />
          ))}
          {/* 라인 */}
          {series.map((s, i) => {
            const d = path(s.values)
            return d ? <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null
          })}
        </svg>
        {/* Y축 레이블 */}
        <div className="absolute top-1 right-1 text-xs text-gray-500">{yMax}</div>
        <div className="absolute bottom-1 right-1 text-xs text-gray-500">{yMin}</div>
      </div>
      {/* 범례 */}
      <div className="flex gap-3 justify-center mt-1">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="w-4 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-gray-400">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// 배당 흐름 모달
function HistoryModal({ game, onClose }) {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading]     = useState(true)
  const [mktTab, setMktTab]       = useState('ml')
  const isSoccer = game.sport === 'soccer'

  useEffect(() => {
    async function load() {
      const res = await supabase
        .from('snapshots')
        .select('ts,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under')
        .eq('matchup_id', game.matchup_id)
        .order('id', { ascending: false })
        .limit(300)
      const rows = (res.data || []).filter(r => r.ml_home != null || r.sp_home != null || r.ou_over != null).reverse()
      const changed = rows.filter((r, i) => {
        if (i === 0) return true
        const p = rows[i - 1]
        return ['ml_home','ml_away','ml_draw','sp_pts','sp_home','sp_away','ou_pts','ou_over','ou_under']
          .some(k => r[k] !== p[k])
      })
      setSnapshots(changed.reverse())
      setLoading(false)
    }
    load()
  }, [game.matchup_id])

  const flag = LEAGUE_FLAGS[game.league] || '🏟'

  function diffCell(cur, prev) {
    if (cur == null) return <span className="text-gray-500">-</span>
    const d = prev != null ? parseFloat((cur - prev).toFixed(3)) : null
    const show = d !== null && Math.abs(d) >= 0.005
    return (
      <span className={show ? (d > 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold') : 'text-gray-100'}>
        {cur.toFixed(2)}{show ? (d > 0 ? ' ▲' : ' ▼') : ''}
      </span>
    )
  }

  const mktTabs = [
    { key: 'ml', label: '승패' },
    ...(snapshots.some(s => s.sp_pts != null) ? [{ key: 'sp', label: '핸디' }] : []),
    ...(snapshots.some(s => s.ou_pts != null) ? [{ key: 'ou', label: 'O/U' }] : []),
  ]

  return (
    <div className="fixed inset-0 z-50 flex flex-col" onClick={onClose}>
      <div className="flex-1 bg-black/60" />
      <div
        className="bg-gray-900 rounded-t-2xl px-4 pt-4 pb-8 max-h-[82vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4" />

        <div className="mb-3">
          <div className="text-sm text-gray-400 mb-1">{flag} {game.league} · {game.starts_at?.replace(' KST','')}</div>
          <div className="text-white font-bold text-lg mb-1">{game.home} <span className="text-gray-500 font-normal text-base">vs</span> {game.away}</div>
          <SharpSignals signals={sharpSignals(game)} />
        </div>

        <div className="flex gap-2 mb-3">
          {mktTabs.map(t => (
            <button key={t.key} onClick={() => setMktTab(t.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors
                ${mktTab === t.key ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center text-gray-500 py-10">불러오는 중...</div>
        ) : snapshots.length === 0 ? (
          <div className="text-center text-gray-500 py-10">데이터 없음</div>
        ) : (
          <div className="overflow-y-auto flex-1">
            {/* ③ 차트 */}
            <OddsChart snapshots={snapshots} mktTab={mktTab} isSoccer={isSoccer} />

            {/* 테이블 */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-2 pr-2">시간</th>
                  {mktTab === 'ml' && <>
                    <th className="text-right py-2 px-2">홈</th>
                    {isSoccer && <th className="text-right py-2 px-2">무</th>}
                    <th className="text-right py-2 px-2">원정</th>
                  </>}
                  {mktTab === 'sp' && <>
                    <th className="text-right py-2 px-2">기준선</th>
                    <th className="text-right py-2 px-2">홈</th>
                    <th className="text-right py-2 px-2">원정</th>
                  </>}
                  {mktTab === 'ou' && <>
                    <th className="text-right py-2 px-2">기준선</th>
                    <th className="text-right py-2 px-2">오버</th>
                    <th className="text-right py-2 px-2">언더</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => {
                  const prev = snapshots[i + 1]
                  return (
                    <tr key={i} className="border-b border-gray-800">
                      <td className="py-2 pr-2 text-gray-400 whitespace-nowrap">{fmtTime(s.ts)}</td>
                      {mktTab === 'ml' && <>
                        <td className="text-right py-2 px-2">{diffCell(s.ml_home, prev?.ml_home)}</td>
                        {isSoccer && <td className="text-right py-2 px-2">{diffCell(s.ml_draw, prev?.ml_draw)}</td>}
                        <td className="text-right py-2 px-2">{diffCell(s.ml_away, prev?.ml_away)}</td>
                      </>}
                      {mktTab === 'sp' && <>
                        <td className="text-right py-2 px-2 text-gray-300">{s.sp_pts != null ? (s.sp_pts >= 0 ? '+' : '') + s.sp_pts : '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_home, prev?.sp_home)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_away, prev?.sp_away)}</td>
                      </>}
                      {mktTab === 'ou' && <>
                        <td className="text-right py-2 px-2 text-gray-300">{s.ou_pts ?? '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.ou_over, prev?.ou_over)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.ou_under, prev?.ou_under)}</td>
                      </>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function PctBar({ label, pct, handle }) {
  if (pct == null) return null
  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs mb-0.5">
        <span className="text-gray-400">{label}</span>
        <span className="text-white font-medium">
          {pct}% <span className="text-gray-400 font-normal">베팅</span>
          {handle != null && <span className="text-gray-400 ml-2">{handle}% 금액</span>}
        </span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-1.5">
        <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function PublicBetting({ pb, isSoccer }) {
  if (!pb) return null
  return (
    <div className="mt-2 pt-2 border-t border-gray-700">
      <div className="text-xs text-gray-500 mb-1.5">👥 해외 구매율</div>
      <div className="space-y-1">
        <PctBar label="홈 ML"  pct={pb.ml_bets_home}  handle={pb.ml_handle_home} />
        <PctBar label="원정 ML" pct={pb.ml_bets_away}  handle={pb.ml_handle_away} />
        {pb.sp_bets_home != null && <PctBar label="홈 핸디" pct={pb.sp_bets_home} handle={pb.sp_handle_home} />}
        {pb.sp_bets_away != null && <PctBar label="원정 핸디" pct={pb.sp_bets_away} handle={pb.sp_handle_away} />}
        {pb.ou_bets_over != null && <PctBar label="오버" pct={pb.ou_bets_over} handle={pb.ou_handle_over} />}
        {pb.ou_bets_under != null && <PctBar label="언더" pct={pb.ou_bets_under} handle={pb.ou_handle_under} />}
      </div>
    </div>
  )
}

function ProtoBetting({ proto }) {
  if (!proto) return null
  const hasSp = proto.sp_bets_home != null || proto.sp_bets_away != null
  const hasOu = proto.ou_bets_over != null || proto.ou_bets_under != null
  const hasMl = proto.ml_bets_home != null || proto.ml_bets_away != null
  if (!hasMl && !hasOu && !hasSp) return null
  return (
    <div className="mt-2 pt-2 border-t border-gray-700">
      <div className="text-xs text-gray-500 mb-1.5">🇰🇷 국내 구매율</div>
      <div className="space-y-1">
        {proto.ml_bets_home != null && <PctBar label="홈 승" pct={proto.ml_bets_home} />}
        {proto.ml_bets_draw != null && <PctBar label="무" pct={proto.ml_bets_draw} />}
        {proto.ml_bets_away != null && <PctBar label="원정 승" pct={proto.ml_bets_away} />}
        {hasSp && proto.sp_bets_home != null && <PctBar label="홈 핸디" pct={proto.sp_bets_home} />}
        {hasSp && proto.sp_bets_away != null && <PctBar label="원정 핸디" pct={proto.sp_bets_away} />}
        {hasOu && proto.ou_bets_over != null && <PctBar label="오버" pct={proto.ou_bets_over} />}
        {hasOu && proto.ou_bets_under != null && <PctBar label="언더" pct={proto.ou_bets_under} />}
      </div>
    </div>
  )
}

const REVERSE_THRESHOLD = 70  // 공중 70% 이상 쏠려야 신호

function reverseSignals(game) {
  const proto = game.protoBetting
  const pb    = game.publicBetting
  const op    = game.opening || {}
  const signals = []

  // 데이터 소스: proto 우선, 없으면 pb
  const mlHome  = proto?.ml_bets_home  ?? pb?.ml_bets_home
  const mlAway  = proto?.ml_bets_away  ?? pb?.ml_bets_away
  const spHome  = proto?.sp_bets_home  ?? pb?.sp_bets_home
  const spAway  = proto?.sp_bets_away  ?? pb?.sp_bets_away
  const ouOver  = proto?.ou_bets_over  ?? pb?.ou_bets_over
  const ouUnder = proto?.ou_bets_under ?? pb?.ou_bets_under

  const fmtPts = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'

  // ── ML 역추세 ──────────────────────────────────────────────
  // ML은 기준선이 없으므로 배당 등락만 체크
  if (mlHome != null && mlAway != null) {
    if (mlHome >= REVERSE_THRESHOLD) {
      const diff = (op.ml_home && game.ml_home) ? game.ml_home - op.ml_home : null
      if (diff != null && diff >= 0.05) {
        signals.push({ market: 'ML', pick: '원정 승', publicSide: `홈 ${mlHome}%`, reason: `홈배당↑ +${diff.toFixed(2)}` })
      }
    }
    if (mlAway >= REVERSE_THRESHOLD) {
      const diff = (op.ml_away && game.ml_away) ? game.ml_away - op.ml_away : null
      if (diff != null && diff >= 0.05) {
        signals.push({ market: 'ML', pick: '홈 승', publicSide: `원정 ${mlAway}%`, reason: `원정배당↑ +${diff.toFixed(2)}` })
      }
    }
  }

  // ── 핸디 역추세 ────────────────────────────────────────────
  // sp_pts = 홈팀 기준점. 하락 = 홈에 불리, 상승 = 원정에 불리
  if (spHome != null && spAway != null) {
    const lineChanged = op.sp_pts != null && game.sp_pts != null && game.sp_pts !== op.sp_pts
    if (spHome >= REVERSE_THRESHOLD) {
      if (lineChanged) {
        // 기준점 하락 = 홈핸디에 불리하게 이동 = 샤프 원정핸디
        if (game.sp_pts < op.sp_pts) {
          signals.push({ market: '핸디', pick: '원정 핸디', publicSide: `홈핸디 ${spHome}%`, reason: `기준점↓ (${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)})` })
        }
      } else {
        const diff = (op.sp_home && game.sp_home) ? game.sp_home - op.sp_home : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: '핸디', pick: '원정 핸디', publicSide: `홈핸디 ${spHome}%`, reason: `홈핸디배당↑ +${diff.toFixed(2)}` })
        }
      }
    }
    if (spAway >= REVERSE_THRESHOLD) {
      if (lineChanged) {
        // 기준점 상승 = 원정핸디에 불리하게 이동 = 샤프 홈핸디
        if (game.sp_pts > op.sp_pts) {
          signals.push({ market: '핸디', pick: '홈 핸디', publicSide: `원정핸디 ${spAway}%`, reason: `기준점↑ (${fmtPts(op.sp_pts)}→${fmtPts(game.sp_pts)})` })
        }
      } else {
        const diff = (op.sp_away && game.sp_away) ? game.sp_away - op.sp_away : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: '핸디', pick: '홈 핸디', publicSide: `원정핸디 ${spAway}%`, reason: `원정핸디배당↑ +${diff.toFixed(2)}` })
        }
      }
    }
  }

  // ── O/U 역추세 ─────────────────────────────────────────────
  // 기준점 변화 있으면 방향만, 없으면 배당 등락
  if (ouOver != null && ouUnder != null) {
    const lineChanged = op.ou_pts != null && game.ou_pts != null && game.ou_pts !== op.ou_pts
    if (ouOver >= REVERSE_THRESHOLD) {
      if (lineChanged) {
        if (game.ou_pts < op.ou_pts) {
          signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `기준점↓ (${op.ou_pts}→${game.ou_pts})` })
        }
      } else {
        const diff = (op.ou_over && game.ou_over) ? game.ou_over - op.ou_over : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: 'O/U', pick: '언더', publicSide: `오버 ${ouOver}%`, reason: `오버배당↑ +${diff.toFixed(2)}` })
        }
      }
    }
    if (ouUnder >= REVERSE_THRESHOLD) {
      if (lineChanged) {
        if (game.ou_pts > op.ou_pts) {
          signals.push({ market: 'O/U', pick: '오버', publicSide: `언더 ${ouUnder}%`, reason: `기준점↑ (${op.ou_pts}→${game.ou_pts})` })
        }
      } else {
        const diff = (op.ou_under && game.ou_under) ? game.ou_under - op.ou_under : null
        if (diff != null && diff >= 0.05) {
          signals.push({ market: 'O/U', pick: '오버', publicSide: `언더 ${ouUnder}%`, reason: `언더배당↑ +${diff.toFixed(2)}` })
        }
      }
    }
  }

  return signals
}

function ReverseSignals({ signals }) {
  if (!signals || signals.length === 0) return null
  return (
    <div className="mt-2 pt-2 border-t border-gray-700">
      <div className="text-xs text-gray-500 mb-1.5">🔄 역추세 시그널</div>
      <div className="flex gap-2 flex-wrap">
        {signals.map((s, i) => (
          <div key={i} className="bg-purple-950/70 border border-purple-600 rounded-lg px-2.5 py-1.5">
            <div className="text-xs text-purple-400">{s.market} · 공중 {s.publicSide}</div>
            <div className="text-sm font-bold text-purple-100">→ {s.pick}</div>
            <div className="text-xs text-purple-400">{s.reason}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function GameCard({ game, onClick }) {
  const flag     = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op       = game.opening || {}
  const signals  = sharpSignals(game)

  function dropHighlight(curA, openA, curB, openB) {
    if (curA == null || openA == null || curB == null || openB == null) return [null, null]
    const dA = curA - openA, dB = curB - openB
    if (dA === dB) return [null, null]
    const favA = dA < dB
    const drop = favA ? Math.abs(dA) : Math.abs(dB)
    const color = drop >= 0.10 ? 'red' : 'blue'
    return favA ? [color, null] : [null, color]
  }

  const [mlHomeHL, mlAwayHL]  = dropHighlight(game.ml_home, op.ml_home, game.ml_away, op.ml_away)
  const [spHomeHL, spAwayHL]  = dropHighlight(game.sp_home, op.sp_home, game.sp_away, op.sp_away)
  const [ouOverHL, ouUnderHL] = dropHighlight(game.ou_over, op.ou_over, game.ou_under, op.ou_under)

  // 지난경기: 현재 배당 없으면 오프닝으로 폴백 (openValue는 숨김)
  const mlHome  = game.ml_home  ?? op.ml_home
  const mlAway  = game.ml_away  ?? op.ml_away
  const mlDraw  = game.ml_draw  ?? op.ml_draw
  const spHome  = game.sp_home  ?? op.sp_home
  const spAway  = game.sp_away  ?? op.sp_away
  const ouOver  = game.ou_over  ?? op.ou_over
  const ouUnder = game.ou_under ?? op.ou_under
  const spPts   = game.sp_pts   ?? op.sp_pts
  const ouPts   = game.ou_pts   ?? op.ou_pts

  return (
    <div className="bg-gray-800 rounded-xl p-4 mb-3 border border-gray-700 cursor-pointer active:opacity-80" onClick={onClick}>
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

      {/* 마켓별 샤프 점수 */}
      {signals.length > 0 && <div className="mb-2"><SharpSignals signals={signals} /></div>}

      {/* 경기시간 + 기준 */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-base font-semibold text-gray-300">⏰ {game.starts_at?.replace(' KST','')}</span>
        {minsAgo(game.ts) && <span className="text-xs text-gray-500">{minsAgo(game.ts)} 기준</span>}
      </div>

      {/* 승패 */}
      <div className="flex gap-1.5 mb-1.5">
        <OddsTag label="홈" value={mlHome} openValue={game.ml_home != null ? op.ml_home : null} highlight={mlHomeHL} />
        {isSoccer && mlDraw && <OddsTag label="무" value={mlDraw} openValue={game.ml_draw != null ? op.ml_draw : null} />}
        <OddsTag label="원정" value={mlAway} openValue={game.ml_away != null ? op.ml_away : null} highlight={mlAwayHL} />
      </div>

      {/* 핸디 */}
      {spPts != null && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label={`홈 ${spPts >= 0 ? '+' : ''}${spPts}`} value={spHome} openValue={game.sp_home != null ? op.sp_home : null} highlight={spHomeHL} />
          <OddsTag label={`원정 ${(-spPts) >= 0 ? '+' : ''}${-spPts}`} value={spAway} openValue={game.sp_away != null ? op.sp_away : null} highlight={spAwayHL} />
        </div>
      )}

      {/* O/U */}
      {ouPts != null && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${ouPts}`} value={ouOver} openValue={game.ou_over != null ? op.ou_over : null} highlight={ouOverHL} />
          <OddsTag label={`언더 ${ouPts}`} value={ouUnder} openValue={game.ou_under != null ? op.ou_under : null} highlight={ouUnderHL} />
        </div>
      )}

      {/* 공개 구매율 */}
      <PublicBetting pb={game.publicBetting} isSoccer={isSoccer} />
      {/* 국내 구매율 */}
      <ProtoBetting proto={game.protoBetting} />
      {/* 역추세 시그널 */}
      <ReverseSignals signals={reverseSignals(game)} />
    </div>
  )
}

export default function App() {
  const [games, setGames]           = useState([])
  const [tab, setTab]               = useState('all')
  const [subLeague, setSubLeague]   = useState('all')
  const [pastLeague, setPastLeague] = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [selected, setSelected]     = useState(null)

  useEffect(() => { fetchGames() }, [])

  async function fetchGames() {
    setLoading(true)
    const [linesRes, openingsRes, alertsRes, pbRes, protoRes] = await Promise.all([
      supabase.from('latest_lines').select('*').order('starts_at', { ascending: true }),
      supabase.from('opening_lines')
        .select('matchup_id,ml_home,ml_away,ml_draw,sp_pts,sp_home,sp_away,ou_pts,ou_over,ou_under')
        .limit(3000),
      supabase.from('alerts').select('matchup_id,alert_type,threshold').order('id', { ascending: false }).limit(500),
      supabase.from('public_betting').select('*'),
      supabase.from('proto_betting').select('*'),
    ])
    const openingsMap = Object.fromEntries((openingsRes.data || []).map(o => [o.matchup_id, o]))
    const currentIds  = new Set((linesRes.data || []).map(g => g.matchup_id))
    const alertsMap   = {}
    for (const a of (alertsRes.data || [])) {
      if (!currentIds.has(a.matchup_id)) continue
      if (!alertsMap[a.matchup_id]) alertsMap[a.matchup_id] = {}
      const cur = alertsMap[a.matchup_id][a.alert_type]
      if (!cur) {
        alertsMap[a.matchup_id][a.alert_type] = { type: a.alert_type, threshold: a.threshold }
      } else if (a.alert_type.startsWith('instant_') && parseFloat(a.threshold) > parseFloat(cur.threshold)) {
        cur.threshold = a.threshold
      } else if (a.alert_type.startsWith('streak_') && parseInt(a.threshold) > parseInt(cur.threshold)) {
        cur.threshold = a.threshold
      }
    }
    // 해외 공개 구매율 매칭 (sportsbettingdime)
    const pbData = pbRes.data || []
    console.log('[PB] 테이블 로드:', pbData.length, '건', pbRes.error || '')
    if (pbData.length > 0) console.log('[PB] 샘플:', pbData[0])

    function findPb(game) {
      const sportMap = { baseball: 'mlb', basketball: 'nba', hockey: 'nhl' }
      const sport = sportMap[game.sport] || game.sport
      if (!['mlb','nba','nhl'].includes(sport)) return null
      const homeAbbr = TEAM_ABBREV[game.home] || ''
      const awayAbbr = TEAM_ABBREV[game.away] || ''
      if (!homeAbbr || !awayAbbr) return null
      const match = pbData.find(pb =>
        pb.sport === sport &&
        pb.home?.toUpperCase() === homeAbbr.toUpperCase() &&
        pb.away?.toUpperCase() === awayAbbr.toUpperCase()
      )
      if (!match && sport === 'mlb') {
        console.log(`[PB] 매칭실패 ${game.away}@${game.home} → abbr=${awayAbbr}@${homeAbbr} sport=${sport}`)
      }
      return match || null
    }

    // 국내 구매율 매칭 (previewn)
    const protoData = protoRes.data || []
    console.log('[Proto] 테이블 로드:', protoData.length, '건', protoRes.error || '')

    function findProto(game) {
      const sportMap = { baseball: 'baseball', basketball: 'basketball', soccer: 'soccer' }
      const protoSport = sportMap[game.sport]
      if (!protoSport) return null

      const norm = s => (s || '').trim().toLowerCase()

      // MLB/NBA: TEAM_ABBREV 약자로 매칭
      if ((game.league === 'MLB') || (game.league === 'NBA')) {
        const homeAbbr = TEAM_ABBREV[game.home] || ''
        const awayAbbr = TEAM_ABBREV[game.away] || ''
        if (!homeAbbr || !awayAbbr) return null
        return protoData.find(p =>
          p.sport === protoSport &&
          p.home_abbr?.toUpperCase() === homeAbbr.toUpperCase() &&
          p.away_abbr?.toUpperCase() === awayAbbr.toUpperCase()
        ) || null
      }

      // KBO/NPB/KBL/soccer: proto.home_abbr = 피나클 영문 팀명으로 직접 비교
      return protoData.find(p =>
        p.sport === protoSport &&
        norm(p.home_abbr) === norm(game.home) &&
        norm(p.away_abbr) === norm(game.away)
      ) || null
    }

    const merged = (linesRes.data || []).filter(g =>
      !/(Games\))/i.test(g.home || '') && !/(Games\))/i.test(g.away || '')
    ).map(g => ({
      ...g,
      opening:      openingsMap[g.matchup_id] || null,
      recentAlerts: alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
      publicBetting: findPb(g),
      protoBetting:  findProto(g),
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
    if (tab !== 'all' && g.sport !== tab) return false
    if (tab !== 'all' && subLeague !== 'all' && g.league !== subLeague) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) =>
    isPastView ? (b.starts_at > a.starts_at ? 1 : -1) : (a.starts_at > b.starts_at ? 1 : -1)
  )
  const activeSports = SPORT_GROUPS.filter(sg => games.some(g => sg.leagues.includes(g.league) && !isInPast(g.starts_at)))
  const currentSportGroup = SPORT_GROUPS.find(sg => sg.key === tab)
  const subLeagues = currentSportGroup
    ? currentSportGroup.leagues.filter(l => games.some(g => g.league === l && !isInPast(g.starts_at)))
    : []
  const pastLeagues = ALL_LEAGUES.filter(l => games.some(g => g.league === l && isInPast(g.starts_at)))

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="sticky top-0 z-10 bg-gray-900 border-b border-gray-700 px-4 pt-4 pb-3">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h1 className="text-2xl font-bold">⚡ 샤프시그널</h1>
            <div className="text-xs text-gray-600">build 2025-04-25 v7</div>
          </div>
          <button onClick={fetchGames} className="text-sm text-gray-400 active:text-white">
            {lastUpdate ? `갱신 ${lastUpdate}` : '새로고침'}
          </button>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => { setTab('all'); setSubLeague('all') }} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>전체</button>
          {activeSports.map(sg => (
            <button key={sg.key} onClick={() => { setTab(sg.key); setSubLeague('all') }} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === sg.key ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
              {sg.label}
            </button>
          ))}
          <button onClick={() => { setTab('past'); setPastLeague('all') }} className={`px-4 py-2 rounded-full text-base font-semibold whitespace-nowrap transition-colors ${tab === 'past' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>🕐 지난경기</button>
        </div>
        {currentSportGroup && subLeagues.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button onClick={() => setSubLeague('all')} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${subLeague === 'all' ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>전체</button>
            {subLeagues.map(l => (
              <button key={l} onClick={() => setSubLeague(l)} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${subLeague === l ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}
        {isPastView && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
            <button onClick={() => setPastLeague('all')} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${pastLeague === 'all' ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>전체</button>
            {pastLeagues.map(l => (
              <button key={l} onClick={() => setPastLeague(l)} className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${pastLeague === l ? 'bg-gray-500 text-white' : 'bg-gray-700 text-gray-300'}`}>
                {LEAGUE_FLAGS[l]} {l}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-4 py-4">
        {loading ? (
          <div className="text-center text-gray-500 py-20">불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-gray-500 py-20">경기 없음</div>
        ) : (
          sorted.map(g => <GameCard key={g.matchup_id} game={g} onClick={() => setSelected(g)} />)
        )}
      </div>

      {selected && <HistoryModal game={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
