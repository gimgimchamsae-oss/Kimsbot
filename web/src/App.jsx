import { useState, useEffect, useRef, useMemo, Component } from 'react'
import { supabase } from './supabase'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { analyzeMatrix3, analyze3MatrixReal } from './matrix3'

// ── Haptic 유틸리티 (안전 호출) ───────────────────────────
const haptic = {
  light:   () => { try { Capacitor.isNativePlatform() && Haptics.impact({ style: ImpactStyle.Light }) } catch (_) {} },
  medium:  () => { try { Capacitor.isNativePlatform() && Haptics.impact({ style: ImpactStyle.Medium }) } catch (_) {} },
  heavy:   () => { try { Capacitor.isNativePlatform() && Haptics.impact({ style: ImpactStyle.Heavy }) } catch (_) {} },
  success: () => { try { Capacitor.isNativePlatform() && Haptics.notification({ type: NotificationType.Success }) } catch (_) {} },
  warning: () => { try { Capacitor.isNativePlatform() && Haptics.notification({ type: NotificationType.Warning }) } catch (_) {} },
  error:   () => { try { Capacitor.isNativePlatform() && Haptics.notification({ type: NotificationType.Error }) } catch (_) {} },
}

// ── 내 픽 (localStorage) ──────────────────────────────────────
const PICKS_KEY = 'sharpsignal_picks_v1'
function loadPicks() {
  try { return JSON.parse(localStorage.getItem(PICKS_KEY) || '[]') } catch (_) { return [] }
}
function savePicks(picks) {
  try { localStorage.setItem(PICKS_KEY, JSON.stringify(picks)) } catch (_) {}
  _picksListeners.forEach(cb => { try { cb(picks) } catch (_) {} })
}
function addPick(pick) {
  const picks = loadPicks()
  picks.unshift(pick)
  savePicks(picks)
}
function removePick(id) {
  const picks = loadPicks().filter(p => p.id !== id)
  savePicks(picks)
}
const _picksListeners = []
function subscribePicks(cb) {
  _picksListeners.push(cb)
  return () => { const i = _picksListeners.indexOf(cb); if (i >= 0) _picksListeners.splice(i, 1) }
}

// 픽 결과 자동 매칭 (베트맨 proto 배열을 받아서 pending 픽을 settle)
// 신규 포맷: { id, type, legs: [{...}], combined_odds, amount, status, ... }
// 구포맷: { id, market, pick, odds, amount, status, ... } (legs 없음)
const PICK_LABEL_MAP = { home: '홈', draw: '무', away: '원정', over: '오버', under: '언더' }
function settleLeg(leg, betmanProto) {
  const proto = betmanProto.find(p =>
    p.sport === leg.sport &&
    p.home === leg.home && p.away === leg.away &&
    p.game_date === leg.game_date
  )
  if (!proto) return false
  const resultStr = proto[`${leg.market}_result`]
  if (!resultStr) return false
  const target = PICK_LABEL_MAP[leg.pick]
  leg.leg_status = resultStr.includes(target) ? 'won' : 'lost'
  leg.score = proto.mch_score || null
  return true
}
function settlePendingPicks(betmanProto) {
  if (!betmanProto || betmanProto.length === 0) return 0
  const picks = loadPicks()
  let changed = 0
  for (const item of picks) {
    if (item.status !== 'pending') continue
    if (Array.isArray(item.legs)) {
      // 신규 포맷
      let anyLost = false, anyPending = false, allWon = true
      for (const leg of item.legs) {
        if (leg.leg_status === 'won') continue
        if (leg.leg_status === 'lost') { anyLost = true; allWon = false; continue }
        const settled = settleLeg(leg, betmanProto)
        if (!settled) { anyPending = true; allWon = false; continue }
        if (leg.leg_status === 'lost') { anyLost = true; allWon = false }
        changed++
      }
      if (anyLost) {
        item.status = 'lost'; item.settled_at = new Date().toISOString(); changed++
      } else if (allWon && !anyPending) {
        item.status = 'won'; item.settled_at = new Date().toISOString(); changed++
      }
    } else {
      // 구포맷 호환
      const proto = betmanProto.find(p =>
        p.sport === item.sport && p.home === item.home && p.away === item.away &&
        p.game_date === item.game_date
      )
      if (!proto) continue
      const resultStr = proto[`${item.market}_result`]
      if (!resultStr) continue
      const target = PICK_LABEL_MAP[item.pick]
      item.status = resultStr.includes(target) ? 'won' : 'lost'
      item.score = proto.mch_score || null
      item.settled_at = new Date().toISOString()
      changed++
    }
  }
  if (changed > 0) savePicks(picks)
  return changed
}

// 픽 정규화 헬퍼 (구/신 포맷 → 공통 인터페이스)
function normalizePick(p) {
  if (Array.isArray(p.legs)) {
    return {
      isCombo: p.legs.length > 1,
      odds: p.combined_odds,
      amount: p.amount,
      status: p.status,
      legs: p.legs,
      created_at: p.created_at,
      raw: p,
    }
  }
  return {
    isCombo: false,
    odds: p.odds,
    amount: p.amount,
    status: p.status,
    legs: [{
      home: p.home, away: p.away, league: p.league,
      sport: p.sport, market: p.market, pick: p.pick,
      pick_label: p.pick_label, odds: p.odds,
      leg_status: p.status, score: p.score, game_date: p.game_date,
    }],
    created_at: p.created_at,
    raw: p,
  }
}

// 픽 저장 모달 트리거 (모듈 레벨 이벤트)
let _pickModalSetter = null
function openPickModal(data) { _pickModalSetter?.(data) }
function _registerPickModal(setter) { _pickModalSetter = setter; return () => { if (_pickModalSetter === setter) _pickModalSetter = null } }

// 픽 추가 플로우 (App 루트에서 렌더링되도록 모듈 레벨 이벤트로 트리거)
let _addPickFlowSetter = null
function openAddPickFlow() { _addPickFlowSetter?.(true) }
function _registerAddPickFlow(setter) { _addPickFlowSetter = setter; return () => { if (_addPickFlowSetter === setter) _addPickFlowSetter = null } }

// 프로젝트(서버 픽) 즉시 갱신 — MyPicks가 listener 등록, saveTicket 성공 후 dispatch
// refresh: 서버 fetch 재호출 / append: 새 픽 객체를 즉시 리스트에 push
let _projectRefreshFn = null
let _projectAppendFn  = null
function triggerProjectRefresh() { try { _projectRefreshFn?.() } catch (_) {} }
function triggerProjectAppend(pick) { try { _projectAppendFn?.(pick) } catch (_) {} }
function _registerProjectRefresh(fn) { _projectRefreshFn = fn; return () => { if (_projectRefreshFn === fn) _projectRefreshFn = null } }
function _registerProjectAppend(fn)  { _projectAppendFn  = fn; return () => { if (_projectAppendFn  === fn) _projectAppendFn  = null } }

// ── Betman 한국어 팀명 → Pinnacle 매핑 ───────────────────────────
// MLB/NBA: TEAM_ABBREV 약어로 매핑 (findProtoImpl MLB/NBA 브랜치에서 약어 비교)
// KBO/K-League: Pinnacle 영어 팀명으로 매핑
const BETMAN_TEAM_MAP = {
  // ── KBO ──────────────────────────────────────────────────────
  'NC다이노스':'NC Dinos','삼성라이온즈':'Samsung Lions',
  '두산베어스':'Doosan Bears','SSG랜더스':'SSG Landers',
  '롯데자이언츠':'Lotte Giants','KIA타이거즈':'Kia Tigers',
  '키움히어로즈':'Kiwoom Heroes','KT위즈':'KT Wiz',
  '한화이글스':'Hanwha Eagles','LG트윈스':'LG Twins',
  // ── MLB (→ TEAM_ABBREV 약어) ──────────────────────────────────
  'LA다저스':'LAD','애틀랜타브레이브스':'ATL','마이애미말린스':'MIA',
  '워싱턴내셔널스':'WSH','밀워키브루어스':'MIL','뉴욕양키스':'NYY',
  '보스턴레드삭스':'BOS','탬파베이레이스':'TB','볼티모어오리올스':'BAL',
  '애슬레틱스':'ATH','샌디에이고파드리스':'SD','세인트루이스카디널스':'STL',
  '샌프란시스코자이언츠':'SF','피츠버그파이어리츠':'PIT',
  '시카고화이트삭스':'CWS','시애틀매리너스':'SEA','신시내티레즈':'CIN',
  '휴스턴애스트로스':'HOU','애리조나다이아몬드백스':'AZ','뉴욕메츠':'NYM',
  '캔자스시티로얄스':'KC','디트로이트타이거즈':'DET',
  '클리블랜드가디언스':'CLE','미네소타트윈스':'MIN',
  '텍사스레인저스':'TEX','시카고컵스':'CHC','토론토블루제이스':'TOR',
  'LA에인절스':'LAA','필라델피아필리스':'PHI','콜로라도로키스':'COL',
  'LA에인절스스':'LAA','오클랜드애슬레틱스':'ATH',
  // ── NBA (→ TEAM_ABBREV 약어) ──────────────────────────────────
  'LA레이커스':'LAL','오클라호마시티썬더':'OKC',
  '미네소타팀버울브스':'MIN','샌안토니오스퍼스':'SAS',
  '클리블랜드캐벌리어스':'CLE','디트로이트피스톤스':'DET',
  '필라델피아76s':'PHI','뉴욕닉스':'NYK',
  '골든스테이트워리어스':'GSW','LA클리퍼스':'LAC',
  '덴버너게츠':'DEN','멤피스그리즐리스':'MEM','마이애미히트':'MIA',
  '밀워키벅스':'MIL','뉴올리언스펠리컨스':'NOP','올랜도매직':'ORL',
  '포틀랜드트레일블레이저스':'POR','피닉스선스':'PHX',
  '새크라멘토킹스':'SAC','토론토랩터스':'TOR','유타재즈':'UTA',
  '워싱턴위저즈':'WSH','보스턴셀틱스':'BOS','브루클린네츠':'BKN',
  '샬럿호네츠':'CHA','시카고불스':'CHI','달라스매버릭스':'DAL',
  '휴스턴로키츠':'HOU','인디애나페이서스':'IND','애틀랜타호크스':'ATL',
  // ── K리그 1 ───────────────────────────────────────────────────
  'FC서울':'FC Seoul','강원FC':'Gangwon FC',
  '제주SKFC':'Jeju SK','인천유나이티드':'Incheon United',
  '김천상무프로축구단':'Gimcheon Sangmu','부천FC1995':'Bucheon FC 1995',
  '전북현대모터스':'Jeonbuk Hyundai Motors','울산HDFC':'Ulsan Hyundai',
  '포항스틸러스':'Pohang Steelers','광주FC':'Gwangju FC',
  '대전하나시티즌':'Daejeon Citizen','대구FC':'Daegu FC',
  'FC안양':'FC Anyang','수원삼성블루윙즈':'Suwon Samsung',
  // ── K리그 2 ───────────────────────────────────────────────────
  '경남FC':'Gyeongnam FC','부산아이파크':'Busan I\'Park',
  '천안시티FC':'Cheonan City FC','성남FC':'Seongnam FC',
  '전남드래곤즈':'Jeonnam Dragons','김해FC2008':'Gimhae FC',
  '충남아산FC':'Chungnam Asan','충북청주FC':'Chungbuk Cheongju',
  '안산그리너스FC':'Ansan Greeners','서울이랜드FC':'Seoul E-Land',
  // ── NPB ───────────────────────────────────────────────────────
  '도쿄야쿠르트스왈로스':'Tokyo Yakult Swallows','주니치드래건스':'Chunichi Dragons',
  '요미우리자이언츠':'Yomiuri Giants','요코하마DeNA베이스타스':'Yokohama Bay Stars','요코하마베이스타스':'Yokohama Bay Stars',
  '홋카이도닛폰햄파이터스':'Hokkaido Nippon-Ham Fighters','오릭스버팔로스':'Orix Buffaloes',
  '지바롯데마린스':'Chiba Lotte Marines','후쿠오카소프트뱅크호크스':'Fukuoka SoftBank Hawks',
  '사이타마세이부라이온즈':'Saitama Seibu Lions','도호쿠라쿠텐골든이글스':'Tohoku Rakuten Golden Eagles',
  '한신타이거즈':'Hanshin Tigers','히로시마도요카프':'Hiroshima Toyo Carp',
  // ── J리그 (J1) ─────────────────────────────────────────────────
  '비셀고베':'Vissel Kobe',
  '교토상가FC':'Kyoto Sanga','교토상가':'Kyoto Sanga',
  '쿄토상가FC':'Kyoto Sanga','쿄토상가':'Kyoto Sanga',
  'FC마치다젤비아':'Machida Zelvia','마치다젤비아':'Machida Zelvia',
  '도쿄베르디':'Tokyo Verdy','FC도쿄':'FC Tokyo',
  '아비스파후쿠오카':'Avispa Fukuoka','세레소오사카':'Cerezo Osaka',
  '파지아노오카야마':'Fagiano Okayama','감바오사카':'Gamba Osaka',
  'JEF유나이티드치바':'JEF United Chiba','제프유나이티드치바':'JEF United Chiba',
  '가시마앤틀러스':'Kashima Antlers','가시와레이솔':'Kashiwa Reysol',
  '가와사키프론탈레':'Kawasaki Frontale','미토홀리호크':'Mito HollyHock',
  '나고야그램퍼스':'Nagoya Grampus','산프레체히로시마':'Sanfrecce Hiroshima',
  '시미즈S펄스':'Shimizu S-Pulse','시미즈에스펄스':'Shimizu S-Pulse',
  '우라와레드다이아몬즈':'Urawa Red Diamonds','우라와레즈':'Urawa Red Diamonds',
  'V파렌나가사키':'V-Varen Nagasaki','브이파렌나가사키':'V-Varen Nagasaki',
  '요코하마F마리노스':'Yokohama F. Marinos','요코하마FM':'Yokohama F. Marinos',
  '요코하마FC':'Yokohama FC',
  // ── EPL ───────────────────────────────────────────────────────
  '노팅엄포리스트':'Nottingham Forest','뉴캐슬유나이티드':'Newcastle United',
  '리버풀':'Liverpool','첼시':'Chelsea','맨체스터시티':'Manchester City',
  '브렌트퍼드':'Brentford','번리':'Burnley','애스턴빌라':'Aston Villa',
  '브라이턴&호브앨비언':'Brighton & Hove Albion','브라이턴호브앨비언':'Brighton & Hove Albion',
  '울버햄프턴원더러스':'Wolverhampton','선덜랜드':'Sunderland',
  '맨체스터유나이티드':'Manchester United','웨스트햄유나이티드':'West Ham United',
  '아스널':'Arsenal','크리스털팰리스':'Crystal Palace','에버턴':'Everton',
  '풀럼':'Fulham','AFC본머스':'Bournemouth','토트넘홋스퍼':'Tottenham Hotspur',
  '레스터시티':'Leicester City','사우샘프턴':'Southampton',
  '입스위치타운':'Ipswich Town','루턴타운':'Luton Town',
  '리즈유나이티드':'Leeds United',
  // ── La Liga ───────────────────────────────────────────────────
  '바르셀로나':'Barcelona','레알마드리드':'Real Madrid','아틀레티코마드리드':'Atletico Madrid',
  '세비야':'Sevilla','비야레알':'Villarreal','아틀레틱빌바오':'Athletic Bilbao',
  '레알소시에다드':'Real Sociedad','레알베티스':'Real Betis','발렌시아':'Valencia',
  '오사수나':'Osasuna','헤타페':'Getafe','셀타비고':'Celta Vigo','RC셀타데비고':'Celta Vigo',
  '알라베스':'Alaves','레반테':'Levante','에스파뇰':'Espanyol','RCD에스파뇰':'Espanyol',
  'RCD마요르카':'Mallorca','그라나다':'Granada','카디스':'Cadiz',
  '레알오비에도':'Real Oviedo','히로나':'Girona','지로나':'Girona','라요바예카노':'Rayo Vallecano',
  '엘체':'Elche','마요르카':'Mallorca',
  // ── Bundesliga ────────────────────────────────────────────────
  '바이에른뮌헨':'Bayern Munich','도르트문트':'Borussia Dortmund',
  '바이어04레버쿠젠':'Bayer Leverkusen','RB라이프치히':'RB Leipzig',
  'VfB슈투트가르트':'VfB Stuttgart','TSG1899호펜하임':'Hoffenheim',
  'VfL볼프스부르크':'Wolfsburg','묀헨글라트바흐':'Borussia Monchengladbach',
  '우니온베를린':'Union Berlin','프랑크푸르트':'Eintracht Frankfurt',
  '프라이부르크':'SC Freiburg','SC프라이부르크':'SC Freiburg',
  '아우크스부르크':'Augsburg','FSV마인츠05':'Mainz 05',
  '쾰른':'FC Koln','하이덴하임':'Heidenheim','장크트파울리':'St. Pauli',
  '함부르크':'Hamburger SV','베르더브레멘':'Werder Bremen',
  '다름슈타트98':'Darmstadt','보훔':'VfL Bochum',
  // ── Serie A ───────────────────────────────────────────────────
  'AC밀란':'AC Milan','인테르나치오날레밀라노':'Internazionale','인테르밀란':'Internazionale',
  '유벤투스':'Juventus','나폴리':'Napoli','SSC나폴리':'Napoli','라치오':'Lazio','SS라치오':'Lazio',
  '아탈란타BC':'Atalanta','AS로마':'Roma','피오렌티나':'Fiorentina','ACF피오렌티나':'Fiorentina',
  '볼로냐':'Bologna','토리노':'Torino','US레체':'Lecce',
  '엘라스베로나':'Hellas Verona','사수올로':'Sassuolo','US사수올로':'Sassuolo',
  '우디네세':'Udinese','살레르니타나':'Salernitana','스페치아':'Spezia',
  '엠폴리':'Empoli','프로시노네':'Frosinone','칼리아리':'Cagliari',
  '제노아':'Genoa','몬차':'Monza','파르마':'Parma','코모1907':'Como 1907',
  'US크레모네세':'Cremonese','피사SC':'Pisa',
  // ── Ligue 1 ───────────────────────────────────────────────────
  '파리생제르맹':'Paris Saint-Germain','마르세유':'Marseille','리옹':'Lyon',
  '모나코':'Monaco','릴':'Lille','렌':'Rennes','니스':'Nice',
  '스트라스부르':'Strasbourg','낭트':'Nantes','렝스':'Reims',
  '몽펠리에':'Montpellier','클레르몽':'Clermont','툴루즈':'Toulouse',
  '앙제':'Angers','르아브르':'Le Havre','브레스트':'Brest',
  '오세르':'Auxerre','렁스':'Reims','메스':'Metz','로리앙':'Lorient',
  // ── MLS ───────────────────────────────────────────────────────
  '애틀랜타유나이티드FC':'Atlanta United','토론토FC':'Toronto FC',
  '뉴욕시티FC':'New York City','CF몽레알':'CF Montreal',
  'LAFC':'Los Angeles FC','미네소타유나이티드FC':'Minnesota United',
  '필라델피아유니언':'Philadelphia Union','콜럼버스크루':'Columbus Crew',
  '뉴잉글랜드레벌루션':'New England Revolution','인터마이애미CF':'Inter Miami',
  '뉴욕레드불스':'New York Red Bulls','FC신시내티':'FC Cincinnati',
  '올랜도시티SC':'Orlando City','DC유나이티드':'D.C. United',
  '스포팅캔자스시티':'Sporting Kansas City','시카고파이어FC':'Chicago Fire',
  '샬럿FC':'Charlotte FC','내슈빌SC':'Nashville SC',
  '새너제이어스퀘이크스':'San Jose Earthquakes','세인트루이스시티SC':'St Louis City SC',
  '휴스턴다이너모FC':'Houston Dynamo','오스틴FC':'Austin FC',
  '포틀랜드팀버스':'Portland Timbers','샌디에이고FC':'San Diego FC',
  'FC댈러스':'FC Dallas','시애틀사운더스FC':'Seattle Sounders',
  'LA갤럭시':'LA Galaxy','콜로라도래피즈':'Colorado Rapids',
  '밴쿠버화이트캡스FC':'Vancouver Whitecaps','레알솔트레이크':'Real Salt Lake',
  // ── Eredivisie ────────────────────────────────────────────────
  '페예노르트':'Feyenoord','PSV에인트호번':'PSV Eindhoven','아약스':'Ajax',
  'AZ알크마르':'AZ Alkmaar','트벤테':'Twente','유트렉트':'FC Utrecht',
  '흐로닝언':'Groningen','헤라클레스알멜로':'Heracles Almelo',
  'NEC네이메헌':'NEC Nijmegen','스파르타로테르담':'Sparta Rotterdam',
  'NAC브레다':'NAC Breda','SC헤이렌베인':'SC Heerenveen',
  'SBV엑셀시오르':'SBV Excelsior','고어헤드이글스':'Go Ahead Eagles',
  '포르튀나시타르트':'Fortuna Sittard','PEC즈볼러':'PEC Zwolle',
  '폴렌담':'FC Volendam','텔스타':'Telstar',
  // ── EFL Championship (잉글랜드 2부) ───────────────────────────
  '버밍엄시티':'Birmingham City','블랙번로버스':'Blackburn Rovers','블랙번':'Blackburn Rovers',
  '브리스톨시티':'Bristol City','브리스톨로버스':'Bristol Rovers',
  '찰턴':'Charlton Athletic','찰턴애슬레틱':'Charlton Athletic',
  '코번트리시티':'Coventry City','코번트리':'Coventry City',
  '더비카운티':'Derby County','더비':'Derby County',
  '헐시티':'Hull City','입스위치타운':'Ipswich Town','입스위치':'Ipswich Town',
  '레스터시티':'Leicester City','레스터':'Leicester City',
  '미들즈브러':'Middlesbrough','밀월':'Millwall',
  '노리치시티':'Norwich City','노리치':'Norwich City',
  '옥스포드유나이티드':'Oxford United','옥스퍼드유나이티드':'Oxford United','옥스포드':'Oxford United',
  '포츠머스':'Portsmouth','프레스턴노스엔드':'Preston North End','프레스턴':'Preston North End',
  'QPR':'Queens Park Rangers','퀸즈파크레인저스':'Queens Park Rangers',
  '셰필드유나이티드':'Sheffield United','쉐필드유나이티드':'Sheffield United',
  '셰필드웬즈데이':'Sheffield Wednesday','쉐필드웬즈데이':'Sheffield Wednesday',
  '스토크시티':'Stoke City','스토크':'Stoke City',
  '스완지시티':'Swansea City','스완지':'Swansea City',
  '왓포드':'Watford','왓퍼드':'Watford',
  '웨스트브롬':'West Bromwich Albion','웨스트브롬위치':'West Bromwich Albion','웨스트브로미치알비온':'West Bromwich Albion','웨스트브롬위치알비온':'West Bromwich Albion',
  '렉섬':'Wrexham','렉서엠':'Wrexham',
}

// 자동 학습된 팀 매핑 (localStorage 영구 저장) - 한글 베트맨 팀명 → 영문 피나클 팀명
const BETMAN_TEAM_MAP_AUTO = (() => {
  try { return JSON.parse(localStorage.getItem('betman_team_map_auto') || '{}') }
  catch { return {} }
})()
function _saveAutoMap() {
  try { localStorage.setItem('betman_team_map_auto', JSON.stringify(BETMAN_TEAM_MAP_AUTO)) } catch {}
}
function betmanTeamName(name) {
  const n = (name || '').trim()
  if (!n) return n
  if (BETMAN_TEAM_MAP[n]) return BETMAN_TEAM_MAP[n]
  if (BETMAN_TEAM_MAP_AUTO[n]) return BETMAN_TEAM_MAP_AUTO[n]
  // 변형 시도: 공백 제거, FC 접두/접미 제거/추가
  const variants = [
    n.replace(/\s+/g, ''),
    n.replace(/\s+/g, '').replace(/^FC/, ''),
    n.replace(/\s+/g, '').replace(/FC$/, ''),
    'FC' + n.replace(/\s+/g, '').replace(/^FC/, ''),
    n.replace(/\s+/g, '').replace(/^FC/, '') + 'FC',
  ]
  for (const v of variants) {
    if (BETMAN_TEAM_MAP[v]) return BETMAN_TEAM_MAP[v]
    if (BETMAN_TEAM_MAP_AUTO[v]) return BETMAN_TEAM_MAP_AUTO[v]
  }
  return n
}
// 디버깅용 - 브라우저 콘솔에서 확인/초기화 가능
if (typeof window !== 'undefined') {
  window.getAutoMap = () => ({ ...BETMAN_TEAM_MAP_AUTO })
  window.clearAutoMap = () => {
    for (const k of Object.keys(BETMAN_TEAM_MAP_AUTO)) delete BETMAN_TEAM_MAP_AUTO[k]
    _saveAutoMap()
    console.log('[BETMAN auto-map cleared]')
  }
  // 베트맨 직접 데이터에서 모든 raw 한글 팀명 출력 (매핑 디버깅용)
  window.dumpBetmanTeams = () => {
    const teams = new Set()
    for (const p of (window._betmanDirectDump || [])) {
      if (p.home_raw) teams.add(p.home_raw)
      if (p.away_raw) teams.add(p.away_raw)
    }
    const arr = Array.from(teams).sort()
    console.log('[BETMAN raw teams]', arr)
    return arr
  }
}

// ── 자동 매칭 학습: betman 한글 팀명 ↔ pinnacle 영문 팀명 ─────────
// 같은 날짜 같은 스포츠의 피나클 게임과 비교해서, 한쪽이 매칭되면 반대쪽도 자동 학습.
// 양쪽 모두 unmapped이고 후보가 정확히 1개면 둘 다 학습 (안전 케이스).
function learnBetmanTeams(betmanGames, pinnacleGames) {
  if (!betmanGames?.length || !pinnacleGames?.length) return 0
  // normSoccerName는 외부 정의됨 (하단)
  const ns = (typeof normSoccerName === 'function') ? normSoccerName : (s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
  let learned = 0
  for (const bg of betmanGames) {
    const home = bg.home_raw || bg.home
    const away = bg.away_raw || bg.away
    const hasKoHome = /[가-힣]/.test(home) && !BETMAN_TEAM_MAP[home] && !BETMAN_TEAM_MAP_AUTO[home]
    const hasKoAway = /[가-힣]/.test(away) && !BETMAN_TEAM_MAP[away] && !BETMAN_TEAM_MAP_AUTO[away]
    if (!hasKoHome && !hasKoAway) continue

    // 같은 스포츠 + 같은 리그 + 같은 날짜 피나클 후보
    // (리그 필터 안 하면 A-리그 같은 마이너리그 팀이 같은 날 EPL/세리에A 후보들이랑 섞여서
    //  candidates.length > 1 이 되어 케이스 2 학습 안 됨)
    const bgLg = bg.league_norm || (typeof normalizeBetmanLeague === 'function' ? normalizeBetmanLeague(bg.league) : bg.league)
    const candidates = pinnacleGames.filter(p => {
      if (p.sport !== bg.sport) return false
      // 피나클 starts_at은 "MM/DD HH:MM" KST. bg.game_date는 "YYYY-MM-DD" KST
      if (!p.starts_at || !bg.game_date) return false
      const m = p.starts_at.match(/(\d{2})\/(\d{2})/)
      if (!m) return false
      if (bg.game_date.slice(5) !== `${m[1]}-${m[2]}`) return false
      // 리그 일치 (양쪽 다 정규화된 리그명이어야 매칭됨)
      if (bgLg && p.league && p.league !== bgLg) return false
      return true
    })
    if (candidates.length === 0) continue

    // 영문화된 이름 (한쪽이 이미 매핑되어 앵커 역할)
    const bH_en = betmanTeamName(home), bA_en = betmanTeamName(away)
    const bH = ns(bH_en), bA = ns(bA_en)

    // 케이스 1: 둘 중 하나가 앵커로 작동하는 경우 (단일 매칭)
    if (hasKoHome !== hasKoAway) {
      const anchor = hasKoHome ? bA : bH
      if (!anchor) continue
      const matches = candidates.filter(p => {
        const pH = ns(p.home_abbr || p.home), pA = ns(p.away_abbr || p.away)
        return anchor === pH || anchor === pA
      })
      if (matches.length !== 1) continue
      const p = matches[0]
      const pH = ns(p.home_abbr || p.home), pA = ns(p.away_abbr || p.away)
      if (hasKoHome) {
        // bA가 앵커 → bA가 pH면 home은 pA, bA가 pA면 home은 pH
        const target = (bA === pH) ? (p.away_abbr || p.away) : (p.home_abbr || p.home)
        BETMAN_TEAM_MAP_AUTO[home] = target
        learned++
        console.log('[BETMAN auto-learn]', home, '→', target)
      }
      if (hasKoAway) {
        const target = (bH === pH) ? (p.away_abbr || p.away) : (p.home_abbr || p.home)
        BETMAN_TEAM_MAP_AUTO[away] = target
        learned++
        console.log('[BETMAN auto-learn]', away, '→', target)
      }
    }
    // 케이스 2: 둘 다 unmapped → 같은 날짜+스포츠 후보가 정확히 1개면 안전하게 학습
    else if (hasKoHome && hasKoAway && candidates.length === 1) {
      const p = candidates[0]
      BETMAN_TEAM_MAP_AUTO[home] = p.home_abbr || p.home
      BETMAN_TEAM_MAP_AUTO[away] = p.away_abbr || p.away
      learned += 2
      console.log('[BETMAN auto-learn pair]', home, '→', p.home_abbr || p.home, '/', away, '→', p.away_abbr || p.away)
    }
  }
  if (learned > 0) _saveAutoMap()
  return learned
}

// ── Betman 직접 호출 (앱에서 직접, CORS 우회) ────────────────────
const BETMAN_BUYABLE_API = 'https://www.betman.co.kr/buyPsblGame/inqCacheBuyAbleGameInfoList.do'
const BETMAN_BUYABLE_URL = 'https://www.betman.co.kr/main/mainPage/gamebuy/buyableGameList.do'
const BETMAN_GAME_API    = 'https://www.betman.co.kr/buyPsblGame/gameInfoInq.do'
const BETMAN_GAMESLIP    = 'https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do'
const BETMAN_RESULT_API  = 'https://www.betman.co.kr/gamebuy/winrst/inqWinrstDetlBody.do'
const BETMAN_RESULT_URL  = 'https://www.betman.co.kr/main/mainPage/gamebuy/winrstDetl.do'
const BETMAN_HIDDEN      = ['SUM', '전반', '승1패']
const BETMAN_SPORT_MAP   = { BS: 'baseball', BK: 'basketball', SC: 'soccer' }
const BETMAN_HEADERS     = {
  'Content-Type': 'application/json; charset=UTF-8',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0',
}

function betmanKstDate(ms) {
  // Pinnacle starts_at은 KST 기준 날짜 → betman ms도 KST 날짜로 변환
  if (!ms) return ''
  const kst = new Date(parseInt(ms) + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}
function betmanKstStartsAt(ms) {
  // Pinnacle starts_at 포맷 "MM/DD HH:MM" (KST)
  if (!ms) return ''
  const kst = new Date(parseInt(ms) + 9 * 60 * 60 * 1000)
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(kst.getUTCDate()).padStart(2, '0')
  const hh = String(kst.getUTCHours()).padStart(2, '0')
  const mi = String(kst.getUTCMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${mi}`
}
// 베트맨 리그 약어 → 정규 리그명
const BETMAN_LEAGUE_MAP = {
  'EFL챔': 'EFL Championship', 'EFL챔피언십': 'EFL Championship',
  '프리미어리그': 'EPL', 'EPL': 'EPL',
  '라리가': 'La Liga', '세리에A': 'Serie A',
  '분데스리가': 'Bundesliga', '리그앙': 'Ligue 1',
  'MLB': 'MLB', 'KBO': 'KBO', 'NPB': 'NPB',
  'NBA': 'NBA', 'KBL': 'KBL',
  'K리그1': 'K리그1', 'K리그2': 'K리그2',
  'MLS': 'MLS', 'J1리그': 'J리그', 'J리그': 'J리그',
  'J1백년': 'J리그', 'J1백년구상리그': 'J리그',  // 베트맨 실제 사용 (백년구상=Centenary Vision)
  'J2리그': 'J리그2', 'J리그2': 'J리그2',
  'J3리그': 'J리그2', 'J리그3': 'J리그2',   // J3도 Pinnacle에서 J2와 통합
  'UCL': 'UCL', '챔스': 'UCL', '챔피언스리그': 'UCL',
  '유로파': 'Europa', '유로파리그': 'Europa',
  '컨퍼런스': 'Conference', '컨퍼런스리그': 'Conference',
}
function normalizeBetmanLeague(league) {
  const l = (league || '').trim()
  return BETMAN_LEAGUE_MAP[l] || l
}
function betmanPct(c, t) { return t ? Math.round(c * 1000 / t) / 10 : 0 }
function betmanAmt(c, total, sell) {
  return (c && total && sell) ? Math.round(sell * c / total) : 0
}

// 베트맨 결과 파서: inqWinrstDetlBody.do 응답 → 팀+날짜 키별 결과 맵
function parseBetmanResults(data) {
  const rows = data?.detlBody || []
  // 키: "sport|home|away|YYYY-MM-DD" → { ml_result, sp_result, ou_result, mch_score }
  const map = {}
  for (const r of rows) {
    const sport = BETMAN_SPORT_MAP[r.MCH_SPORT_CD]
    if (!sport) continue
    const market = r.BETTYP_NM || ''
    if (BETMAN_HIDDEN.some(k => market.includes(k))) continue

    // 날짜 (KST)
    const fix = r.FIX_MCH_DTM || ''
    if (!fix) continue
    const gameDate = `${fix.slice(0,4)}-${fix.slice(4,6)}-${fix.slice(6,8)}`
    const homeKor = r.HOME_TEAM || ''
    const awayKor = r.AWAY_TEAM || ''
    const home = betmanTeamName(homeKor)
    const away = betmanTeamName(awayKor)
    const key = `${sport}|${home}|${away}|${gameDate}`

    if (!map[key]) {
      map[key] = {
        sport, home, away, game_date: gameDate,
        home_raw: homeKor, away_raw: awayKor,
      }
    }
    const target = map[key]

    // GAME_RESULT: "0"=WIN_TXT, "1"=DRAW_TXT, "2"=LOSE_TXT, 그 외=미정
    const gr = String(r.GAME_RESULT ?? '').trim()
    if (!gr || gr === '' || gr === '-1') continue  // 미정 스킵

    // 결과 라벨 (홈/무/원정 또는 오버/언더)
    let outcomeCode = ''
    if (gr === '0') outcomeCode = '홈'
    else if (gr === '1') outcomeCode = '무'
    else if (gr === '2') outcomeCode = '원정'

    if (market.includes('언더오버') || market.includes('언더/오버')) {
      // 언오버: WIN_TXT가 "오버" 또는 "언더"라 라벨 직접 사용
      if (gr === '0')      target.ou_result = r.WIN_TXT
      else if (gr === '2') target.ou_result = r.LOSE_TXT
      else if (gr === '1') target.ou_result = '무'
    } else if (market.includes('핸디')) {
      target.sp_result = outcomeCode
    } else if (market.includes('승무패') || market.includes('승패')) {
      target.ml_result = outcomeCode
      // ML 행에 MCH_SCORE 있음 (실제 스코어)
      if (r.MCH_SCORE) target.mch_score = r.MCH_SCORE
    }
  }
  return map
}

function parseBetmanData(data) {
  const votes = {}
  for (const v of (data.voteStatus || [])) votes[parseInt(v.GM_SEQ)] = v
  // tooltipList → matchSeq 별 배당 변동 이력 (오프닝 추출용)
  // 항목 1개당: BCHG_*_ODDS (변동 전, ×100 정수), ACHG_*_ODDS (변동 후), BCHG_W_HANDI_RT (변동 전 기준점)
  // history[0] = 최신 변동, history[length-1] = 가장 옛 변동 → length-1 의 BCHG = 진짜 오프닝
  const tooltipMap = {}
  for (const tip of (data.tooltipList || [])) {
    const seq = parseInt(tip.GM_SEQ)
    if (!Number.isFinite(seq)) continue
    if (!tooltipMap[seq]) tooltipMap[seq] = []
    tooltipMap[seq].push(tip)
  }
  // ×100 정수 → 2자리 소수 (245 → 2.45)
  const oddsOpen = v => (v == null || v === '' || v === 0 || v === '0') ? null : Math.round(Number(v)) / 100
  const getOpen = (hist, key) => {
    if (!hist || hist.length === 0) return null
    return oddsOpen(hist[hist.length - 1][`BCHG_${key}_ODDS`])
  }
  const totalSell = parseInt(data.currentLottery?.totalSellAmount || 0)
  const keys = data.compSchedules?.keys || []
  const rawRows = []

  for (const rawRow of (data.compSchedules?.datas || [])) {
    const s = Object.fromEntries(keys.map((k, i) => [k, rawRow[i]]))
    const market = s.betNm || s.betTypNm || ''
    if (BETMAN_HIDDEN.some(k => market.includes(k))) continue
    const seq = parseInt(s.matchSeq)
    const v = votes[seq] || {}
    const wc = parseInt(v.W_BET_CNT || 0)
    const dc = parseInt(v.D_BET_CNT || 0)
    const lc = parseInt(v.L_BET_CNT || 0)
    const tot = wc + dc + lc
    const hist = tooltipMap[seq] || []
    rawRows.push({
      gameDate: betmanKstDate(s.gameDate), startsAt: betmanKstStartsAt(s.gameDate), itemCode: s.itemCode || '',
      league: s.leagueShortName || s.leagueName || '',
      home: s.homeName || '', away: s.awayName || '',
      market, base: String(s.winHandi || s.loseHandi || '').trim().replace(/\.0+$/, ''),
      winTxt: s.winTxt || '', winCount: wc,
      drawTxt: s.drawTxt || '', drawCount: dc,
      loseTxt: s.loseTxt || '', loseCount: lc,
      totalCount: tot, totalSell,
      winAllot: s.winAllot ?? null, drawAllot: s.drawAllot ?? null, loseAllot: s.loseAllot ?? null,
      // 오프닝 배당 (history 없으면 null = 변동 없음)
      winAllotOpen: getOpen(hist, 'W'), drawAllotOpen: getOpen(hist, 'D'), loseAllotOpen: getOpen(hist, 'L'),
    })
  }

  // 전체 회차 총 베팅수 합산 (Python betman_purchase_status.py 동일 로직)
  const allTotal = rawRows.reduce((s, r) => s + r.totalCount, 0)
  for (const r of rawRows) {
    r.winPct  = betmanPct(r.winCount,  r.totalCount)
    r.drawPct = betmanPct(r.drawCount, r.totalCount)
    r.losePct = betmanPct(r.loseCount, r.totalCount)
    r.winAmt  = betmanAmt(r.winCount,  allTotal, totalSell)
    r.drawAmt = betmanAmt(r.drawCount, allTotal, totalSell)
    r.loseAmt = betmanAmt(r.loseCount, allTotal, totalSell)
  }

  const grouped = {}
  for (const r of rawRows) {
    const sport = BETMAN_SPORT_MAP[r.itemCode]
    if (!sport || !r.gameDate) continue
    const key = `${sport}|${r.league}|${r.home}|${r.away}|${r.gameDate}`
    if (!grouped[key]) {
      grouped[key] = {
        sport, league: r.league, home: betmanTeamName(r.home), away: betmanTeamName(r.away),
        home_abbr: betmanTeamName(r.home), away_abbr: betmanTeamName(r.away),
        home_raw: r.home, away_raw: r.away,  // 자동 학습용 원본 한글 이름 보존
        game_date: r.gameDate, starts_at: r.startsAt, league_norm: normalizeBetmanLeague(r.league),
        updated_at: new Date().toISOString(),
        totalSell: r.totalSell,
      }
    }
    const t = grouped[key]
    const { market, winTxt, loseTxt, drawTxt } = r
    if (market.includes('언더오버') || market.includes('언더/오버')) {
      if (winTxt.includes('언더'))  { t.ou_bets_under = r.winPct;  t.ou_bets_under_count = r.winCount;  t.ou_bets_under_amount = r.winAmt;  t.ou_allot_under = r.winAllot;  t.ou_allot_under_open = r.winAllotOpen }
      if (winTxt.includes('오버'))  { t.ou_bets_over  = r.winPct;  t.ou_bets_over_count  = r.winCount;  t.ou_bets_over_amount  = r.winAmt;  t.ou_allot_over  = r.winAllot;  t.ou_allot_over_open  = r.winAllotOpen }
      if (loseTxt.includes('언더')) { t.ou_bets_under = r.losePct; t.ou_bets_under_count = r.loseCount; t.ou_bets_under_amount = r.loseAmt; t.ou_allot_under = r.loseAllot; t.ou_allot_under_open = r.loseAllotOpen }
      if (loseTxt.includes('오버')) { t.ou_bets_over  = r.losePct; t.ou_bets_over_count  = r.loseCount; t.ou_bets_over_amount  = r.loseAmt; t.ou_allot_over  = r.loseAllot; t.ou_allot_over_open  = r.loseAllotOpen }
      t.ou_base = r.base
      // 모든 언오버 라인 누적 (기준점별 - 배당 + 구매율/건수/금액)
      if (!t.ou_lines) t.ou_lines = []
      let line = t.ou_lines.find(l => l.base === r.base)
      if (!line) { line = { base: r.base }; t.ou_lines.push(line) }
      if (winTxt.includes('오버'))  { line.allot_over  = r.winAllot;  line.allot_over_open  = r.winAllotOpen;  line.pct_over  = r.winPct;  line.count_over  = r.winCount;  line.amount_over  = r.winAmt }
      if (winTxt.includes('언더'))  { line.allot_under = r.winAllot;  line.allot_under_open = r.winAllotOpen;  line.pct_under = r.winPct;  line.count_under = r.winCount;  line.amount_under = r.winAmt }
      if (loseTxt.includes('오버')) { line.allot_over  = r.loseAllot; line.allot_over_open  = r.loseAllotOpen; line.pct_over  = r.losePct; line.count_over  = r.loseCount; line.amount_over  = r.loseAmt }
      if (loseTxt.includes('언더')) { line.allot_under = r.loseAllot; line.allot_under_open = r.loseAllotOpen; line.pct_under = r.losePct; line.count_under = r.loseCount; line.amount_under = r.loseAmt }
    } else if (market.includes('핸디')) {
      t.sp_bets_home = r.winPct;  t.sp_bets_home_count = r.winCount;  t.sp_bets_home_amount = r.winAmt;  t.sp_allot_home = r.winAllot;  t.sp_allot_home_open = r.winAllotOpen
      t.sp_bets_draw = r.drawPct; t.sp_bets_draw_count = r.drawCount; t.sp_bets_draw_amount = r.drawAmt; t.sp_allot_draw = r.drawAllot; t.sp_allot_draw_open = r.drawAllotOpen
      t.sp_bets_away = r.losePct; t.sp_bets_away_count = r.loseCount; t.sp_bets_away_amount = r.loseAmt; t.sp_allot_away = r.loseAllot; t.sp_allot_away_open = r.loseAllotOpen
      t.sp_base = r.base
      // 모든 핸디 라인 누적 (기준점별)
      if (!t.sp_lines) t.sp_lines = []
      let line = t.sp_lines.find(l => l.base === r.base)
      if (!line) { line = { base: r.base }; t.sp_lines.push(line) }
      line.allot_home = r.winAllot;  line.allot_home_open = r.winAllotOpen;  line.pct_home = r.winPct;  line.count_home = r.winCount;  line.amount_home = r.winAmt
      line.allot_draw = r.drawAllot; line.allot_draw_open = r.drawAllotOpen; line.pct_draw = r.drawPct; line.count_draw = r.drawCount; line.amount_draw = r.drawAmt
      line.allot_away = r.loseAllot; line.allot_away_open = r.loseAllotOpen; line.pct_away = r.losePct; line.count_away = r.loseCount; line.amount_away = r.loseAmt
    } else if (market.includes('승무패') || market.includes('승패')) {
      t.ml_bets_home = r.winPct;  t.ml_bets_home_count = r.winCount;  t.ml_bets_home_amount = r.winAmt;  t.ml_allot_home = r.winAllot;  t.ml_allot_home_open = r.winAllotOpen
      if (drawTxt && drawTxt !== '-') {
        t.ml_bets_draw = r.drawPct; t.ml_bets_draw_count = r.drawCount; t.ml_bets_draw_amount = r.drawAmt; t.ml_allot_draw = r.drawAllot; t.ml_allot_draw_open = r.drawAllotOpen
      }
      t.ml_bets_away = r.losePct; t.ml_bets_away_count = r.loseCount; t.ml_bets_away_amount = r.loseAmt; t.ml_allot_away = r.loseAllot; t.ml_allot_away_open = r.loseAllotOpen
      t.ml_has_draw = (drawTxt && drawTxt !== '-') ? true : (t.ml_has_draw || false)
    }
  }
  return Object.values(grouped)
}

// ── 에러 경계: 렌더 크래시 시 흰 화면 대신 에러 메시지 표시 ─────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  componentDidCatch(e, info) { console.error('[ErrorBoundary]', e, info) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', background: '#fff0f0', minHeight: '100vh' }}>
          <h2 style={{ color: '#c00', marginBottom: 8 }}>렌더 에러</h2>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#333' }}>
            {String(this.state.error)}{'\n\n'}{this.state.error?.stack}
          </pre>
          <button style={{ marginTop: 16, padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8 }}
            onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const ADMIN_EMAIL  = import.meta.env.VITE_ADMIN_EMAIL
const API_BASE     = 'https://sharpsignal.cloud'
const GAMES_API    = 'https://sharpsignal.cloud'   // 토토 games API (Vercel 대체)
const TRIAL_DAYS   = 7
const KAKAO_ID     = 'sharpsignal'
const PLANS        = [
  { label: '1일',  days: 1,  price: '5,500원' },
  { label: '10일', days: 10, price: '55,000원' },
  { label: '30일', days: 30, price: '150,000원' },
]

// 커스텀 plugin: Android Settings.Secure.ANDROID_ID 직접 조회
// Capacitor 기본 Device.getId()는 앱 데이터 클리어 시 변경되므로 중복 체험 방지엔 부족
const AndroidIdPlugin = registerPlugin('AndroidId')

async function getDeviceId() {
  // 1순위: 커스텀 AndroidId plugin (ANDROID_ID, 앱 재설치해도 동일)
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    try {
      const { id } = await AndroidIdPlugin.get()
      if (id && id.length > 0) {
        localStorage.setItem('sharp_device_id', id)
        return id
      }
    } catch (e) {
      console.warn('[getDeviceId] AndroidId plugin failed:', e)
    }
  }
  // 2순위: Capacitor 기본 Device.getId() (iOS 또는 fallback)
  if (Capacitor.isNativePlatform()) {
    try {
      const info = await Device.getId()
      const nativeId = info?.identifier
      if (nativeId) {
        localStorage.setItem('sharp_device_id', nativeId)
        return nativeId
      }
    } catch (e) {
      console.warn('[getDeviceId] native failed:', e)
    }
  }
  // 3순위: 이전 캐시 값
  let id = localStorage.getItem('sharp_device_id')
  if (id) return id
  // 4순위: 최후 fallback
  id = crypto.randomUUID()
  localStorage.setItem('sharp_device_id', id)
  return id
}

function trialDaysLeft(sub) {
  if (!sub?.trial_started_at) return 0
  const end = new Date(sub.trial_started_at)
  end.setDate(end.getDate() + TRIAL_DAYS)
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000))
}

// ── Toast 시스템 ──────────────────────────────────────
const _toastListeners = []
const _toastSubscribe = (cb) => { _toastListeners.push(cb); return () => { const i = _toastListeners.indexOf(cb); if (i >= 0) _toastListeners.splice(i, 1) } }
function toast(message, opts = {}) {
  const item = { id: Date.now() + Math.random(), message, ...opts }
  _toastListeners.forEach(cb => cb(item))
}
toast.success = (m) => { haptic.success(); toast(m, { type: 'success' }) }
toast.error   = (m) => { haptic.error();   toast(m, { type: 'error' }) }
toast.warn    = (m) => { haptic.warning(); toast(m, { type: 'warn' }) }
toast.info    = (m) => toast(m, { type: 'info' })

function ToastContainer() {
  const [items, setItems] = useState([])
  useEffect(() => {
    return _toastSubscribe((item) => {
      setItems(prev => [...prev, item])
      setTimeout(() => {
        setItems(prev => prev.filter(t => t.id !== item.id))
      }, item.duration || 2500)
    })
  }, [])
  const colorMap = {
    success: 'bg-emerald-600 text-white',
    error:   'bg-rose-600 text-white',
    warn:    'bg-amber-500 text-white',
    info:    'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900',
  }
  return (
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 12px)' }}>
      {items.map(t => (
        <div key={t.id}
          className={`px-4 py-2.5 rounded-full text-sm font-semibold shadow-lg fade-in
            ${colorMap[t.type] || colorMap.info}`}
          style={{ animation: 'fadeIn 0.2s ease-out' }}>
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Swipe 제스처 (메인 탭 좌우 이동) ──────────────────────
function SwipeNav({ tabs, activeKey, onChange, children }) {
  const startX = useRef(0)
  const startY = useRef(0)
  const tracking = useRef(false)
  const THRESHOLD = 80
  const VERTICAL_TOLERANCE = 40

  const onTouchStart = (e) => {
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    tracking.current = true
  }
  const onTouchMove = (e) => {
    if (!tracking.current) return
    const dy = Math.abs(e.touches[0].clientY - startY.current)
    if (dy > VERTICAL_TOLERANCE) tracking.current = false
  }
  const onTouchEnd = (e) => {
    if (!tracking.current) return
    tracking.current = false
    const dx = e.changedTouches[0].clientX - startX.current
    if (Math.abs(dx) < THRESHOLD) return
    const idx = tabs.indexOf(activeKey)
    if (dx < 0 && idx < tabs.length - 1) {
      haptic.light()
      onChange(tabs[idx + 1])
    } else if (dx > 0 && idx > 0) {
      haptic.light()
      onChange(tabs[idx - 1])
    }
  }
  return (
    <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      {children}
    </div>
  )
}

// ── 부드러운 숫자 카운트 애니메이션 ────────────────────
function AnimatedNumber({ value, duration = 400, format = (v) => Math.round(v) }) {
  const [display, setDisplay] = useState(value)
  const start = useRef(value)
  const target = useRef(value)
  const animFrom = useRef(0)
  useEffect(() => {
    if (target.current === value) return
    start.current = display
    target.current = value
    animFrom.current = performance.now()
    let raf
    const tick = () => {
      const t = Math.min(1, (performance.now() - animFrom.current) / duration)
      const eased = 1 - Math.pow(1 - t, 3)  // easeOutCubic
      const cur = start.current + (target.current - start.current) * eased
      setDisplay(cur)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return <>{format(display)}</>
}

// ── Pull-to-Refresh 컴포넌트 ──────────────────────────
function PullToRefresh({ onRefresh, children }) {
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(0)
  const containerRef = useRef(null)
  const MAX_PULL = 100
  const TRIGGER = 60

  const onTouchStart = (e) => {
    if (refreshing) return
    if (window.scrollY > 5) return  // 스크롤 위에 있을 때만
    startY.current = e.touches[0].clientY
  }
  const onTouchMove = (e) => {
    if (refreshing || !startY.current) return
    if (window.scrollY > 5) { startY.current = 0; setPullDistance(0); return }
    const delta = e.touches[0].clientY - startY.current
    if (delta > 0) {
      e.preventDefault()
      setPullDistance(Math.min(delta * 0.5, MAX_PULL))
    }
  }
  const onTouchEnd = async () => {
    if (refreshing || !startY.current) return
    startY.current = 0
    if (pullDistance >= TRIGGER) {
      setRefreshing(true)
      haptic.medium()
      try { await onRefresh() } catch (_) {}
      setRefreshing(false)
    }
    setPullDistance(0)
  }

  const progress = Math.min(pullDistance / TRIGGER, 1)

  return (
    <div ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ touchAction: 'pan-y' }}>
      {/* 인디케이터 */}
      <div className="flex items-center justify-center overflow-hidden transition-all"
        style={{ height: refreshing ? 50 : pullDistance, marginTop: refreshing ? 8 : 0 }}>
        <div className={`w-8 h-8 rounded-full border-2 border-indigo-500 border-t-transparent
          ${refreshing ? 'animate-spin' : ''}`}
          style={{
            transform: refreshing ? 'none' : `rotate(${progress * 360}deg)`,
            opacity: Math.max(progress, refreshing ? 1 : 0),
          }} />
      </div>
      <div style={{ transform: `translateY(${refreshing ? 0 : pullDistance * 0.5}px)`, transition: pullDistance === 0 && !refreshing ? 'transform 0.2s' : 'none' }}>
        {children}
      </div>
    </div>
  )
}

// ── 스켈레톤 로더 ─────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-4 mb-3 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="skeleton w-20 h-5 rounded-full" />
        <div className="skeleton w-24 h-3 rounded-full" />
      </div>
      <div className="skeleton w-3/4 h-6 rounded mb-3" />
      <div className="grid grid-cols-3 gap-2">
        <div className="skeleton h-14 rounded-xl" />
        <div className="skeleton h-14 rounded-xl" />
        <div className="skeleton h-14 rounded-xl" />
      </div>
    </div>
  )
}

function SkeletonList({ count = 5 }) {
  return (
    <div className="px-3 py-4">
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
    </div>
  )
}

// ── 하단 탭바 ────────────────────────────────────────────
function BottomTabBar({ mainTab, setMainTab, hasNewAlert }) {
  const tabs = [
    {
      key: 'sports',
      label: '스포츠',
      activeColor: 'text-indigo-600',
      icon: (active) => (
        <svg width="26" height="26" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>
        </svg>
      ),
    },
    {
      key: 'mypicks',
      label: '프로젝트',
      activeColor: 'text-emerald-600',
      icon: (active) => (
        <svg width="26" height="26" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z"/>
        </svg>
      ),
    },
    {
      key: 'pattern',
      label: '패턴',
      activeColor: 'text-rose-500',
      icon: (active) => (
        <svg width="26" height="26" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'}
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12h4l2-7 4 14 2-7h6"/>
        </svg>
      ),
    },
    {
      key: 'more',
      label: '더보기',
      activeColor: 'text-slate-900',
      icon: (active) => (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth={active ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6"/>
          <line x1="3" y1="12" x2="21" y2="12"/>
          <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
      ),
    },
  ]

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 z-30 w-full max-w-[520px]
      bg-white dark:bg-slate-950 border-t border-slate-100 dark:border-slate-800 shadow-[0_-2px_12px_rgba(0,0,0,0.04)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="grid grid-cols-4">
        {tabs.map(t => {
          const active = mainTab === t.key
          // 더보기 탭은 다크모드에서 흰색이어야 함
          const activeColor = t.key === 'more' ? 'text-slate-900 dark:text-slate-100' : t.activeColor
          return (
            <button key={t.key}
              onClick={() => { haptic.light(); setMainTab(t.key) }}
              className={`flex flex-col items-center justify-center py-3 gap-1 transition-all
                ${active ? activeColor : 'text-slate-400 dark:text-slate-500'}
                active:scale-95`}>
              <div className={`${active ? '' : 'opacity-70'}`}>{t.icon(active)}</div>
              <span className={`text-[12px] font-bold ${active ? '' : 'text-slate-500 dark:text-slate-500'}`}>{t.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

// ── 법적 문서 모달 (약관, 개인정보, 앱 정보) ────────────
function LegalModal({ kind, onClose }) {
  const docs = {
    terms: {
      title: '이용 약관',
      content: `
제 1 조 (목적)
본 약관은 샤프시그널(이하 "회사")이 제공하는 모바일 애플리케이션 서비스(이하 "서비스")를 이용함에 있어 회사와 이용자의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.

제 2 조 (정의)
1. "서비스"란 회사가 제공하는 스포츠 베팅 분석, 라이브 게임 패턴 분석 등 일체의 서비스를 의미합니다.
2. "이용자"란 본 약관에 따라 회사가 제공하는 서비스를 이용하는 회원을 말합니다.

제 3 조 (서비스의 성격)
1. 본 서비스는 정보 제공을 목적으로 하며, 모든 베팅 결정은 이용자 본인의 책임입니다.
2. 본 서비스는 실제 도박이나 베팅을 직접 중개하지 않으며, 분석 도구만을 제공합니다.
3. 회사는 분석 결과의 정확성을 보장하지 않으며, 이용자의 손실에 대해 책임지지 않습니다.

제 4 조 (회원가입 및 자격)
1. 만 19세 이상만 가입 가능합니다.
2. 가입 시 제공한 정보가 허위인 경우 서비스 이용이 제한될 수 있습니다.

제 5 조 (서비스 이용)
1. 회사는 24시간 서비스 제공을 원칙으로 하나, 시스템 점검 등의 사유로 일시 중단될 수 있습니다.
2. 이용자는 서비스를 불법적이거나 부당한 목적으로 이용해서는 안 됩니다.

제 6 조 (구독 및 환불)
1. 유료 구독은 결제 즉시 활성화됩니다.
2. 디지털 콘텐츠 특성상 결제 후 즉시 이용한 경우 환불이 제한될 수 있습니다.
3. 환불 정책은 Google Play Store 정책을 따릅니다.

제 7 조 (책임 한계)
1. 본 서비스가 제공하는 정보는 참고용이며, 회사는 정보 활용으로 인한 손실에 책임지지 않습니다.
2. 도박은 중독성이 있으며, 본인의 경제력 범위 내에서 책임감 있게 이용하시기 바랍니다.
3. 도박 중독 문제가 있다면 한국도박문제관리센터(1336)로 문의하세요.

제 8 조 (약관 변경)
회사는 필요 시 본 약관을 변경할 수 있으며, 변경 시 앱 내 공지를 통해 안내합니다.

시행일: 2026년 5월 1일
`,
    },
    privacy: {
      title: '개인정보 처리방침',
      content: `
1. 수집하는 개인정보 항목
- 필수: 이메일, 닉네임 (소셜 로그인 시 자동 수집)
- 자동 수집: 기기 ID, 앱 사용 기록, OS 버전

2. 개인정보 수집 및 이용 목적
- 회원 식별 및 본인 확인
- 서비스 제공 (체험판, 구독 관리)
- 부정 이용 방지 (동일 기기 중복 체험판 방지)
- 서비스 개선 및 통계 분석

3. 개인정보 보유 및 이용 기간
- 회원 탈퇴 시까지 (단, 관련 법령에 따라 일정 기간 보관 가능)
- 결제 기록: 5년 (전자상거래법)

4. 개인정보 제3자 제공
- 원칙적으로 제공하지 않습니다.
- 법령에 의한 요구가 있는 경우에만 제공됩니다.

5. 개인정보 처리 위탁
- Supabase (인증 및 데이터 저장)
- Google Cloud (Play Store 결제)
- Vercel (API 호스팅)

6. 이용자의 권리
- 개인정보 열람, 수정, 삭제, 처리 정지 요구 가능
- 회원 탈퇴 시 모든 개인정보 즉시 삭제

7. 개인정보 보호 책임자
- 이메일: hyung3549@gmail.com

8. 개정 이력
- 2026년 5월 1일 시행

본 방침은 사전 고지 없이 변경될 수 있으며, 변경 시 앱 내 공지로 안내합니다.
`,
    },
    about: {
      title: '앱 정보',
      content: `
샤프시그널 (Sharp Signal)

버전: 5.4
빌드: 37

⚡ 실시간 스포츠 베팅 라인 모니터
🃏 라이브 바카라 패턴 분석
🔮 파워볼 알고리즘 분석

지원 게임:
- Evolution Speed Baccarat
- Pragmatic Speed Baccarat
- EOS 5분 파워볼
- 동행복권 파워볼
- MLB / KBO / NPB / NBA / NHL
- 주요 축구 리그

문의: hyung3549@gmail.com

© 2026 샤프시그널. All Rights Reserved.

만 19세 미만 이용 금지.
도박은 중독성이 있습니다. 책임감 있게 이용하세요.
도박 중독 문의: 1336 (한국도박문제관리센터)
`,
    },
  }
  const doc = docs[kind] || docs.about

  // 안드로이드 뒤로가기 버튼 → 모달 닫기
  useEffect(() => {
    let listener
    CapApp.addListener('backButton', () => { onClose() }).then(l => { listener = l })
    return () => { listener?.remove() }
  }, [onClose])

  const close = () => { haptic.light(); onClose() }

  return (
    <div className="fixed inset-0 bg-black/70 z-[120] flex flex-col" onClick={close}>
      {/* 상단 헤더 (safe area 포함, 항상 클릭 가능) */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 shadow-sm"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-3 py-3 gap-2">
          <button onClick={close}
            aria-label="뒤로가기"
            className="w-10 h-10 flex items-center justify-center rounded-full active:bg-slate-100 dark:active:bg-slate-800 transition-colors flex-shrink-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-700 dark:text-slate-300">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <h2 className="flex-1 text-center text-base font-bold text-slate-900 dark:text-slate-100">{doc.title}</h2>
          <button onClick={close}
            aria-label="닫기"
            className="w-10 h-10 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 active:scale-95 active:bg-slate-200 dark:active:bg-slate-700 transition-all flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      {/* 본문 */}
      <div className="flex-1 overflow-y-auto bg-white dark:bg-slate-900 px-4 py-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 80px)' }}
        onClick={e => e.stopPropagation()}>
        <pre className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed font-sans">{doc.content.trim()}</pre>
      </div>

      {/* 하단 닫기 버튼 (fail-safe) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 px-4 pt-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
        onClick={e => e.stopPropagation()}>
        <button onClick={close}
          className="w-full py-3 bg-indigo-600 active:bg-indigo-700 text-white font-semibold text-sm rounded-2xl active:scale-[0.98] transition-all">
          닫기
        </button>
      </div>
    </div>
  )
}

// ── 더보기 페이지 ────────────────────────────────────────
function MorePage({ user, sub, isAdmin, daysLeft, onSignIn, onSignOut, onShowMyPage, onShowUpgrade, onShowAdmin, themeMode, setThemeMode }) {
  const [legalKind, setLegalKind] = useState(null)
  const subEnd = sub?.sub_expires_at ? new Date(sub.sub_expires_at) : null
  const subDays = subEnd && subEnd > new Date()
    ? Math.ceil((subEnd - Date.now()) / 86400000) : 0
  const planLabel = isAdmin ? '관리자' : (subDays > 0 ? `구독 D-${subDays}` : (daysLeft > 0 ? `체험 D-${daysLeft}` : '무료'))
  const planColor = isAdmin ? 'text-violet-600 bg-violet-50 dark:text-violet-300 dark:bg-violet-950/50' :
                    subDays > 0 ? 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/50' :
                    daysLeft > 0 ? 'text-indigo-600 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-950/50' :
                    'text-slate-500 bg-slate-100 dark:text-slate-400 dark:bg-slate-800'

  const MenuRow = ({ icon, label, sublabel, badge, onClick, danger }) => (
    <button onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-slate-100 dark:active:bg-slate-800 transition-colors text-left">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0
        ${danger ? 'bg-rose-50 text-rose-500 dark:bg-rose-950/50 dark:text-rose-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold ${danger ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100'}`}>{label}</div>
        {sublabel && <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">{sublabel}</div>}
      </div>
      {badge}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-300 dark:text-slate-600">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  )

  // 다크모드 라벨 + 토글
  const themeLabel = themeMode === 'dark' ? '다크' : themeMode === 'light' ? '라이트' : '시스템'
  const cycleTheme = () => {
    const next = themeMode === 'system' ? 'light' : themeMode === 'light' ? 'dark' : 'system'
    setThemeMode(next)
  }

  return (
    <div className="px-3 py-4 space-y-3 fade-in">
      {/* 프로필 카드 */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm p-4">
        {user ? (
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center flex-shrink-0">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">{user.user_metadata?.name || user.user_metadata?.full_name || user.email || '사용자'}</div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{user.email || '이메일 미등록'}</div>
            </div>
            <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${planColor}`}>
              {planLabel}
            </span>
          </div>
        ) : (
          <button onClick={onSignIn}
            className="w-full py-3 bg-indigo-600 active:bg-indigo-700 text-white text-sm font-semibold rounded-xl">
            로그인 / 가입
          </button>
        )}
      </div>

      {/* 메뉴 리스트 */}
      {user && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden divide-y divide-slate-50 dark:divide-slate-800">
          <MenuRow
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>}
            label="마이페이지"
            sublabel="계정 정보 / 구독 / 정산"
            onClick={onShowMyPage}
          />
          {!isAdmin && (
            <MenuRow
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>}
              label="구독 / 결제"
              sublabel={subDays > 0 ? `${subDays}일 남음` : daysLeft > 0 ? `체험 ${daysLeft}일 남음` : '구독하기'}
              onClick={onShowUpgrade}
            />
          )}
          {isAdmin && (
            <MenuRow
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/></svg>}
              label="관리자 페이지"
              sublabel="유저 / 구독 관리"
              onClick={onShowAdmin}
            />
          )}
        </div>
      )}

      {/* 환경설정 */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
        <button onClick={cycleTheme}
          className="w-full flex items-center gap-3 px-4 py-3.5 active:bg-slate-100 dark:active:bg-slate-800 transition-colors text-left">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {themeMode === 'dark' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            ) : themeMode === 'light' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">테마</div>
            <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">탭해서 변경 (라이트 / 다크 / 시스템)</div>
          </div>
          <span className="text-[11px] font-semibold text-indigo-600 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-950/50 px-2.5 py-1 rounded-full whitespace-nowrap">
            {themeLabel}
          </span>
        </button>
      </div>

      {/* 정보 카드 */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden divide-y divide-slate-50 dark:divide-slate-800">
        <MenuRow
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>}
          label="앱 정보"
          sublabel="v5.4 · 샤프시그널"
          onClick={() => setLegalKind('about')}
        />
        <MenuRow
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 0 0-6 0v4M5 9h14l1 12H4z"/></svg>}
          label="이용 약관"
          onClick={() => setLegalKind('terms')}
        />
        <MenuRow
          icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>}
          label="개인정보 처리방침"
          onClick={() => setLegalKind('privacy')}
        />
      </div>

      {legalKind && <LegalModal kind={legalKind} onClose={() => setLegalKind(null)} />}

      {/* 로그아웃 */}
      {user && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
          <MenuRow
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>}
            label="로그아웃"
            onClick={onSignOut}
            danger
          />
        </div>
      )}
    </div>
  )
}

// ── 로그인 선택 모달 ─────────────────────────────────────
function LoginModal({ onClose, onPick, loading }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full max-w-sm bg-white rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="text-center mb-5">
          <h2 className="text-lg font-bold text-slate-900">로그인</h2>
          <p className="text-xs text-slate-400 mt-1">간편 로그인으로 시작하세요</p>
        </div>
        <div className="space-y-3">
          <button
            onClick={() => onPick('kakao')}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-[#FEE500] hover:brightness-95 active:brightness-90 rounded-2xl text-sm font-semibold text-[#3A1D1D] transition-all disabled:opacity-50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#3A1D1D">
              <path d="M12 3C6.48 3 2 6.48 2 10.8c0 2.78 1.86 5.22 4.68 6.6L5.52 21l4.32-2.4c.69.12 1.41.18 2.16.18 5.52 0 10-3.48 10-7.8C22 6.48 17.52 3 12 3z"/>
            </svg>
            카카오로 시작하기
          </button>
          <button
            onClick={() => onPick('google')}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-white border-2 border-slate-200 rounded-2xl text-sm font-semibold text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition-colors disabled:opacity-50">
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            구글로 시작하기
          </button>
        </div>
        <button onClick={onClose}
          className="w-full mt-4 py-3 text-sm text-slate-400 hover:text-slate-600 transition-colors">
          취소
        </button>
      </div>
    </div>
  )
}

// ── 로그인 화면 (Dead code - 모달로 대체됨) ────────────
function AuthScreen() {
  const [loading, setLoading]     = useState(false)
  const [loadingKakao, setLoadingKakao] = useState(false)
  const [error, setError]         = useState('')

  async function signInWithProvider(provider) {
    const setLoad = provider === 'kakao' ? setLoadingKakao : setLoading
    setLoad(true)
    setError('')
    const isNative = Capacitor.isNativePlatform()
    const redirectTo = isNative
      ? 'https://pinnacle-bot.vercel.app'
      : `${window.location.origin}`

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: isNative },
    })
    if (error) { setError(error.message); setLoad(false); return }
    if (isNative && data?.url) {
      await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
    }
    setLoad(false)
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">샤프시그널</h1>
          <p className="text-slate-400 text-sm mt-2">실시간 라인 모니터</p>
        </div>
        <div className="bg-white rounded-3xl p-6 shadow-sm border border-slate-100 space-y-3">
          {/* 카카오 로그인 (메인) */}
          <button
            onClick={() => signInWithProvider('kakao')}
            disabled={loadingKakao || loading}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-[#FEE500] hover:brightness-95 active:brightness-90 rounded-2xl text-sm font-semibold text-[#3A1D1D] transition-all disabled:opacity-50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#3A1D1D">
              <path d="M12 3C6.48 3 2 6.48 2 10.8c0 2.78 1.86 5.22 4.68 6.6L5.52 21l4.32-2.4c.69.12 1.41.18 2.16.18 5.52 0 10-3.48 10-7.8C22 6.48 17.52 3 12 3z"/>
            </svg>
            {loadingKakao ? '로그인 중...' : '카카오로 시작하기'}
          </button>

          {/* 구글 로그인 */}
          <button
            onClick={() => signInWithProvider('google')}
            disabled={loading || loadingKakao}
            className="w-full flex items-center justify-center gap-3 py-3.5 bg-white border-2 border-slate-200 rounded-2xl text-sm font-semibold text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition-colors disabled:opacity-50">
            <svg width="20" height="20" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
            {loading ? '로그인 중...' : '구글로 시작하기'}
          </button>

          {error && <p className="text-xs text-rose-500 text-center pt-2">{error}</p>}
        </div>
      </div>
    </div>
  )
}

// ── 잠금 박스 ────────────────────────────────────────────────
function LockBox({ onUnlock, label, isGuest = false }) {
  const defaultLabel = isGuest ? '로그인 후 이용 가능합니다' : '구독 후 이용 가능합니다'
  // 게스트면 "구독 후" → "로그인 후" 자동 치환
  const displayLabel = isGuest && label
    ? label.replace(/구독 ?후/g, '로그인 후')
    : (label ?? defaultLabel)
  const btnLabel = isGuest ? '로그인' : '잠금 해제'
  return (
    <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 flex flex-col items-center gap-2">
      <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" className="text-slate-500">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div className="text-xs text-slate-500 text-center">{displayLabel}</div>
      <button onClick={onUnlock}
        className="text-xs font-semibold text-indigo-600 bg-white border border-indigo-200 px-4 py-1.5 rounded-full">
        {btnLabel}
      </button>
    </div>
  )
}

// ── 업그레이드 모달 (바텀시트) ────────────────────────────────
function UpgradeModal({ onClose }) {
  function openKakao() {
    window.open('https://open.kakao.com/o/s4nnW1ti', '_system')
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" onClick={onClose}>
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      <div className="relative bg-white rounded-t-3xl px-4 pt-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-4" />
        <button onClick={onClose}
          className="absolute right-4 top-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>

        <h2 className="text-lg font-bold text-slate-900 mb-4">구독 문의</h2>

        <button onClick={openKakao}
          className="w-full flex items-center justify-center gap-2 py-4 bg-yellow-400 text-slate-900 text-base font-bold rounded-xl active:bg-yellow-500 transition-colors">
          <span>💬</span>
          카카오톡 오픈채팅 문의
        </button>
      </div>
    </div>
  )
}

// ── 픽 저장 모달 ─────────────────────────────────────────────
function PickSaveModal({ data, onClose }) {
  const { game, market, pick, pickLabel, odds } = data
  const PRESETS = [10000, 30000, 50000, 100000]
  const [amount, setAmount] = useState(10000)
  const [custom, setCustom] = useState('')

  const finalAmount = custom ? parseInt(custom.replace(/[^0-9]/g, '') || '0') : amount
  const expectedProfit = finalAmount && odds ? Math.round(finalAmount * (odds - 1)) : 0
  const fmt = n => n.toLocaleString('ko-KR')

  function save() {
    if (!finalAmount || finalAmount <= 0) {
      toast.warn('금액을 입력해주세요')
      return
    }
    const newPick = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      matchup_id: game.matchup_id,
      sport: game.sport, league: game.league,
      home: game.home, away: game.away,
      game_date: game.protoBetting?.game_date || (game.starts_at || '').slice(0, 10),
      starts_at: game.starts_at,
      market, pick, pick_label: pickLabel,
      odds, amount: finalAmount,
      status: 'pending',
      created_at: new Date().toISOString(),
    }
    addPick(newPick)
    toast.success('내 픽으로 저장됨')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end" onClick={onClose}>
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm absolute inset-0" />
      <div className="relative w-full bg-white dark:bg-slate-900 rounded-t-3xl px-4 pt-4 fade-in"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
        onClick={e => e.stopPropagation()}>
        <div className="w-10 h-1 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-4" />

        <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">{game.home} vs {game.away}</div>
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{pickLabel}</span>
          <span className="text-xl font-bold text-indigo-600 dark:text-indigo-400">@ {odds?.toFixed(2)}</span>
        </div>

        <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">베팅 금액</div>
        <div className="grid grid-cols-4 gap-2 mb-3">
          {PRESETS.map(p => (
            <button key={p}
              onClick={() => { setAmount(p); setCustom('') }}
              className={`py-2.5 rounded-xl text-sm font-bold transition-all ${
                !custom && amount === p
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}>
              {p >= 10000 ? `${p / 10000}만` : fmt(p)}
            </button>
          ))}
        </div>
        <input type="text" inputMode="numeric" placeholder="직접 입력 (원)"
          value={custom}
          onChange={e => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
          className="w-full px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100 mb-3" />

        <div className="bg-indigo-50 dark:bg-indigo-950/30 rounded-xl px-3 py-2.5 mb-4 flex justify-between items-center">
          <span className="text-xs text-slate-600 dark:text-slate-400">적중시 예상 수익</span>
          <span className="text-base font-bold text-indigo-700 dark:text-indigo-400">+{fmt(expectedProfit)}원</span>
        </div>

        <div className="flex gap-2">
          <button onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold">
            취소
          </button>
          <button onClick={save}
            className="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-bold active:bg-indigo-700">
            저장
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 픽 선택 버튼 (AddPickFlow 전용, 큼직하고 명확) ──────────────
function PickButton({ label, odds, onClick }) {
  return (
    <button onClick={onClick}
      className="flex-1 min-w-0 flex flex-col items-center justify-center py-2.5 px-1 rounded-xl border-2 border-indigo-300 dark:border-indigo-700 bg-indigo-50 dark:bg-indigo-950/30 active:scale-95 active:bg-indigo-100 dark:active:bg-indigo-900/50 transition-all">
      <span className="text-[11px] font-medium text-indigo-600 dark:text-indigo-400 mb-0.5 whitespace-nowrap">{label}</span>
      <span className="text-base font-bold text-indigo-900 dark:text-indigo-100 leading-tight">{odds?.toFixed(2) ?? '-'}</span>
      <span className="text-[9px] text-indigo-500 dark:text-indigo-400 mt-0.5 font-bold">+ 추가</span>
    </button>
  )
}

// ── 픽 추가 플로우 (전체화면 모달, 베팅 슬립 다폴더 지원) ─────────
function AddPickFlow({ betmanDirect, games, onClose }) {
  const [search, setSearch] = useState('')
  const [sportFilter, setSportFilter] = useState('all')
  const [expanded, setExpanded] = useState({})  // { matchup_id: true } 핸디/언오버 확장
  const [slip, setSlip] = useState([])  // 베팅 슬립 (다폴더)
  const [slipOpen, setSlipOpen] = useState(false)
  const [amount, setAmount] = useState(10000)
  const [customAmount, setCustomAmount] = useState('')
  const PRESETS = [10000, 30000, 50000, 100000]
  const fmt = n => (n || 0).toLocaleString('ko-KR')

  const fmtTime = (sa) => {
    if (!sa) return ''
    // starts_at은 "05/15 01:35 KST" 형식 — 정규식으로 직접 추출
    const m = String(sa).match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
    if (!m) return ''
    return `${new Date().getFullYear()}-${m[1]}-${m[2]} ${m[3]}:${m[4]}`
  }
  const SPORT_ICONS = { soccer: '⚽', baseball: '⚾', basketball: '🏀', hockey: '🏒' }
  // 소스: 피나클(games) 전체 — 베트맨 회차 닫혀도 24/7 작동
  // games(1000개) 필터/정렬을 useMemo로 캐싱 (매 렌더 재계산 방지)
  const eligible = useMemo(() => {
    const hasPinnacleOdds = g =>
      g.ml_home != null || g.ml_away != null ||
      g.sp_home != null || g.sp_away != null ||
      g.ou_over != null || g.ou_under != null
    const combinedMap = new Map()
    for (const g of (games || [])) {
      if (!hasPinnacleOdds(g)) continue
      if (g._betmanOnly) continue
      const gd = (g.starts_at || '').slice(0, 10)
      const key = `${g.sport}|${g.home}|${g.away}|${gd}`
      if (combinedMap.has(key)) continue
      combinedMap.set(key, g)
    }
    return Array.from(combinedMap.values())
      .filter(g => !isInPast(g.starts_at))
      .sort((a, b) => parseStartsTs(a.starts_at) - parseStartsTs(b.starts_at))
  }, [games])

  // 스포츠/검색 필터 — useMemo 캐싱
  const sportFiltered = useMemo(() =>
    sportFilter === 'all' ? eligible : eligible.filter(g => g.sport === sportFilter)
  , [eligible, sportFilter])

  const filtered = useMemo(() => {
    if (!search) return sportFiltered
    const q = search.toLowerCase()
    return sportFiltered.filter(g =>
      (g.home || '').toLowerCase().includes(q) ||
      (g.away || '').toLowerCase().includes(q) ||
      (g.league || '').toLowerCase().includes(q)
    )
  }, [sportFiltered, search])

  // 스포츠별 카운트 (필터 칩)
  const sportCounts = useMemo(() => eligible.reduce((acc, g) => {
    acc[g.sport] = (acc[g.sport] || 0) + 1
    return acc
  }, {}), [eligible])

  const slipKey = (matchupId, market) => `${matchupId}|${market}`
  const isInSlip = (matchupId, market, pick) =>
    slip.some(s => s.matchup_id === matchupId && s.market === market && s.pick === pick)

  const togglePick = (game, market, pick, pickLabel, odds) => {
    if (odds == null) return
    haptic.light()
    setSlip(prev => {
      // 같은 경기-마켓의 다른 픽이 있으면 교체 (예: 홈 → 원정)
      const sameSlot = prev.find(s => s.matchup_id === game.matchup_id && s.market === market)
      if (sameSlot && sameSlot.pick === pick) {
        // 같은 픽 다시 탭 → 제거
        return prev.filter(s => !(s.matchup_id === game.matchup_id && s.market === market))
      }
      const cleaned = prev.filter(s => !(s.matchup_id === game.matchup_id && s.market === market))
      // game_date 안전 추출: protoBetting 있으면 그대로, 없으면 starts_at "MM/DD HH:MM KST"에서 추출
      let gd = game.protoBetting?.game_date
      if (!gd && game.starts_at) {
        const m = String(game.starts_at).match(/(\d{2})\/(\d{2})/)
        if (m) gd = `${new Date().getFullYear()}-${m[1]}-${m[2]}`
      }
      cleaned.push({
        matchup_id: game.matchup_id,
        sport: game.sport, league: game.league,
        home: game.home, away: game.away,
        game_date: gd || '',
        starts_at: game.starts_at,
        market, pick, pick_label: pickLabel, odds,
      })
      return cleaned
    })
  }
  const removeFromSlip = (idx) => setSlip(s => s.filter((_, i) => i !== idx))

  const combinedOdds = slip.reduce((acc, s) => acc * s.odds, 1)
  const finalAmount = customAmount ? parseInt(customAmount.replace(/[^0-9]/g, '') || '0') : amount
  const expectedPayout = Math.round(finalAmount * combinedOdds)
  const expectedProfit = expectedPayout - finalAmount

  const saveTicket = async () => {
    if (slip.length === 0) { toast.warn('픽을 추가해주세요'); return }
    if (!finalAmount || finalAmount <= 0) { toast.warn('금액을 입력해주세요'); return }
    let token
    try {
      const { data: { session } } = await supabase.auth.getSession()
      token = session?.access_token
    } catch (e) {
      console.error('[saveTicket session]', e)
      toast.warn(`세션 오류: ${e?.message || e}`)
      return
    }
    if (!token) { toast.warn('로그인이 필요합니다'); return }
    const ticket = {
      type: slip.length > 1 ? 'combo' : 'single',
      legs: slip.map(s => ({ ...s, leg_status: 'pending' })),
      combined_odds: combinedOdds,
      amount: finalAmount,
    }
    try {
      const res = await fetch('https://sharpsignal.cloud/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(ticket),
      })
      if (!res.ok) {
        let msg = `저장 실패 (${res.status})`
        try { msg = (await res.json()).error || msg } catch (_) {}
        toast.warn(msg)
        return
      }
      // 서버가 저장한 픽 객체 그대로 받아서 즉시 리스트에 push (race-free)
      let savedPick = null
      try { savedPick = await res.json() } catch (_) {}
      if (savedPick) triggerProjectAppend(savedPick)
      triggerProjectRefresh()  // 안전망: 다음 polling 즉시 강제
      toast.success(slip.length > 1 ? `${slip.length}폴더 저장됨` : '픽 저장됨')
      setSlip([])
      setCustomAmount('')
      setSlipOpen(false)
      onClose()
    } catch (e) {
      console.error('[saveTicket fetch]', e)
      toast.warn(`네트워크 오류: ${e?.message || String(e).slice(0, 80)}`)
    }
  }

  return (
    <div className="fixed inset-0 z-[55] bg-slate-50 dark:bg-slate-950 flex flex-col fade-in">
      {/* 컴팩트 헤더 (검색 통합) */}
      <div className="px-3 pt-2 pb-1.5 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 8px)' }}>
        <div className="flex items-center gap-2 mb-2">
          <button onClick={onClose}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6"/>
            </svg>
          </button>
          <input
            type="text" placeholder="팀명/리그 검색"
            value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400" />
        </div>
        {/* 스포츠 필터 칩 */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          <button onClick={() => setSportFilter('all')}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold transition-all
              ${sportFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
            전체 {eligible.length}
          </button>
          {Object.entries(sportCounts).map(([sp, cnt]) => (
            <button key={sp} onClick={() => setSportFilter(sp)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-bold transition-all
                ${sportFilter === sp ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
              {SPORT_ICONS[sp] || '🎯'} {cnt}
            </button>
          ))}
        </div>
      </div>

      {/* 경기 리스트 */}
      <div className="flex-1 overflow-y-auto px-3 py-2"
        style={{ paddingBottom: slip.length > 0 ? '160px' : 'calc(env(safe-area-inset-bottom) + 24px)' }}>
        {filtered.length === 0 ? (
          <div className="text-center text-slate-400 dark:text-slate-500 py-12 px-4 text-sm">
            {eligible.length === 0 ? (
              <>
                <div className="text-3xl mb-2">⏳</div>
                <div className="font-semibold mb-1">예정 경기가 없어요</div>
                <div className="text-xs">잠시 후 다시 시도해주세요</div>
              </>
            ) : '검색 결과 없음'}
          </div>
        ) : (
          filtered.map(g => {
            const mid = g.matchup_id
            const timeStr = fmtTime(g.starts_at)
            const checkSelected = (market, pick) => isInSlip(mid, market, pick)
            return (
              <div key={mid} className="mb-3 p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm">
                {/* 헤더 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px]">{SPORT_ICONS[g.sport] || '🎯'}</span>
                  <span className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400">{g.league}</span>
                  {timeStr && (
                    <span className="ml-auto text-[12px] font-bold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                      📅 {timeStr}
                    </span>
                  )}
                </div>
                {/* 팀명 */}
                <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-0">
                  <span className="text-slate-900 dark:text-slate-100 font-bold text-base break-keep">{g.home}</span>
                  <span className="text-slate-300 dark:text-slate-600 text-xs font-normal">vs</span>
                  <span className="text-slate-900 dark:text-slate-100 font-bold text-base break-keep">{g.away}</span>
                </div>
                {/* 피나클 픽 박스 */}
                <PinnaclePickBox game={g} onPickTap={togglePick} isSelected={checkSelected} />
              </div>
            )
          })
        )}
      </div>

      {/* 베팅 슬립 (Fixed bottom sheet) */}
      {slip.length > 0 && (
        <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[520px] z-[58]">
          {!slipOpen ? (
            <button onClick={() => setSlipOpen(true)}
              className="w-full bg-indigo-600 text-white px-4 py-3 flex items-center justify-between active:bg-indigo-700"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}>
              <span className="font-bold text-sm">📋 베팅 슬립 ({slip.length}폴더)</span>
              <span className="text-xs font-semibold">합산 {combinedOdds.toFixed(2)}배 ▲</span>
            </button>
          ) : (
            <div className="bg-white dark:bg-slate-900 rounded-t-3xl border-t-2 border-indigo-600 shadow-2xl">
              <div className="px-4 py-2.5 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">📋 베팅 슬립 ({slip.length}폴더)</span>
                <button onClick={() => setSlipOpen(false)} className="text-slate-400 text-xs">▼ 접기</button>
              </div>
              <div className="max-h-[35vh] overflow-y-auto px-4 py-1">
                {slip.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 py-2 border-b border-slate-50 dark:border-slate-800 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-slate-400 truncate">{s.home} vs {s.away}</div>
                      <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        {s.pick_label} <span className="text-indigo-600 dark:text-indigo-400">@ {s.odds?.toFixed(2)}</span>
                      </div>
                    </div>
                    <button onClick={() => removeFromSlip(i)} className="text-rose-400 text-xs px-2 py-1 active:bg-rose-50 rounded">✕</button>
                  </div>
                ))}
              </div>
              <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">베팅 금액</div>
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {PRESETS.map(p => (
                    <button key={p} onClick={() => { setAmount(p); setCustomAmount('') }}
                      className={`py-2 rounded-lg text-xs font-bold transition-all ${
                        !customAmount && amount === p
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}>
                      {p / 10000}만
                    </button>
                  ))}
                </div>
                <input type="text" inputMode="numeric" placeholder="직접 입력 (원)"
                  value={customAmount} onChange={e => setCustomAmount(e.target.value.replace(/[^0-9]/g, ''))}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 mb-2" />
                <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mb-1">
                  <span>합산 배당</span>
                  <span className="font-bold text-indigo-600 dark:text-indigo-400">{combinedOdds.toFixed(2)}배</span>
                </div>
                <div className="flex justify-between text-sm mb-3">
                  <span className="text-slate-700 dark:text-slate-300">예상 수익</span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400">+{fmt(expectedProfit)}원</span>
                </div>
                <button onClick={saveTicket}
                  className="w-full py-3 rounded-xl bg-indigo-600 text-white font-bold active:bg-indigo-700">
                  {slip.length > 1 ? `${slip.length}폴더 저장` : '픽 저장'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 토글 버튼 — 컴팩트 (한 줄, 라벨+배당 옆으로)
function PickToggleBtn({ label, odds, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex-1 min-w-0 flex items-center justify-between gap-1 py-1.5 px-2 rounded-lg border transition-all active:scale-95
        ${active
          ? 'border-indigo-600 bg-indigo-600 text-white'
          : 'border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/20 text-indigo-900 dark:text-indigo-100'}`}>
      <span className={`text-[10px] font-medium truncate ${active ? 'text-indigo-100' : 'text-indigo-600 dark:text-indigo-400'}`}>{label}</span>
      <span className="text-xs font-bold leading-tight">{odds?.toFixed(2) ?? '-'}</span>
    </button>
  )
}

// ── 프로젝트 (관리자 픽 보드 · 서버 공유) ──────────────────────
const PROJECT_API = 'https://sharpsignal.cloud/api/picks'

function MyPicks({ user, hasAccess, isAdmin }) {
  const [picks, setPicks] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all') // all|pending|won|lost
  const [monthTab, setMonthTab] = useState('all') // 'all' | 'YYYY-MM'
  const [dayTab, setDayTab] = useState('all')     // 'all' | 'YYYY-MM-DD'

  const refresh = async () => {
    try {
      const res = await fetch(PROJECT_API, { cache: 'no-store' })
      const json = await res.json()
      setPicks(Array.isArray(json) ? json : [])
    } catch (e) {
      console.error('[picks fetch]', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 60000)
    const unreg = _registerProjectRefresh(refresh)
    const unreg2 = _registerProjectAppend(newPick => {
      setPicks(prev => {
        // 중복 방지 (같은 id)
        if (prev.some(p => p.id === newPick.id)) return prev
        return [newPick, ...prev]
      })
    })
    return () => { clearInterval(iv); unreg(); unreg2() }
  }, [])

  const fmt = n => (n || 0).toLocaleString('ko-KR')
  const allNormalized = picks.map(normalizePick)
  // 게스트/미구독은 settled(won/lost)만 표시
  const visible = (hasAccess || isAdmin) ? allNormalized : allNormalized.filter(p => p.status === 'won' || p.status === 'lost')

  // 월별 그룹핑 (created_at 기준)
  const monthsSet = new Set()
  for (const p of visible) {
    const t = p.created_at || p.raw?.created_at
    if (t && t.length >= 7) monthsSet.add(t.slice(0, 7))
  }
  const months = Array.from(monthsSet).sort().reverse()

  // 월 필터
  const visibleMonth = monthTab === 'all' ? visible : visible.filter(p => {
    const t = p.created_at || p.raw?.created_at
    return t && t.startsWith(monthTab)
  })

  // 일자 추출 (현재 월 내 픽이 있는 일자들)
  const daysSet = new Set()
  for (const p of visibleMonth) {
    const t = p.created_at || p.raw?.created_at
    if (t && t.length >= 10) daysSet.add(t.slice(0, 10))
  }
  const days = Array.from(daysSet).sort().reverse()

  // 일자 필터 (월 선택된 경우에만 의미 있음)
  const visibleDay = dayTab === 'all' ? visibleMonth : visibleMonth.filter(p => {
    const t = p.created_at || p.raw?.created_at
    return t && t.startsWith(dayTab)
  })

  // 상태 탭 필터
  const filtered = tab === 'all' ? visibleDay : visibleDay.filter(p => p.status === tab)

  // 통계 (월+일 필터 적용)
  const settled = visibleDay.filter(p => p.status === 'won' || p.status === 'lost')
  const wins = settled.filter(p => p.status === 'won').length
  const total = settled.length
  const hitRate = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0
  const totalBet = settled.reduce((s, p) => s + (p.amount || 0), 0)
  const totalPL = settled.reduce((s, p) => {
    if (p.status === 'won') return s + Math.round(p.amount * (p.odds - 1))
    if (p.status === 'lost') return s - p.amount
    return s
  }, 0)
  const roi = totalBet > 0 ? Math.round((totalPL / totalBet) * 1000) / 10 : 0
  const avgOdds = settled.length > 0
    ? (settled.reduce((s, p) => s + (p.odds || 0), 0) / settled.length).toFixed(2)
    : '-'

  // 관리자 settle
  const handleSettle = async (pickId, newStatus) => {
    if (!isAdmin) return
    if (!window.confirm(`이 픽을 ${newStatus === 'won' ? '적중' : '미적중'}으로 처리할까요?`)) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`${PROJECT_API}/${pickId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ status: newStatus, settled_at: new Date().toISOString() }),
      })
      if (res.ok) { toast.success('처리 완료'); refresh() }
      else toast.warn('실패: 권한 또는 네트워크 오류')
    } catch (e) { console.error(e); toast.warn('네트워크 오류') }
  }

  const handleDelete = async (pickId) => {
    if (!isAdmin) return
    if (!window.confirm('이 픽을 삭제할까요?')) return
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      const res = await fetch(`${PROJECT_API}/${pickId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (res.ok) { toast.success('삭제됨'); refresh() }
      else toast.warn('삭제 실패')
    } catch (e) { console.error(e) }
  }

  if (loading && picks.length === 0) return <SkeletonList count={3} />

  if (visible.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-slate-100 dark:border-slate-800 shadow-sm text-center">
        <span className="text-3xl block mb-2">📌</span>
        <span className="text-base font-bold text-slate-900 dark:text-slate-100 block mb-2">
          {(isAdmin || hasAccess) ? '아직 등록된 픽이 없어요' : '아직 결과가 없어요'}
        </span>
        {isAdmin && (
          <button onClick={openAddPickFlow}
            className="mt-3 w-full py-3 rounded-xl bg-indigo-600 text-white text-sm font-bold active:bg-indigo-700">
            + 추가하기
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-50 dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-950/50 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-600 dark:text-indigo-400">
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2v16z"/>
            </svg>
          </div>
          <div>
            <div className="text-[17px] font-extrabold text-slate-900 dark:text-slate-100">프로젝트</div>
            <div className="text-[11px] text-slate-400">총 {visible.length}건</div>
          </div>
        </div>
        {isAdmin && (
          <button onClick={openAddPickFlow}
            className="px-4 py-2 rounded-full bg-indigo-600 text-white text-[13px] font-bold active:bg-indigo-700 shadow-sm">
            + 추가
          </button>
        )}
      </div>

      {/* 월 가로 스크롤 탭 */}
      {months.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-50 dark:border-slate-800 flex gap-1.5 overflow-x-auto scrollbar-hide">
          <button onClick={() => { setMonthTab('all'); setDayTab('all') }}
            className={`shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-all
              ${monthTab === 'all' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
            전체
          </button>
          {months.map(m => {
            const [y, mo] = m.split('-')
            return (
              <button key={m} onClick={() => { setMonthTab(m); setDayTab('all') }}
                className={`shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-all
                  ${monthTab === m ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
                {y}.{parseInt(mo)}월
              </button>
            )
          })}
        </div>
      )}

      {/* 일자 가로 스크롤 칩 (월 선택된 경우만) */}
      {monthTab !== 'all' && days.length > 0 && (
        <div className="px-3 py-2 border-b border-slate-50 dark:border-slate-800 flex gap-1.5 overflow-x-auto scrollbar-hide">
          <button onClick={() => setDayTab('all')}
            className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold transition-all
              ${dayTab === 'all' ? 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
            월 전체
          </button>
          {days.map(d => {
            const [, mo, day] = d.split('-')
            return (
              <button key={d} onClick={() => setDayTab(d)}
                className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-semibold transition-all
                  ${dayTab === d ? 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
                {parseInt(mo)}/{parseInt(day)}
              </button>
            )
          })}
        </div>
      )}

      {/* 통계 카드 */}
      {total > 0 && (
        <div className="px-4 py-4 border-b border-slate-50 dark:border-slate-800 grid grid-cols-4 gap-2">
          <div className="text-center">
            <div className={`text-[20px] font-extrabold leading-none ${hitRate >= 50 ? 'text-emerald-600' : 'text-rose-500'}`}>{hitRate}%</div>
            <div className="text-[11px] font-semibold text-slate-400 mt-1.5">적중률</div>
          </div>
          <div className="text-center">
            <div className="text-[20px] font-extrabold leading-none text-slate-900 dark:text-slate-100">{avgOdds}</div>
            <div className="text-[11px] font-semibold text-slate-400 mt-1.5">평균배당</div>
          </div>
          <div className="text-center">
            <div className={`text-[20px] font-extrabold leading-none ${roi >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{roi > 0 ? '+' : ''}{roi}%</div>
            <div className="text-[11px] font-semibold text-slate-400 mt-1.5">ROI</div>
          </div>
          <div className="text-center">
            <div className={`text-[18px] font-extrabold leading-none ${totalPL >= 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{totalPL >= 0 ? '+' : ''}{fmt(totalPL)}</div>
            <div className="text-[11px] font-semibold text-slate-400 mt-1.5">수익</div>
          </div>
        </div>
      )}

      {/* 상태 탭 (관리자/구독자만) */}
      {(isAdmin || hasAccess) && (
        <div className="px-3 py-2 border-b border-slate-50 dark:border-slate-800 flex gap-1.5">
          {['all', 'pending', 'won', 'lost'].map(s => {
            const labels = { all: '전체', pending: '대기', won: '적중', lost: '미적' }
            return (
              <button key={s} onClick={() => setTab(s)}
                className={`flex-1 px-2 py-1 rounded-full text-xs font-semibold transition-all
                  ${tab === s ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                {labels[s]}
              </button>
            )
          })}
        </div>
      )}

      {/* 픽 리스트 */}
      <div className="divide-y divide-slate-50 dark:divide-slate-800">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400">이 필터에 해당하는 픽이 없습니다</div>
        ) : filtered.map((p, i) => (
          <div key={p.raw?.id || i} className="px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full
                  ${p.status === 'won' ? 'bg-emerald-100 text-emerald-700' :
                    p.status === 'lost' ? 'bg-rose-100 text-rose-700' :
                    'bg-slate-100 text-slate-600'}`}>
                  {p.status === 'won' ? '✅ 적중' : p.status === 'lost' ? '❌ 미적' : '⏳ 대기'}
                </span>
                {p.isCombo && <span className="text-[10px] text-violet-600 font-bold">📋 {p.legs.length}폴더</span>}
              </div>
              <span className="text-xs text-slate-400">@{(p.odds || 0).toFixed(2)} · {fmt(p.amount)}원</span>
            </div>
            {p.legs.map((leg, li) => {
              const time = leg.starts_at?.match(/(\d{2}):(\d{2})/)?.[0] || ''
              const dt = leg.game_date && time ? `${leg.game_date} ${time}` : (leg.starts_at || '')
              return (
                <div key={li} className="mb-2 last:mb-0">
                  <div className="text-[10px] text-slate-400 mb-0.5">{leg.league}</div>
                  <div className="text-[15px] font-extrabold text-slate-900 dark:text-slate-100 leading-tight break-keep">
                    {leg.home} <span className="text-slate-400 font-normal mx-1">vs</span> {leg.away}
                    {leg.leg_status === 'won' && <span className="ml-1 text-emerald-500">✓</span>}
                    {leg.leg_status === 'lost' && <span className="ml-1 text-rose-500">✗</span>}
                  </div>
                  <div className="text-xs mt-1">
                    <span className="text-indigo-600 dark:text-indigo-400 font-bold">{leg.pick_label}</span>
                    <span className="ml-1 text-slate-500 dark:text-slate-400">@{leg.odds?.toFixed(2)}</span>
                  </div>
                  {dt && (
                    <div className="text-[13px] font-semibold text-slate-700 dark:text-slate-300 mt-1 inline-flex items-center gap-1 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                      <span>📅</span><span>{dt}</span>
                    </div>
                  )}
                </div>
              )
            })}
            {isAdmin && p.status === 'pending' && (
              <div className="flex gap-1.5 mt-2">
                <button onClick={() => handleSettle(p.raw.id, 'won')}
                  className="flex-1 py-1.5 rounded-lg bg-emerald-100 text-emerald-700 text-xs font-bold active:bg-emerald-200">
                  ✅ 적중
                </button>
                <button onClick={() => handleSettle(p.raw.id, 'lost')}
                  className="flex-1 py-1.5 rounded-lg bg-rose-100 text-rose-700 text-xs font-bold active:bg-rose-200">
                  ❌ 미적
                </button>
                <button onClick={() => handleDelete(p.raw.id)}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold active:bg-slate-200">
                  🗑
                </button>
              </div>
            )}
            {isAdmin && (p.status === 'won' || p.status === 'lost') && (
              <div className="flex justify-end mt-2">
                <button onClick={() => handleDelete(p.raw.id)}
                  className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold active:bg-slate-200">
                  🗑 삭제
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 마이페이지 ─────────────────────────────────────────────────
const NOTICES_API = 'https://sharpsignal.cloud/api/notices'

function MyPage({ user, sub, onSignOut, onShowUpgrade, onClose }) {
  const [notices, setNotices]   = useState([])
  const [loadingN, setLoadingN] = useState(true)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    fetch(NOTICES_API)
      .then(r => r.json())
      .then(d => { setNotices(Array.isArray(d) ? d : []); setLoadingN(false) })
      .catch(() => setLoadingN(false))
  }, [])

  const isAdmin = user?.email === ADMIN_EMAIL

  const now     = new Date()
  const subEnd  = sub?.sub_expires_at  ? new Date(sub.sub_expires_at)  : null
  const trialEnd = sub?.trial_started_at
    ? new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000) : null
  const subDays   = subEnd  && subEnd  > now ? Math.ceil((subEnd  - now) / 86400000) : 0
  const trialDays = trialEnd && trialEnd > now ? Math.ceil((trialEnd - now) / 86400000) : 0

  const planLabel = isAdmin ? '관리자' : (sub?.plan || (trialDays > 0 ? '무료 체험' : null))
  const isActive  = isAdmin || subDays > 0 || trialDays > 0
  const daysLeft  = isAdmin ? null : (subDays || trialDays)
  const expiryDate = isAdmin ? null : (
    subEnd && subEnd > now
      ? subEnd.toLocaleDateString('ko-KR')
      : trialEnd && trialEnd > now
      ? trialEnd.toLocaleDateString('ko-KR')
      : null
  )

  function fmtDate(d) {
    return d ? new Date(d).toLocaleDateString('ko-KR') : '-'
  }

  function openKakao() {
    window.open('https://open.kakao.com/o/s4nnW1ti', '_system')
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col max-w-[520px] mx-auto">
      {/* 헤더 */}
      <div className="bg-white border-b border-slate-100 px-4 pb-3 flex items-center justify-between"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <h2 className="text-lg font-bold text-slate-900">마이페이지</h2>
        <button onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>

      {/* 컨텐츠 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}>

        {/* 구독 현황 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold text-slate-900">구독 현황</span>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isActive ? 'text-emerald-600 bg-emerald-50' : 'text-rose-500 bg-rose-50'
            }`}>
              {isActive ? '이용중' : '만료됨'}
            </span>
          </div>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs text-slate-400">현재 플랜</span>
              <span className="text-sm font-semibold text-slate-800">{planLabel || '없음'}</span>
            </div>
            {expiryDate && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">만료일</span>
                <span className="text-sm font-semibold text-slate-800">{expiryDate}</span>
              </div>
            )}
            {daysLeft > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400">남은 일수</span>
                <span className={`text-sm font-bold ${daysLeft <= 3 ? 'text-rose-500' : 'text-emerald-600'}`}>
                  {daysLeft}일
                </span>
              </div>
            )}
          </div>
          {!isAdmin && (
            <button onClick={onShowUpgrade}
              className="mt-3 w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl active:bg-indigo-700 transition-colors">
              {isActive ? '구독 연장' : '구독하기'}
            </button>
          )}
        </div>

        {/* 계정 정보 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <span className="text-sm font-bold text-slate-900 block mb-3">계정 정보</span>
          <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400">이메일</span>
            <span className="text-sm text-slate-700 font-medium">{user?.email || '-'}</span>
          </div>
          {sub?.created_at && (
            <div className="flex justify-between items-center mt-2">
              <span className="text-xs text-slate-400">가입일</span>
              <span className="text-sm text-slate-700">{fmtDate(sub.created_at)}</span>
            </div>
          )}
        </div>

        {/* 공지사항 */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-50">
            <span className="text-sm font-bold text-slate-900">공지사항</span>
          </div>
          {loadingN ? (
            <div className="text-center py-6 text-slate-400 text-sm">불러오는 중...</div>
          ) : notices.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">공지사항이 없습니다</div>
          ) : notices.map(n => (
            <div key={n.id}
              className="px-4 py-3 border-b border-slate-50 last:border-0 cursor-pointer active:bg-slate-50"
              onClick={() => setExpanded(expanded === n.id ? null : n.id)}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800 flex-1 pr-2">{n.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-slate-400">
                    {new Date(n.created_at).toLocaleDateString('ko-KR')}
                  </span>
                  <svg className={`w-4 h-4 text-slate-300 transition-transform ${expanded === n.id ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </div>
              </div>
              {expanded === n.id && n.content && (
                <div className="mt-2 text-sm text-slate-600 leading-relaxed whitespace-pre-line">
                  {n.content}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 문의하기 */}
        <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
          <span className="text-sm font-bold text-slate-900 block mb-3">문의하기</span>
          <button onClick={openKakao}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-yellow-400 text-slate-900 text-sm font-bold rounded-xl active:bg-yellow-500 transition-colors">
            <span>💬</span>
            카카오톡 오픈채팅 문의
          </button>
          <div className="text-xs text-slate-400 text-center mt-2">카카오톡 ID: {KAKAO_ID}</div>
        </div>

        {/* 앱 버전 */}
        <div className="text-center text-xs text-slate-300 py-1">Sharp Signal v1.2</div>

        {/* 로그아웃 */}
        <button onClick={() => { onSignOut(); onClose() }}
          className="w-full py-3 border border-slate-200 text-slate-500 text-sm font-semibold rounded-2xl active:bg-slate-50 transition-colors">
          로그아웃
        </button>
      </div>
    </div>
  )
}

// ── 무료체험 시작 모달 ────────────────────────────────────────
function TrialPromptModal({ onStart, onDecline }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function handleStart() {
    setLoading(true)
    setError('')
    const deviceId = await getDeviceId()
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${API_BASE}/api/trial/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ deviceId }),
    })
    const json = await res.json()
    if (json.error === 'device_already_used') {
      setError('이미 다른 계정에서 체험이 사용된 기기입니다.')
      setLoading(false)
      return
    }
    setLoading(false)
    onStart()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-6 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-xl">
        <div className="text-center mb-5">
          <div className="w-14 h-14 rounded-full bg-indigo-50 flex items-center justify-center mx-auto mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold text-slate-900">7일 무료 체험</h2>
          <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
            모든 기능을 7일간 무료로 체험하실 수 있습니다.<br/>지금 시작하시겠습니까?
          </p>
        </div>
        {error && <p className="text-xs text-rose-500 text-center mb-3">{error}</p>}
        <div className="flex gap-2">
          <button onClick={onDecline}
            className="flex-1 py-3 rounded-2xl border border-slate-200 text-sm font-semibold text-slate-500">
            나중에
          </button>
          <button onClick={handleStart} disabled={loading}
            className="flex-1 py-3 rounded-2xl bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50">
            {loading ? '시작 중...' : '예, 시작하기'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 관리자 화면 ──────────────────────────────────────────────
function AdminScreen({ onClose }) {
  const [adminTab, setAdminTab]   = useState('users')  // 'users' | 'notices' | 'version'
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [extending, setExt]       = useState(null)
  // 공지사항
  const [notices, setNotices]     = useState([])
  const [nTitle, setNTitle]       = useState('')
  const [nContent, setNContent]   = useState('')
  const [nSaving, setNSaving]     = useState(false)
  const [nDeleting, setNDeleting] = useState(null)
  // 앱 버전 관리
  const [versionData, setVersionData] = useState(null)
  const [newMinVer, setNewMinVer]     = useState('')
  const [newLatestVer, setNewLatestVer] = useState('')
  const [newUpdateUrl, setNewUpdateUrl] = useState('')
  const [vSaving, setVSaving]         = useState(false)

  useEffect(() => {
    if (adminTab === 'users') loadUsers()
    else if (adminTab === 'notices') loadNotices()
    else if (adminTab === 'version') loadVersion()
  }, [adminTab])

  async function loadVersion() {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/app-version`)
      if (res.ok) {
        const data = await res.json()
        setVersionData(data)
        setNewMinVer(data.minVersion || '')
        setNewLatestVer(data.latestVersion || '')
        setNewUpdateUrl(data.updateUrl || '')
      }
    } catch (e) { console.error(e) }
    finally { setLoading(false) }
  }

  async function saveVersion() {
    if (!confirm(`minVersion을 ${newMinVer} 로 설정합니다. 이 버전 미만 모든 유저가 강제 업데이트 화면을 보게 됩니다. 진행할까요?`)) return
    setVSaving(true)
    try {
      const token = await getToken()
      const res = await fetch(`${API_BASE}/api/app-version`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ minVersion: newMinVer, latestVersion: newLatestVer, updateUrl: newUpdateUrl }),
      })
      if (res.ok) {
        const data = await res.json()
        setVersionData(data)
        toast.success('저장됨')
      } else toast.warn(`저장 실패 (${res.status})`)
    } catch (e) { console.error(e); toast.warn(`네트워크 오류`) }
    finally { setVSaving(false) }
  }

  async function getToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token
  }

  async function loadUsers() {
    setLoading(true)
    try {
      const token = await getToken()
      const res   = await fetch(`${API_BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) {
        const data = await res.json()
        setUsers(Array.isArray(data) ? data : [])
      } else {
        console.error('loadUsers failed:', res.status)
        toast.warn(`회원 로드 실패 (${res.status})`)
      }
    } catch (e) {
      console.error('[loadUsers]', e)
      toast.warn(`네트워크 오류: ${e?.message || ''}`)
    } finally {
      setLoading(false)
    }
  }

  async function loadNotices() {
    setLoading(true)
    const res = await fetch(NOTICES_API)
    setNotices(await res.json())
    setLoading(false)
  }

  async function saveNotice() {
    if (!nTitle.trim()) return
    setNSaving(true)
    const token = await getToken()
    await fetch(NOTICES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: nTitle.trim(), content: nContent.trim() }),
    })
    setNTitle(''); setNContent('')
    await loadNotices()
    setNSaving(false)
  }

  async function deleteNotice(id) {
    setNDeleting(id)
    const token = await getToken()
    await fetch(`${NOTICES_API}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await loadNotices()
    setNDeleting(null)
  }

  async function extend(userId, days) {
    setExt(userId + days)
    try {
      const token = await getToken()
      const res = await fetch(`${API_BASE}/api/admin/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId, days }),
      })
      if (!res.ok) {
        toast.warn(`연장 실패 (${res.status})`)
      } else {
        await loadUsers()
      }
    } catch (e) {
      console.error('[extend]', e)
      toast.warn(`네트워크 오류: ${e?.message || ''}`)
    } finally {
      setExt(null)
    }
  }

  async function endTrial(userId) {
    if (!confirm('이 회원의 체험을 즉시 종료할까요?')) return
    setExt(userId + 'trial')
    try {
      const token = await getToken()
      const res = await fetch(`${API_BASE}/api/admin/end-trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId }),
      })
      if (!res.ok) toast.warn(`체험 종료 실패 (${res.status})`)
      else await loadUsers()
    } catch (e) {
      console.error('[endTrial]', e)
      toast.warn(`네트워크 오류: ${e?.message || ''}`)
    } finally {
      setExt(null)
    }
  }

  function getStatus(u) {
    const now      = new Date()
    const subEnd   = u.sub_expires_at ? new Date(u.sub_expires_at) : null
    const trialEnd = u.trial_started_at ? new Date(new Date(u.trial_started_at).getTime() + TRIAL_DAYS * 86400000) : null
    if (subEnd && subEnd > now) {
      const d = Math.ceil((subEnd - now) / 86400000)
      return { label: `구독 ${d}일`, cls: 'text-emerald-600 bg-emerald-50' }
    }
    if (trialEnd > now) {
      const d = Math.ceil((trialEnd - now) / 86400000)
      return { label: `체험 ${d}일`, cls: 'text-indigo-600 bg-indigo-50' }
    }
    return { label: '만료', cls: 'text-rose-600 bg-rose-50' }
  }

  function fmtDate(d) {
    if (!d) return '-'
    return new Date(d).toLocaleDateString('ko-KR')
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col max-w-[520px] mx-auto">
      {/* 헤더 */}
      <div className="bg-white border-b border-slate-100 px-4 pb-0 flex flex-col"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-slate-900">관리자 패널</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {/* 탭 */}
        <div className="flex gap-1 pb-0">
          {[['users','회원 관리'],['notices','공지사항'],['version','앱 버전']].map(([key, label]) => (
            <button key={key} onClick={() => setAdminTab(key)}
              className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                adminTab === key
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-slate-400'
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {/* 컨텐츠 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>

        {/* 회원 관리 탭 */}
        {adminTab === 'users' && (loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">불러오는 중...</div>
        ) : users.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">가입 유저 없음</div>
        ) : users.map(u => {
          const st = getStatus(u)
          return (
            <div key={u.user_id} className="bg-white rounded-2xl p-4 border border-slate-100">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0 pr-2">
                  <div className="text-sm font-semibold text-slate-900 truncate">{u.email}</div>
                  <div className="text-xs text-slate-400 mt-0.5">가입 {fmtDate(u.created_at)}</div>
                  {u.sub_expires_at && <div className="text-xs text-slate-400">구독만료 {fmtDate(u.sub_expires_at)}</div>}
                  {u.device_id && (
                    <div className="text-[10px] text-slate-400 mt-0.5 break-all">
                      🆔 {u.device_id}
                    </div>
                  )}
                  {Array.isArray(u.device_ids) && u.device_ids.length > 0 && u.device_ids.some(d => d !== u.device_id) && (
                    <div className="text-[10px] text-slate-400 mt-0.5 break-all">
                      체험기록: {u.device_ids.filter(d => d !== u.device_id).join(', ')}
                    </div>
                  )}
                </div>
                <span className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${st.cls}`}>{st.label}</span>
              </div>
              {/* 추가 (+) */}
              <div className="flex gap-2 mb-2">
                {[1, 10, 30].map(days => (
                  <button key={days} onClick={() => extend(u.user_id, days)}
                    disabled={extending === u.user_id + days}
                    className="flex-1 py-2 text-xs font-semibold bg-slate-100 text-slate-700 rounded-xl hover:bg-indigo-50 hover:text-indigo-600 transition-colors disabled:opacity-40">
                    +{days}일
                  </button>
                ))}
              </div>
              {/* 차감 (-) + 체험 종료 */}
              <div className="flex gap-2">
                {[-1, -5, -10].map(days => (
                  <button key={days} onClick={() => extend(u.user_id, days)}
                    disabled={extending === u.user_id + days}
                    className="flex-1 py-2 text-xs font-semibold bg-slate-100 text-slate-700 rounded-xl hover:bg-rose-50 hover:text-rose-600 transition-colors disabled:opacity-40">
                    {days}일
                  </button>
                ))}
                <button onClick={() => endTrial(u.user_id)}
                  disabled={extending === u.user_id + 'trial'}
                  className="flex-1 py-2 text-xs font-semibold bg-rose-100 text-rose-700 rounded-xl hover:bg-rose-200 transition-colors disabled:opacity-40">
                  체험 종료
                </button>
              </div>
            </div>
          )
        }))}

        {/* 공지사항 탭 */}
        {adminTab === 'notices' && (<>
          {/* 작성 폼 */}
          <div className="bg-white rounded-2xl p-4 border border-slate-100">
            <div className="text-sm font-bold text-slate-900 mb-3">새 공지 작성</div>
            <input
              value={nTitle} onChange={e => setNTitle(e.target.value)}
              placeholder="제목"
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm mb-2 outline-none focus:border-indigo-400"
            />
            <textarea
              value={nContent} onChange={e => setNContent(e.target.value)}
              placeholder="내용 (선택)"
              rows={3}
              className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm mb-3 outline-none focus:border-indigo-400 resize-none"
            />
            <button onClick={saveNotice} disabled={nSaving || !nTitle.trim()}
              className="w-full py-2.5 bg-indigo-600 text-white text-sm font-bold rounded-xl disabled:opacity-40 active:bg-indigo-700">
              {nSaving ? '저장 중...' : '공지 등록'}
            </button>
          </div>

          {/* 기존 공지 목록 */}
          {loading ? (
            <div className="text-center py-6 text-slate-400 text-sm">불러오는 중...</div>
          ) : notices.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">공지사항 없음</div>
          ) : notices.map(n => (
            <div key={n.id} className="bg-white rounded-2xl p-4 border border-slate-100">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-900">{n.title}</div>
                  {n.content && <div className="text-xs text-slate-500 mt-1 whitespace-pre-line">{n.content}</div>}
                  <div className="text-xs text-slate-300 mt-1">
                    {new Date(n.created_at).toLocaleDateString('ko-KR')}
                  </div>
                </div>
                <button onClick={() => deleteNotice(n.id)} disabled={nDeleting === n.id}
                  className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full bg-rose-50 text-rose-400 active:bg-rose-100 disabled:opacity-40">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </>)}

        {/* 앱 버전 탭 */}
        {adminTab === 'version' && (loading ? (
          <div className="text-center py-10 text-slate-400 text-sm">불러오는 중...</div>
        ) : (
          <div className="bg-white rounded-2xl p-4 border border-slate-100 space-y-3">
            <div className="text-sm font-bold text-slate-900 mb-1">현재 설정</div>
            <div className="bg-slate-50 rounded-xl px-3 py-2 text-xs text-slate-600">
              <div>minVersion: <b className="text-slate-900">{versionData?.minVersion || '-'}</b></div>
              <div>latestVersion: <b className="text-slate-900">{versionData?.latestVersion || '-'}</b></div>
              <div className="break-all">updateUrl: <span className="text-slate-500">{versionData?.updateUrl || '-'}</span></div>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="text-sm font-bold text-slate-900 mb-2">새 값 설정</div>
              <label className="text-xs text-slate-500 mb-1 block">minVersion (이 버전 미만 = 강제 업데이트)</label>
              <input value={newMinVer} onChange={e => setNewMinVer(e.target.value)} placeholder="예: 1.4"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-2 outline-none focus:border-indigo-400" />
              <label className="text-xs text-slate-500 mb-1 block">latestVersion (참고용)</label>
              <input value={newLatestVer} onChange={e => setNewLatestVer(e.target.value)} placeholder="예: 1.4"
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-2 outline-none focus:border-indigo-400" />
              <label className="text-xs text-slate-500 mb-1 block">updateUrl</label>
              <input value={newUpdateUrl} onChange={e => setNewUpdateUrl(e.target.value)} placeholder="https://play.google.com/..."
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm mb-3 outline-none focus:border-indigo-400" />
              <button onClick={saveVersion} disabled={vSaving}
                className="w-full py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold active:bg-indigo-700 disabled:opacity-40">
                {vSaving ? '저장 중...' : '저장 (즉시 적용)'}
              </button>
              <div className="text-[10px] text-slate-400 mt-2 leading-snug">
                ⚠️ minVersion 변경 즉시 그 버전 미만 모든 유저는 어플 실행 시 업데이트 화면 강제.<br/>
                Play Store 배포 완료 후에만 변경하세요.
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 파워볼용 3매 분석 카드 (history 배열 → P/B 매핑 후 analyze3MatrixReal) ──
function Matrix3PowerballCard({ history, title, mapA, mapB }) {
  const shoeStr = useMemo(() =>
    (history || []).map(v => v === mapA ? 'P' : v === mapB ? 'B' : '').join('')
  , [history, mapA, mapB])
  const r = useMemo(() => analyze3MatrixReal(shoeStr), [shoeStr])
  const { normal, reverse, n1, n2 } = r
  const normalOX = useMemo(() => n1.filter(v => v && (v.ox === 'O' || v.ox === 'X')).map(v => v.ox), [n1])
  const reverseOX = useMemo(() => n2.filter(v => v && (v.ox === 'O' || v.ox === 'X')).map(v => v.ox), [n2])

  if (normal.total === 0 && reverse.total === 0) {
    return (
      <div className="mb-3 p-3 rounded-xl border border-rose-200 bg-rose-50/40">
        <div className="text-xs font-bold text-rose-700 mb-1">🃏 3매 — {title}</div>
        <div className="text-center text-slate-400 text-xs py-2">데이터 부족</div>
      </div>
    )
  }

  const normalPickLabel = normal.prediction === 'P' ? mapA : normal.prediction === 'B' ? mapB : '-'
  const reversePickLabel = reverse.prediction === 'P' ? mapA : reverse.prediction === 'B' ? mapB : '-'
  const aCount = (history || []).filter(v => v === mapA).length
  const bCount = (history || []).filter(v => v === mapB).length

  return (
    <div className="mb-3 p-3 rounded-xl border border-rose-200 bg-rose-50/40 overflow-hidden" style={{ minWidth: 0 }}>
      <div className="text-xs font-bold text-rose-700 mb-2">🃏 3매 — {title}</div>

      {/* 정/역 박스 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
        <div style={{ background: '#2563eb', borderRadius: 8, padding: '0.45rem', textAlign: 'center' }}>
          <div style={{ color: 'white', fontSize: '0.65rem', fontWeight: 700 }}>정</div>
          <div style={{ color: 'white', fontSize: '1rem', fontWeight: 900, margin: '2px 0' }}>{normalPickLabel}</div>
          <div style={{ color: 'white', fontSize: '0.95rem', fontWeight: 800 }}>{normal.rate.toFixed(0)}%</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.55rem' }}>{normal.wins}/{normal.losses}</div>
        </div>
        <div style={{ background: '#dc2626', borderRadius: 8, padding: '0.45rem', textAlign: 'center' }}>
          <div style={{ color: 'white', fontSize: '0.65rem', fontWeight: 700 }}>역</div>
          <div style={{ color: 'white', fontSize: '1rem', fontWeight: 900, margin: '2px 0' }}>{reversePickLabel}</div>
          <div style={{ color: 'white', fontSize: '0.95rem', fontWeight: 800 }}>{reverse.rate.toFixed(0)}%</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.55rem' }}>{reverse.wins}/{reverse.losses}</div>
        </div>
      </div>

      {/* 카운트 */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 6, fontSize: '0.65rem', fontWeight: 700 }}>
        <span style={{ color: '#2563eb' }}>{mapA} <b style={{ color: '#0f172a' }}>{aCount}</b></span>
        <span style={{ color: '#dc2626' }}>{mapB} <b style={{ color: '#0f172a' }}>{bCount}</b></span>
      </div>

      {/* 정/역 OX 그리드 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 5 }}>
        <Matrix3OXChart ox={normalOX} label={`정 OX (${normal.rate.toFixed(0)}%)`} />
        <Matrix3OXChart ox={reverseOX} label={`역 OX (${reverse.rate.toFixed(0)}%)`} />
      </div>
    </div>
  )
}

// 파워볼 3매 4종 묶음 (PowerballTab/DhPowerballTab 공용)
function Matrix3PowerballSection({ history }) {
  if (!history) return null
  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden" style={{ minWidth: 0 }}>
      <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-2 break-keep">🃏 3매 분석</div>
      <Matrix3PowerballCard history={history.pb_odd} title="파워볼 홀/짝"    mapA="홀"   mapB="짝" />
      <Matrix3PowerballCard history={history.pb_ou}  title="파워볼 언더/오버" mapA="언더" mapB="오버" />
      <Matrix3PowerballCard history={history.nb_odd} title="일반볼 홀/짝"    mapA="홀"   mapB="짝" />
      <Matrix3PowerballCard history={history.nb_ou}  title="일반볼 언더/오버" mapA="언더" mapB="오버" />
    </div>
  )
}

// ── 파워볼 분석기 탭 ───────────────────────────────────────────
const PB_API = 'https://sharpsignal.cloud/api/powerball'

const PB_CATS = [
  { key: 'pb_odd', label: '파워볼 홀/짝',    short: 'P홀짝', a: '홀',  b: '짝',  aCs: 'text-rose-600 bg-rose-50',     bCs: 'text-blue-600 bg-blue-50'    },
  { key: 'pb_ou',  label: '파워볼 언더/오버', short: 'P언오', a: '언더', b: '오버', aCs: 'text-blue-600 bg-blue-50',     bCs: 'text-orange-600 bg-orange-50'},
  { key: 'nb_odd', label: '일반볼 홀/짝',    short: 'N홀짝', a: '홀',  b: '짝',  aCs: 'text-rose-600 bg-rose-50',     bCs: 'text-blue-600 bg-blue-50'    },
  { key: 'nb_ou',  label: '일반볼 언더/오버', short: 'N언오', a: '언더', b: '오버', aCs: 'text-blue-600 bg-blue-50',     bCs: 'text-orange-600 bg-orange-50'},
]

function fmtCd(sec) {
  const m = Math.floor(sec / 60), s = sec % 60
  return `${m}:${String(s).padStart(2,'0')}`
}

function resultChip(label, val) {
  const colorMap = {
    '홀':  'text-rose-600 bg-rose-50',
    '짝':  'text-blue-600 bg-blue-50',
    '오버':'text-orange-600 bg-orange-50',
    '언더':'text-blue-600 bg-blue-50',
  }
  const cs = colorMap[val] || 'text-slate-600 bg-slate-100'
  return (
    <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${cs}`}>
      <span className="text-slate-400 font-medium">{label} </span>{val}
    </span>
  )
}

function pickChip(val) {
  const colorMap = {
    '홀':  'text-rose-600 bg-rose-50 border border-rose-200',
    '짝':  'text-blue-600 bg-blue-50 border border-blue-200',
    '오버':'text-orange-600 bg-orange-50 border border-orange-200',
    '언더':'text-blue-600 bg-blue-50 border border-blue-200',
    '패스':'text-slate-500 bg-slate-100 border border-slate-300',
  }
  if (!val) return <span className="text-xs text-slate-300">-</span>
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${colorMap[val] || 'text-slate-500 bg-slate-100'}`}>{val}</span>
}

function PowerballTab({ hasAccess, user, onShowUpgrade, onSignIn }) {
  const [data, setData]         = useState(null)
  const [loading, setLoading]   = useState(true)
  const [countdown, setCountdown] = useState(0)
  const [rankTab, setRankTab]   = useState('pb_odd')
  const [expandedAlgo, setExpandedAlgo] = useState(null)
  const fastPollRef = useRef(null)

  useEffect(() => {
    loadData()
    const iv = setInterval(loadData, 30000)   // 30초마다 백그라운드 갱신
    return () => { clearInterval(iv); clearTimeout(fastPollRef.current) }
  }, [])

  // next_draw_epoch 기준 카운트다운 — 서버 시각에서 계산해서 오차 없음
  useEffect(() => {
    if (!data?.next_draw_epoch) return
    const tick = () => {
      const sec = Math.max(0, Math.round(data.next_draw_epoch - Date.now() / 1000))
      setCountdown(sec)
      // 추첨 시간 지나면 빠르게 새 데이터 폴링 (10초마다, 최대 2분)
      if (sec === 0) {
        let tries = 0
        const poll = () => {
          if (tries++ > 12) return
          loadData()
          fastPollRef.current = setTimeout(poll, 10000)
        }
        clearTimeout(fastPollRef.current)
        fastPollRef.current = setTimeout(poll, 5000)
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [data?.next_draw_epoch])

  async function loadData() {
    try {
      const res  = await fetch(PB_API)
      const json = await res.json()
      if (!json.error) {
        setData(json)
        setLoading(false)
      } else {
        // 서버 캐시 아직 준비중 → 3초 후 재시도
        setTimeout(loadData, 3000)
      }
    } catch(e) {
      setLoading(false)
    }
  }

  if (!hasAccess) {
    return (
      <div className="px-4 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        <LockBox
          label="구독 후 파워볼 패턴을 이용할 수 있습니다"
          onUnlock={user ? onShowUpgrade : onSignIn}
          isGuest={!user}
        />
      </div>
    )
  }

  if (loading) return <SkeletonList count={3} />
  if (!data || data.error) return <div className="text-center py-20 text-slate-400 dark:text-slate-500 text-sm">데이터 없음</div>

  const { latest, algo_rankings, today_rounds, current_round, history } = data
  const rankings = algo_rankings?.[rankTab] || []

  return (
    <div className="px-3 py-4 space-y-3 fade-in">

      {/* ── 현재 회차 + 카운트다운 ── */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="flex justify-between items-start mb-3 gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="text-xs text-slate-400 break-keep">오늘 {today_rounds}회차 진행</div>
            <div className="text-sm font-bold text-slate-700 mt-0.5 break-keep">{current_round}회차 결과</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">다음 추첨</div>
            <div className={`text-xl font-bold tabular-nums mt-0.5 whitespace-nowrap ${countdown < 60 ? 'text-rose-500 animate-pulse' : 'text-indigo-600'}`}>
              {countdown === 0 ? '집계중' : fmtCd(countdown)}
            </div>
          </div>
        </div>
        {/* 결과 태그 — 2x2 그리드 */}
        <div className="grid grid-cols-2 gap-2">
          {resultChip('파워볼', latest.pb_odd)}
          {resultChip('파워볼', latest.pb_ou)}
          {resultChip('일반볼', latest.nb_odd)}
          {resultChip('일반볼', latest.nb_ou)}
        </div>
      </div>

      {/* ── 🃏 3매 분석 ── */}
      <Matrix3PowerballSection history={history} />

      {/* ── 패턴 분석 ── */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="px-3 pt-3 pb-0 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-2 break-keep">🎯 패턴 분석</div>
          <div className="flex gap-1 overflow-x-auto pb-0 scrollbar-hide">
            {PB_CATS.map(cat => (
              <button key={cat.key} onClick={() => { setRankTab(cat.key); setExpandedAlgo(null) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                  rankTab === cat.key
                    ? 'border-indigo-500 text-indigo-600 bg-indigo-50'
                    : 'border-transparent text-slate-400'
                }`}>
                {cat.short}
              </button>
            ))}
          </div>
        </div>

        {rankings.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm">데이터 없음</div>
        ) : (
          <div>
            {rankings.map((r, i) => {
              const streakEl = r.win_streak > 0
                ? <span className="text-emerald-600 font-bold text-xs">🔥 {r.win_streak}연승</span>
                : r.lose_streak > 0
                ? <span className="text-rose-400 text-xs">{r.lose_streak}연패</span>
                : <span className="text-slate-300 text-xs">-</span>
              const isTop = i === 0
              const isExpanded = expandedAlgo === `${rankTab}_${r.algo}`
              const oxList = r.ox || []
              return (
                <div key={r.algo} className={`border-t border-slate-50 ${isTop ? 'bg-emerald-50/60' : ''}`}>
                  {/* 순위 행 — 탭하면 O/X 상세 토글 */}
                  <div
                    className="flex items-start justify-between px-3 py-2.5 active:bg-slate-50 cursor-pointer gap-2"
                    onClick={() => setExpandedAlgo(isExpanded ? null : `${rankTab}_${r.algo}`)}>
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <span className={`text-xs font-bold w-5 text-center shrink-0 ${isTop ? 'text-emerald-600' : 'text-slate-300'}`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold break-keep ${isTop ? 'text-emerald-700' : 'text-slate-700'}`}>
                          {r.label}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[11px] text-slate-400 whitespace-nowrap">{r.correct}/{r.total}회</span>
                          {streakEl}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-slate-300 whitespace-nowrap">최다연승 <span className="text-emerald-400 font-semibold">{r.max_win}</span></span>
                          <span className="text-[10px] text-slate-300 whitespace-nowrap">최다연패 <span className="text-rose-300 font-semibold">{r.max_lose}</span></span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {pickChip(r.next_pred)}
                      <div className={`text-sm font-bold tabular-nums text-right whitespace-nowrap ${isTop ? 'text-emerald-600' : 'text-slate-600'}`}>
                        <AnimatedNumber value={r.rate * 100} format={v => Math.round(v)} />%
                      </div>
                      <span className={`text-slate-300 text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>

                  {/* O/X 상세 패널 */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 bg-slate-50/70">
                      <div className="text-[10px] text-slate-400 mb-2">
                        전체 {oxList.length}회 예측 기록 (오래된 순 → 최신)
                      </div>
                      {oxList.length === 0 ? (
                        <div className="text-xs text-slate-300 text-center py-3">기록 없음</div>
                      ) : (
                        <div className="grid grid-cols-6 gap-1.5">
                          {oxList.map((item, idx) => (
                            <div key={idx} className={`flex flex-col items-center gap-0.5 p-1.5 rounded-lg border ${
                              item.ok
                                ? 'bg-emerald-50 border-emerald-200'
                                : 'bg-rose-50 border-rose-200'
                            }`}>
                              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                item.ok ? 'bg-emerald-500 text-white' : 'bg-rose-400 text-white'
                              }`}>
                                {item.ok ? 'O' : 'X'}
                              </div>
                              <div className="text-[10px] font-bold leading-tight text-center">
                                <span className="text-slate-400">{item.p}</span>
                                <span className="text-slate-300 mx-0.5">→</span>
                                <span className={item.ok ? 'text-emerald-700' : 'text-rose-700'}>{item.a}</span>
                              </div>
                              <span className="text-[9px] text-slate-400 tabular-nums">{item.r}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 동행 파워볼 분석기 탭 ──────────────────────────────────────
const DH_PB_API = 'https://sharpsignal.cloud/api/dh-powerball'

function DhPowerballTab({ hasAccess, user, onShowUpgrade, onSignIn }) {
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(true)
  const [countdown, setCountdown] = useState(0)
  const [rankTab, setRankTab]     = useState('pb_odd')
  const [expandedAlgo, setExpandedAlgo] = useState(null)
  const fastPollRef = useRef(null)

  useEffect(() => {
    loadData()
    const iv = setInterval(loadData, 30000)
    return () => { clearInterval(iv); clearTimeout(fastPollRef.current) }
  }, [])

  useEffect(() => {
    if (!data?.next_draw_epoch) return
    const tick = () => {
      const sec = Math.max(0, Math.round(data.next_draw_epoch - Date.now() / 1000))
      setCountdown(sec)
      if (sec === 0) {
        let tries = 0
        const poll = () => {
          if (tries++ > 12) return
          loadData()
          fastPollRef.current = setTimeout(poll, 10000)
        }
        clearTimeout(fastPollRef.current)
        fastPollRef.current = setTimeout(poll, 5000)
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [data?.next_draw_epoch])

  async function loadData() {
    try {
      const res  = await fetch(DH_PB_API)
      const json = await res.json()
      if (!json.error) {
        setData(json)
        setLoading(false)
      } else {
        setTimeout(loadData, 3000)
      }
    } catch(e) {
      setLoading(false)
    }
  }

  if (!hasAccess) {
    return (
      <div className="px-4 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        <LockBox
          label="구독 후 동행 파워볼 패턴을 이용할 수 있습니다"
          onUnlock={user ? onShowUpgrade : onSignIn}
          isGuest={!user}
        />
      </div>
    )
  }

  if (loading) return <SkeletonList count={3} />
  if (!data || data.error) return <div className="text-center py-20 text-slate-400 dark:text-slate-500 text-sm">데이터 없음</div>

  const { latest, algo_rankings, today_rounds, current_round, history } = data
  const rankings = algo_rankings?.[rankTab] || []

  return (
    <div className="px-3 py-4 space-y-3 fade-in">

      {/* 현재 회차 + 카운트다운 */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 border border-slate-100 dark:border-slate-800 shadow-sm">
        <div className="flex justify-between items-start mb-3 gap-2 flex-wrap">
          <div className="min-w-0">
            <div className="text-xs text-slate-400 break-keep">오늘 {today_rounds}회차 진행</div>
            <div className="text-sm font-bold text-slate-700 mt-0.5 break-keep">{current_round}회차 결과</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-400">다음 추첨</div>
            <div className={`text-xl font-bold tabular-nums mt-0.5 whitespace-nowrap ${countdown < 60 ? 'text-rose-500 animate-pulse' : 'text-violet-600'}`}>
              {countdown === 0 ? '집계중' : fmtCd(countdown)}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {resultChip('파워볼', latest.pb_odd)}
          {resultChip('파워볼', latest.pb_ou)}
          {resultChip('일반볼', latest.nb_odd)}
          {resultChip('일반볼', latest.nb_ou)}
        </div>
      </div>

      {/* 🃏 3매 분석 */}
      <Matrix3PowerballSection history={history} />

      {/* 패턴 분석 */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="px-3 pt-3 pb-0 border-b border-slate-100">
          <div className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-2 break-keep">🎯 패턴 분석</div>
          <div className="flex gap-1 overflow-x-auto pb-0 scrollbar-hide">
            {PB_CATS.map(cat => (
              <button key={cat.key} onClick={() => { setRankTab(cat.key); setExpandedAlgo(null) }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg whitespace-nowrap border-b-2 transition-colors ${
                  rankTab === cat.key
                    ? 'border-violet-500 text-violet-600 bg-violet-50'
                    : 'border-transparent text-slate-400'
                }`}>
                {cat.short}
              </button>
            ))}
          </div>
        </div>

        {rankings.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm">데이터 없음</div>
        ) : (
          <div>
            {rankings.map((r, i) => {
              const streakEl = r.win_streak > 0
                ? <span className="text-emerald-600 font-bold text-xs">🔥 {r.win_streak}연승</span>
                : r.lose_streak > 0
                ? <span className="text-rose-400 text-xs">{r.lose_streak}연패</span>
                : <span className="text-slate-300 text-xs">-</span>
              const isTop = i === 0
              const isExpanded = expandedAlgo === `${rankTab}_${r.algo}`
              const oxList = r.ox || []
              return (
                <div key={r.algo} className={`border-t border-slate-50 ${isTop ? 'bg-violet-50/60' : ''}`}>
                  <div
                    className="flex items-start justify-between px-3 py-2.5 active:bg-slate-50 cursor-pointer gap-2"
                    onClick={() => setExpandedAlgo(isExpanded ? null : `${rankTab}_${r.algo}`)}>
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <span className={`text-xs font-bold w-5 text-center shrink-0 ${isTop ? 'text-violet-600' : 'text-slate-300'}`}>
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold break-keep ${isTop ? 'text-violet-700' : 'text-slate-700'}`}>
                          {r.label}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <span className="text-[11px] text-slate-400 whitespace-nowrap">{r.correct}/{r.total}회</span>
                          {streakEl}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-slate-300 whitespace-nowrap">최다연승 <span className="text-emerald-400 font-semibold">{r.max_win}</span></span>
                          <span className="text-[10px] text-slate-300 whitespace-nowrap">최다연패 <span className="text-rose-300 font-semibold">{r.max_lose}</span></span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {pickChip(r.next_pred)}
                      <div className={`text-sm font-bold tabular-nums text-right whitespace-nowrap ${isTop ? 'text-violet-600' : 'text-slate-600'}`}>
                        <AnimatedNumber value={r.rate * 100} format={v => Math.round(v)} />%
                      </div>
                      <span className={`text-slate-300 text-xs transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-3 pb-4 pt-1 bg-slate-50/70">
                      <div className="text-[10px] text-slate-400 mb-2">
                        전체 {oxList.length}회 예측 기록 (오래된 순 → 최신)
                      </div>
                      {oxList.length === 0 ? (
                        <div className="text-xs text-slate-300 text-center py-3">기록 없음</div>
                      ) : (
                        <div className="grid grid-cols-6 gap-1.5">
                          {oxList.map((item, idx) => (
                            <div key={idx} className={`flex flex-col items-center gap-0.5 p-1.5 rounded-lg border ${
                              item.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'
                            }`}>
                              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                                item.ok ? 'bg-emerald-500 text-white' : 'bg-rose-400 text-white'
                              }`}>
                                {item.ok ? 'O' : 'X'}
                              </div>
                              <div className="text-[10px] font-bold leading-tight text-center">
                                <span className="text-slate-400">{item.p}</span>
                                <span className="text-slate-300 mx-0.5">→</span>
                                <span className={item.ok ? 'text-emerald-700' : 'text-rose-700'}>{item.a}</span>
                              </div>
                              <span className="text-[9px] text-slate-400 tabular-nums">{item.r}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

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
  'Toronto Maple Leafs':'TOR','Utah Hockey Club':'UTA','Utah HC':'UTA','Utah Mammoth':'UTA',
  'Vancouver Canucks':'VAN',
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

// starts_at ("04/24 02:00 KST" 형식) → epoch ms. 정렬용.
function parseStartsTs(startsAt) {
  if (!startsAt) return Infinity
  const m = String(startsAt).match(/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/)
  if (!m) return Infinity
  const year = new Date().getFullYear()
  return Date.UTC(year, parseInt(m[1]) - 1, parseInt(m[2]), parseInt(m[3]) - 9, parseInt(m[4]))
}

const LEAGUE_FLAGS = {
  MLB: '🇺🇸', KBO: '🇰🇷', NPB: '🇯🇵',
  EPL: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'EFL Championship': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', Bundesliga: '🇩🇪', 'Serie A': '🇮🇹',
  'Ligue 1': '🇫🇷', 'La Liga': '🇪🇸',
  'K리그1': '🇰🇷', 'K리그2': '🇰🇷', MLS: '🇺🇸', 'A리그': '🇦🇺', 'J리그': '🇯🇵', 'J리그2': '🇯🇵',
  UCL: '🏆', Europa: '🟠', Conference: '🟢',
  NBA: '🇺🇸', NHL: '🇺🇸',
}

// 피나클 게임 API가 반환하는 다양한 리그명 → 정규화
const LEAGUE_ALIASES = {
  'Championship': 'EFL Championship',
  'England - Championship': 'EFL Championship',
  'England Championship': 'EFL Championship',
  'EFL': 'EFL Championship',
  'EFL챔피언십': 'EFL Championship',
  'EFL챔': 'EFL Championship',
  'Premier League': 'EPL',
  'England - Premier League': 'EPL',
  'Spain - La Liga': 'La Liga',
  'Italy - Serie A': 'Serie A',
  'Germany - Bundesliga': 'Bundesliga',
  'France - Ligue 1': 'Ligue 1',
}
function normalizeLeague(league) {
  const l = (league || '').trim()
  return LEAGUE_ALIASES[l] || l
}

const ALL_LEAGUES = [
  'MLB', 'KBO', 'NPB',
  'EPL', 'EFL Championship', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'J리그2', 'UCL', 'Europa', 'Conference',
  'NBA', 'NHL',
]

const SPORT_GROUPS = [
  { key: 'baseball',   label: '⚾ 야구', leagues: ['MLB', 'KBO', 'NPB'] },
  { key: 'soccer',     label: '⚽ 축구', leagues: ['EPL', 'EFL Championship', 'Bundesliga', 'Serie A', 'Ligue 1', 'La Liga', 'K리그1', 'K리그2', 'MLS', 'A리그', 'J리그', 'J리그2', 'UCL', 'Europa', 'Conference'] },
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


function OddsTag({ label, value, openValue, highlight, result, pickable, onPick, selected }) {
  const diff = (value != null && openValue != null)
    ? parseFloat((value - openValue).toFixed(3)) : null
  const hasDiff = diff !== null && Math.abs(diff) >= 0.005
  const isHL = highlight === 'blue'
  // 경기 결과 (true=이김, false=짐, null=미정)
  const isWin = result === true
  const isLoss = result === false
  const canPick = pickable && result == null && value != null
  const isSelected = canPick && selected
  const handleClick = canPick
    ? (e) => { e.stopPropagation(); haptic.light(); onPick?.() }
    : undefined
  return (
    <div onClick={handleClick}
      className={`flex-1 min-w-0 flex flex-col items-center py-2 px-1 rounded-xl transition-all relative ${canPick ? 'cursor-pointer active:scale-95' : ''}
      ${isWin ? 'bg-emerald-500 shadow-md shadow-emerald-100 dark:shadow-emerald-900/30' :
        isLoss ? 'bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 opacity-60' :
        isSelected ? 'bg-indigo-600 shadow-md shadow-indigo-200 dark:shadow-indigo-900/40 ring-2 ring-indigo-300 dark:ring-indigo-700' :
        isHL ? 'bg-indigo-600 shadow-md shadow-indigo-100' :
        canPick ? 'bg-white dark:bg-slate-800 border-2 border-indigo-300 dark:border-indigo-700' :
        'bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>
      {isWin && (
        <span className="absolute top-0.5 right-1 text-white text-[10px]">✓</span>
      )}
      {isSelected && (
        <span className="absolute top-0.5 right-1 text-white text-[10px] font-bold">✓</span>
      )}
      <span className={`text-[11px] font-medium mb-0.5 whitespace-nowrap
        ${isWin ? 'text-emerald-100' :
          isLoss ? 'text-slate-400 dark:text-slate-500' :
          isSelected ? 'text-indigo-100' :
          isHL ? 'text-indigo-200' :
          canPick ? 'text-indigo-600 dark:text-indigo-400' :
          'text-slate-400 dark:text-slate-500'}`}>{label}</span>
      <span className={`text-sm font-bold leading-tight whitespace-nowrap
        ${isWin ? 'text-white' :
          isLoss ? 'text-slate-500 dark:text-slate-400 line-through' :
          isSelected ? 'text-white' :
          isHL ? 'text-white' :
          'text-slate-900 dark:text-slate-100'}`}>
        {value?.toFixed(2) ?? '-'}
      </span>
      {hasDiff && !isWin && !isLoss ? (
        <span className={`text-[11px] font-semibold mt-0.5 whitespace-nowrap ${diff > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
        </span>
      ) : <span className="text-[11px] opacity-0">-</span>}
    </div>
  )
}

function SharpBadge({ alerts, game }) {
  if (!alerts || alerts.length === 0) return null
  const op = game.opening || {}
  const fmtPts = v => v != null ? `${v >= 0 ? '+' : ''}${v}` : '?'
  const badges = []
  if (alerts.some(a => a.type === 'line_sp') && op.sp_pts != null && game.sp_pts != null && op.sp_pts !== game.sp_pts)
    badges.push({ key: 'line_sp', label: '핸디', detail: `${fmtPts(op.sp_pts)} → ${fmtPts(game.sp_pts)}` })
  if (alerts.some(a => a.type === 'line_ou') && op.ou_pts != null && game.ou_pts != null && op.ou_pts !== game.ou_pts)
    badges.push({ key: 'line_ou', label: 'O/U', detail: `${op.ou_pts} → ${game.ou_pts}` })
  if (badges.length === 0) return null
  return (
    <div className="flex gap-1.5 flex-wrap mb-2.5">
      {badges.map(b => (
        <span key={b.key} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-semibold">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
          기준점 변동 · {b.label} {b.detail}
        </span>
      ))}
    </div>
  )
}

function OddsChart({ snapshots, mktTab, isSoccer }) {
  const data = [...snapshots].reverse()
  if (data.length < 2) return null

  const W = 300, H = 80, PX = 8, PY = 8

  const series = mktTab === 'ml'
    ? [
        { values: data.map(s => s.ml_home),  color: '#6366F1', label: '홈' },
        { values: data.map(s => s.ml_away),  color: '#F43F5E', label: '원정' },
        ...(isSoccer ? [{ values: data.map(s => s.ml_draw), color: '#94A3B8', label: '무' }] : []),
      ]
    : mktTab === 'sp'
    ? [
        { values: data.map(s => s.sp_home), color: '#6366F1', label: '홈' },
        { values: data.map(s => s.sp_away), color: '#F43F5E', label: '원정' },
      ]
    : [
        { values: data.map(s => s.ou_over),  color: '#10B981', label: '오버' },
        { values: data.map(s => s.ou_under), color: '#F59E0B', label: '언더' },
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

  const yMin = lo.toFixed(2), yMax = hi.toFixed(2)

  return (
    <div className="mb-3 bg-slate-50 border border-slate-100 rounded-xl p-3">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
          {[0.25, 0.5, 0.75].map(t => (
            <line key={t} x1={PX} x2={W - PX}
              y1={PY + t * (H - PY * 2)} y2={PY + t * (H - PY * 2)}
              stroke="#E2E8F0" strokeWidth="1" />
          ))}
          {series.map((s, i) => {
            const d = path(s.values)
            return d ? <path key={i} d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /> : null
          })}
        </svg>
        <div className="absolute top-1 right-1 text-xs text-slate-400">{yMax}</div>
        <div className="absolute bottom-1 right-1 text-xs text-slate-400">{yMin}</div>
      </div>
      <div className="flex gap-3 justify-center mt-1">
        {series.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="w-4 h-0.5 rounded" style={{ backgroundColor: s.color }} />
            <span className="text-xs text-slate-400">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
    if (cur == null) return <span className="text-slate-300">-</span>
    const d = prev != null ? parseFloat((cur - prev).toFixed(3)) : null
    const show = d !== null && Math.abs(d) >= 0.005
    return (
      <span className={show ? (d > 0 ? 'text-emerald-600 font-bold' : 'text-rose-500 font-bold') : 'text-slate-800'}>
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
      <div className="flex-1 bg-slate-900/40 backdrop-blur-sm" />
      <div
        className="relative bg-white rounded-t-3xl px-4 pt-4 max-h-[82vh] flex flex-col"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 32px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto" />
          <button
            onClick={onClose}
            className="absolute right-4 top-4 w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 text-slate-400 hover:bg-slate-200 active:bg-slate-300 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="mb-4">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
              {flag} {game.league}
            </span>
            <span className="text-[12px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md">📅 {game.starts_at?.replace(' KST','')}</span>
          </div>
          <div className="text-slate-900 font-bold text-lg mb-2">
            {game.home} <span className="text-slate-300 font-normal text-sm mx-1">vs</span> {game.away}
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          {mktTabs.map(t => (
            <button key={t.key} onClick={() => setMktTab(t.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all
                ${mktTab === t.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center text-slate-400 py-10 text-sm">불러오는 중...</div>
        ) : snapshots.length === 0 ? (
          <div className="text-center text-slate-400 py-10 text-sm">데이터 없음</div>
        ) : (
          <div className="overflow-y-auto flex-1">
            <OddsChart snapshots={snapshots} mktTab={mktTab} isSoccer={isSoccer} />
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 border-b border-slate-100">
                  <th className="text-left py-2 pr-2 font-medium text-xs">시간</th>
                  {mktTab === 'ml' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">홈</th>
                    {isSoccer && <th className="text-right py-2 px-2 font-medium text-xs">무</th>}
                    <th className="text-right py-2 px-2 font-medium text-xs">원정</th>
                  </>}
                  {mktTab === 'sp' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">기준선</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">홈</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">원정</th>
                  </>}
                  {mktTab === 'ou' && <>
                    <th className="text-right py-2 px-2 font-medium text-xs">기준선</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">오버</th>
                    <th className="text-right py-2 px-2 font-medium text-xs">언더</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s, i) => {
                  const prev = snapshots[i + 1]
                  return (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="py-2 pr-2 text-slate-400 whitespace-nowrap text-xs">{fmtTime(s.ts)}</td>
                      {mktTab === 'ml' && <>
                        <td className="text-right py-2 px-2">{diffCell(s.ml_home, prev?.ml_home)}</td>
                        {isSoccer && <td className="text-right py-2 px-2">{diffCell(s.ml_draw, prev?.ml_draw)}</td>}
                        <td className="text-right py-2 px-2">{diffCell(s.ml_away, prev?.ml_away)}</td>
                      </>}
                      {mktTab === 'sp' && <>
                        <td className="text-right py-2 px-2 text-slate-500 text-xs">{s.sp_pts != null ? (s.sp_pts >= 0 ? '+' : '') + s.sp_pts : '-'}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_home, prev?.sp_home)}</td>
                        <td className="text-right py-2 px-2">{diffCell(s.sp_away, prev?.sp_away)}</td>
                      </>}
                      {mktTab === 'ou' && <>
                        <td className="text-right py-2 px-2 text-slate-500 text-xs">{s.ou_pts ?? '-'}</td>
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

function fmtCount(count) {
  const n = Number(count)
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('ko-KR') : null
}

function fmtMoney(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`
  if (n >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만`
  return `${n.toLocaleString('ko-KR')}원`
}

function MarketResult({ label, result, base }) {
  if (!result && !base) return null
  return (
    <div className="text-[11px] text-slate-400 mt-1">
      {label}{base ? ` ${base}` : ''}{result ? ` · 결과 ${result}` : ''}
    </div>
  )
}

function PctBar({ label, pct, handle, count, amount, odds }) {
  if (pct == null) return null
  const countLabel = fmtCount(count)
  const amountLabel = fmtMoney(amount)
  // PAYOUT = 구매율(%) × 배당. 픽 이겼을 때 사이트 지급 비율.
  // > 100% = 사이트 손해 (대중이 그 픽에 몰려서 배당 가치 떨어짐)
  // < 100% = 사이트 이익 (베팅 적게 들어옴)
  const payout = (pct != null && odds != null) ? Math.round(pct * odds) : null
  const payoutBg = payout == null ? null
                    : payout >= 100 ? '#fee2e2'   // 사이트 손해 → 빨강
                    : '#dcfce7'                    // 사이트 이익 → 초록
  const payoutFg = payout == null ? null
                    : payout >= 100 ? '#b91c1c'
                    : '#15803d'
  // 토사장 손익: 픽 이겼을 때 사이트 P/L
  //   시장 전체 풀 ≈ amount × 100/pct (해당 픽 amount와 pct로 역산)
  //   사이트 P/L = 전체풀 − amount × odds = amount × (100/pct − odds)
  //   PAYOUT < 100% → 양수 (사이트 이익), PAYOUT > 100% → 음수 (사이트 손해)
  const siteProfit = (amount != null && odds != null && pct != null && pct > 0 && amount > 0)
    ? Math.round(amount * (100/pct - odds))
    : null
  const siteLabel = siteProfit != null
    ? (siteProfit < 0 ? `토사장 -${fmtMoney(-siteProfit)}` : `토사장 +${fmtMoney(siteProfit)}`)
    : null
  const siteBg = siteProfit == null ? null
                  : siteProfit < 0 ? '#fee2e2'   // 손해 → 빨강
                  : '#dcfce7'                     // 이익 → 초록
  const siteFg = siteProfit == null ? null
                  : siteProfit < 0 ? '#b91c1c'
                  : '#15803d'
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-slate-500 font-medium">{label}</span>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <span className="text-slate-800 font-semibold">{pct}%</span>
          {payout != null && (
            <span style={{ color: payoutFg, fontWeight: 700, background: payoutBg, padding: '1px 6px', borderRadius: 4, fontSize: 10 }}>
              PAYOUT {payout}%
            </span>
          )}
          {siteLabel && (
            <span style={{ color: siteFg, fontWeight: 700, background: siteBg, padding: '1px 6px', borderRadius: 4, fontSize: 10 }}>
              {siteLabel}
            </span>
          )}
          {handle != null && <span className="text-slate-400">· 금액 {handle}%</span>}
          {countLabel && (
            <span style={{ color: '#0f766e', fontWeight: 700, background: '#ccfbf1', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
              {countLabel}건
            </span>
          )}
          {amountLabel && (
            <span style={{ color: '#9a3412', fontWeight: 700, background: '#ffedd5', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
              {amountLabel}
            </span>
          )}
        </div>
      </div>
      <div className="w-full bg-slate-100 rounded-full h-1">
        <div className="bg-indigo-400 h-1 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// 마켓 섹션 헤더 (구매율 박스 내부에서 마켓 구분용)
function MarketHeader({ label, accent = '#64748b', bg = '#f1f5f9' }) {
  return (
    <div className="flex items-center gap-1.5 my-1">
      <span style={{
        fontSize: 11, fontWeight: 800, color: accent,
        background: bg, padding: '2px 8px', borderRadius: 6, letterSpacing: 0.3
      }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
    </div>
  )
}

function PublicBetting({ pb, isSoccer, pbRank }) {
  if (!pb) return null
  // 공통 박스 스타일: 파란 톤 (해외 = 글로벌 → 블루)
  const boxStyle = {
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    background: '#eff6ff',  // sky-50
    border: '1px solid #bfdbfe',  // sky-200
  }
  // 순위 배지
  const rankBadge = pbRank ? (
    <span style={{
      fontSize: 11, fontWeight: 800,
      color: pbRank.rank === 1 ? '#b45309' : pbRank.rank <= 3 ? '#1e40af' : '#475569',
      background: pbRank.rank === 1 ? '#fef3c7' : pbRank.rank <= 3 ? '#dbeafe' : '#f1f5f9',
      padding: '2px 8px', borderRadius: 999, marginLeft: 6,
    }}>
      💰 {pbRank.rank}위/{pbRank.total}
    </span>
  ) : null
  // 축구: Excapper 데이터 (1X2 + BTTS, 금액 KRW 포함)
  if (isSoccer && (pb.ml_bets_home != null || pb.ml_bets_draw != null || pb.ml_bets_away != null || pb.btts_yes_pct != null)) {
    const totalLabel = pb.total_money > 0 ? `총 ${fmtMoney(pb.total_money)}` : null
    return (
      <div style={boxStyle}>
        <div className="flex items-center justify-between mb-2">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#1e40af', letterSpacing: 0.3 }}>
              🌐 해외 구매율
            </div>
            {rankBadge}
          </div>
          {totalLabel && <div style={{ fontSize: 10, color: '#3b82f6' }}>{totalLabel} 베팅</div>}
        </div>
        {(pb.ml_bets_home != null || pb.ml_bets_away != null) && (
          <>
            <MarketHeader label="승무패" accent="#1e40af" bg="#dbeafe" />
            {pb.ml_bets_home != null && <PctBar label="홈 승"   pct={pb.ml_bets_home} amount={pb.ml_amount_home} odds={pb.ml_odds_home} />}
            {pb.ml_bets_draw != null && <PctBar label="무"      pct={pb.ml_bets_draw} amount={pb.ml_amount_draw} odds={pb.ml_odds_draw} />}
            {pb.ml_bets_away != null && <PctBar label="원정 승" pct={pb.ml_bets_away} amount={pb.ml_amount_away} odds={pb.ml_odds_away} />}
          </>
        )}
        {(pb.btts_yes_pct != null || pb.btts_no_pct != null) && (
          <>
            <MarketHeader label="양팀득점 (BTTS)" accent="#1e40af" bg="#dbeafe" />
            {pb.btts_yes_pct != null && <PctBar label="예 (Yes)"   pct={pb.btts_yes_pct} amount={pb.btts_yes_amount} odds={pb.btts_yes_odds} />}
            {pb.btts_no_pct  != null && <PctBar label="아니오 (No)" pct={pb.btts_no_pct}  amount={pb.btts_no_amount}  odds={pb.btts_no_odds} />}
          </>
        )}
      </div>
    )
  }
  // 야구/농구/하키: sportsbettingdime 기존 데이터
  return (
    <div style={boxStyle}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#1e40af', letterSpacing: 0.3, marginBottom: 4 }}>
        🌐 해외 구매율
      </div>
      <MarketHeader label="승패 (ML)" accent="#1e40af" bg="#dbeafe" />
      <PctBar label="홈 ML"   pct={pb.ml_bets_home}  handle={pb.ml_handle_home} />
      <PctBar label="원정 ML"  pct={pb.ml_bets_away}  handle={pb.ml_handle_away} />
      {(pb.sp_bets_home != null || pb.sp_bets_away != null) && (
        <>
          <MarketHeader label="핸디" accent="#1e40af" bg="#dbeafe" />
          {pb.sp_bets_home != null && <PctBar label="홈 핸디"  pct={pb.sp_bets_home} handle={pb.sp_handle_home} />}
          {pb.sp_bets_away != null && <PctBar label="원정 핸디" pct={pb.sp_bets_away} handle={pb.sp_handle_away} />}
        </>
      )}
      {(pb.ou_bets_over != null || pb.ou_bets_under != null) && (
        <>
          <MarketHeader label="언오버" accent="#1e40af" bg="#dbeafe" />
          {pb.ou_bets_over  != null && <PctBar label="오버" pct={pb.ou_bets_over}  handle={pb.ou_handle_over} />}
          {pb.ou_bets_under != null && <PctBar label="언더" pct={pb.ou_bets_under} handle={pb.ou_handle_under} />}
        </>
      )}
    </div>
  )
}

// ── 베트맨 배당 표 (ML + O/U 기준점 포함, 변동 표시) ──────────
function OddsCompare({ proto }) {
  if (!proto) return null
  const fmt = v => (v != null ? Number(v).toFixed(2) : '–')
  const hasAny = v => v != null

  const sections = []

  // 승무패 / 승패
  const hasMlAllot = proto.ml_allot_home != null || proto.ml_allot_away != null
  if (hasMlAllot) {
    const picks = []
    picks.push({ label: '홈 승',   val: proto.ml_allot_home, open: proto.ml_allot_home_open })
    if (proto.ml_allot_draw != null) picks.push({ label: '무', val: proto.ml_allot_draw, open: proto.ml_allot_draw_open })
    picks.push({ label: '원정 승', val: proto.ml_allot_away, open: proto.ml_allot_away_open })
    sections.push({ title: '승무패', picks })
  }

  // 핸디 (모든 기준점)
  const spLines = (proto.sp_lines || []).filter(l => hasAny(l.allot_home) || hasAny(l.allot_away) || hasAny(l.allot_draw))
  spLines.forEach(l => {
    const base = l.base ? ` ${l.base}` : ''
    const picks = []
    if (hasAny(l.allot_home)) picks.push({ label: '홈',   val: l.allot_home, open: l.allot_home_open })
    if (hasAny(l.allot_draw)) picks.push({ label: '핸무', val: l.allot_draw, open: l.allot_draw_open })
    if (hasAny(l.allot_away)) picks.push({ label: '원정', val: l.allot_away, open: l.allot_away_open })
    sections.push({ title: `핸디${base}`, picks })
  })

  // 언오버 (모든 기준점)
  const ouLines = (proto.ou_lines || []).filter(l => hasAny(l.allot_over) || hasAny(l.allot_under))
  ouLines.forEach(l => {
    const base = l.base ? ` ${l.base}` : ''
    const picks = []
    if (hasAny(l.allot_over))  picks.push({ label: '오버', val: l.allot_over,  open: l.allot_over_open })
    if (hasAny(l.allot_under)) picks.push({ label: '언더', val: l.allot_under, open: l.allot_under_open })
    sections.push({ title: `언오버${base}`, picks })
  })

  if (sections.length === 0) return null

  // 변동 chip (피나클 스타일: 상승 빨강, 하락 초록 — 베팅 관점에서 배당↑ = 상대 약화)
  const DiffChip = ({ val, open }) => {
    if (val == null || open == null) return null
    const diff = parseFloat((Number(val) - Number(open)).toFixed(3))
    if (!Number.isFinite(diff) || Math.abs(diff) < 0.005) return null
    const isUp = diff > 0
    return (
      <span style={{
        fontSize: 9, fontWeight: 700,
        color: isUp ? '#ef4444' : '#10b981',
        marginLeft: 3,
      }}>
        {isUp ? '+' : ''}{diff.toFixed(2)}
      </span>
    )
  }

  return (
    <div className="mt-2 pt-2 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-1.5">베트맨 배당</div>
      <div className="space-y-1">
        {sections.map((sec, si) => (
          <div key={si} className="flex items-center gap-1.5" style={{ fontSize: 11 }}>
            <span style={{ color: '#94a3b8', fontWeight: 600, minWidth: 60 }}>{sec.title}</span>
            <div className="flex gap-1.5 flex-wrap">
              {sec.picks.map((p, pi) => (
                <span key={pi} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ color: '#64748b' }}>{p.label}</span>
                  <span style={{ color: '#f59e0b', fontWeight: 700 }}>{fmt(p.val)}</span>
                  <DiffChip val={p.val} open={p.open} />
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProtoBetting({ proto }) {
  if (!proto) return null

  // sp_lines / ou_lines 중복 제거 (정규화된 base 기준)
  const normBase = b => String(b || '').trim().replace(/\.0+$/, '')
  const dedup = (arr, keyFn) => {
    const seen = new Map()
    for (const l of (arr || [])) {
      const k = keyFn(l)
      if (!seen.has(k)) seen.set(k, l)
      else {
        const existing = seen.get(k)
        for (const f of Object.keys(l)) {
          if (existing[f] == null && l[f] != null) existing[f] = l[f]
        }
      }
    }
    return Array.from(seen.values())
  }
  const spLines = dedup(proto.sp_lines, l => normBase(l.base))
  const ouLines = dedup(proto.ou_lines, l => normBase(l.base))

  const hasMl = proto.ml_bets_home != null || proto.ml_bets_draw != null || proto.ml_bets_away != null
  const hasSp = spLines.length > 0 || proto.sp_bets_home != null || proto.sp_bets_draw != null || proto.sp_bets_away != null
  const hasOu = ouLines.length > 0 || proto.ou_bets_over != null || proto.ou_bets_under != null
  if (!hasMl && !hasSp && !hasOu) return null

  const totalSellLabel = proto.totalSell > 0 ? `총 ${fmtMoney(proto.totalSell)}` : null
  const boxStyle = {
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    background: '#fff1f2',
    border: '1px solid #fecaca',
  }
  const ACCENT = '#9f1239'
  const CHIP_BG = '#ffe4e6'

  return (
    <div style={boxStyle}>
      <div className="flex items-center justify-between mb-2">
        <div style={{ fontSize: 12, fontWeight: 800, color: ACCENT, letterSpacing: 0.3 }}>
          🇰🇷 국내 구매율
        </div>
        {totalSellLabel && <div style={{ fontSize: 10, color: '#e11d48' }}>{totalSellLabel} 판매</div>}
      </div>

      {/* 승무패 */}
      {hasMl && <MarketHeader label="승무패" accent={ACCENT} bg={CHIP_BG} />}
      {proto.ml_bets_home != null && <PctBar label="홈 승"   pct={proto.ml_bets_home} count={proto.ml_bets_home_count} amount={proto.ml_bets_home_amount} odds={proto.ml_allot_home} />}
      {proto.ml_bets_draw != null && <PctBar label="무"       pct={proto.ml_bets_draw} count={proto.ml_bets_draw_count} amount={proto.ml_bets_draw_amount} odds={proto.ml_allot_draw} />}
      {proto.ml_bets_away != null && <PctBar label="원정 승"  pct={proto.ml_bets_away} count={proto.ml_bets_away_count} amount={proto.ml_bets_away_amount} odds={proto.ml_allot_away} />}
      {hasMl && <MarketResult label="승무패" result={proto.ml_result} />}

      {/* 핸디 - 모든 기준점 (sp_lines 있으면 그것만, 없으면 legacy) */}
      {spLines.length > 0
        ? spLines.map((l, i) => (
            <div key={`sp-${i}`}>
              <MarketHeader label={`핸디 ${l.base || ''}`.trim()} accent={ACCENT} bg={CHIP_BG} />
              {l.pct_home != null && <PctBar label="홈 핸디"   pct={l.pct_home} count={l.count_home} amount={l.amount_home} odds={l.allot_home} />}
              {l.pct_draw != null && <PctBar label="핸디 무"   pct={l.pct_draw} count={l.count_draw} amount={l.amount_draw} odds={l.allot_draw} />}
              {l.pct_away != null && <PctBar label="원정 핸디" pct={l.pct_away} count={l.count_away} amount={l.amount_away} odds={l.allot_away} />}
            </div>
          ))
        : (proto.sp_bets_home != null || proto.sp_bets_draw != null || proto.sp_bets_away != null) && (
            <>
              <MarketHeader label="핸디" accent={ACCENT} bg={CHIP_BG} />
              {proto.sp_bets_home != null && <PctBar label="홈 핸디"   pct={proto.sp_bets_home} count={proto.sp_bets_home_count} amount={proto.sp_bets_home_amount} odds={proto.sp_allot_home} />}
              {proto.sp_bets_draw != null && <PctBar label="핸디 무"   pct={proto.sp_bets_draw} count={proto.sp_bets_draw_count} amount={proto.sp_bets_draw_amount} odds={proto.sp_allot_draw} />}
              {proto.sp_bets_away != null && <PctBar label="원정 핸디" pct={proto.sp_bets_away} count={proto.sp_bets_away_count} amount={proto.sp_bets_away_amount} odds={proto.sp_allot_away} />}
            </>
          )
      }
      {hasSp && <MarketResult label="핸디" result={proto.sp_result} base={proto.sp_base} />}

      {/* 언오버 - 모든 기준점 */}
      {ouLines.length > 0
        ? ouLines.map((l, i) => (
            <div key={`ou-${i}`}>
              <MarketHeader label={`언오버 ${l.base || ''}`.trim()} accent={ACCENT} bg={CHIP_BG} />
              {l.pct_over  != null && <PctBar label="오버" pct={l.pct_over}  count={l.count_over}  amount={l.amount_over}  odds={l.allot_over} />}
              {l.pct_under != null && <PctBar label="언더" pct={l.pct_under} count={l.count_under} amount={l.amount_under} odds={l.allot_under} />}
            </div>
          ))
        : (proto.ou_bets_over != null || proto.ou_bets_under != null) && (
            <>
              <MarketHeader label="언오버" accent={ACCENT} bg={CHIP_BG} />
              {proto.ou_bets_over  != null && <PctBar label="오버" pct={proto.ou_bets_over} count={proto.ou_bets_over_count} amount={proto.ou_bets_over_amount} odds={proto.ou_allot_over} />}
              {proto.ou_bets_under != null && <PctBar label="언더" pct={proto.ou_bets_under} count={proto.ou_bets_under_count} amount={proto.ou_bets_under_amount} odds={proto.ou_allot_under} />}
            </>
          )
      }
      {hasOu && <MarketResult label="O/U" result={proto.ou_result} base={proto.ou_base} />}
    </div>
  )
}

// 리그별 시그널 기준 데이터 소스 결정
// - MLB/NBA/NHL: 해외구매율(pb=SBD) 우선
// - 해외 축구 (EPL/EFL/La Liga/Serie A/Bundesliga/Ligue 1/UCL/Europa/Conference/MLS/J리그/A리그): 해외구매율(pb=Excapper) 우선
// - KBO/NPB/K리그1/K리그2: 국내구매율(proto=베트맨) 우선
const FOREIGN_PRIORITY_LEAGUES = new Set([
  'MLB', 'NBA', 'NHL',
  'EPL', 'EFL Championship', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'UCL', 'Europa', 'Conference', 'MLS', 'J리그', 'J리그2', 'A리그',
])

function buildSignalContext(game) {
  const proto = game.protoBetting
  const pb    = game.publicBetting
  const op    = game.opening || {}
  const foreignFirst = FOREIGN_PRIORITY_LEAGUES.has(game.league)
  // 해외 우선 시: pb ?? proto, 국내 우선 시: proto ?? pb
  const pick = (a, b) => foreignFirst ? (a ?? b) : (b ?? a)
  return {
    proto, pb, op,
    mlHome:  pick(pb?.ml_bets_home,  proto?.ml_bets_home),
    mlAway:  pick(pb?.ml_bets_away,  proto?.ml_bets_away),
    mlDraw:  pick(pb?.ml_bets_draw,  proto?.ml_bets_draw),
    spHome:  pick(pb?.sp_bets_home,  proto?.sp_bets_home),
    spAway:  pick(pb?.sp_bets_away,  proto?.sp_bets_away),
    ouOver:  pick(pb?.ou_bets_over,  proto?.ou_bets_over),
    ouUnder: pick(pb?.ou_bets_under, proto?.ou_bets_under),
    // 금액 데이터 (KRW) — 65% 금액 기반 시그널용
    // 해외축구는 pb(Excapper) 우선, 국내리그는 proto(베트맨)
    mlHomeAmt:  pick(pb?.ml_amount_home, proto?.ml_bets_home_amount),
    mlAwayAmt:  pick(pb?.ml_amount_away, proto?.ml_bets_away_amount),
    mlDrawAmt:  pick(pb?.ml_amount_draw, proto?.ml_bets_draw_amount),
    spHomeAmt:  proto?.sp_bets_home_amount,
    spAwayAmt:  proto?.sp_bets_away_amount,
    spDrawAmt:  proto?.sp_bets_draw_amount,
    ouOverAmt:  proto?.ou_bets_over_amount,
    ouUnderAmt: proto?.ou_bets_under_amount,
    bttsYesAmt: pb?.btts_yes_amount,
    bttsNoAmt:  pb?.btts_no_amount,
    bttsYesPct: pb?.btts_yes_pct,
    bttsNoPct:  pb?.btts_no_pct,
  }
}

// ── 메인 시그널 함수 ─────────────────────────────────────────
function pctCandidate(value, market, side, label) {
  const pct = Number(value)
  if (!Number.isFinite(pct)) return null
  return { value: pct, market, side, label }
}

function amountCandidate(pct, amount, market, side, label) {
  const p = Number(pct), a = Number(amount)
  if (!Number.isFinite(p) || !Number.isFinite(a) || a <= 0) return null
  return { value: p, amount: a, market, side, label }
}

function getTopBetCandidate(ctx) {
  // 금액 데이터가 있는 경기는 "최대 금액 픽" + "구매율 65% 이상" 로직
  // 금액 데이터가 없으면 (예: MLB/NBA/NHL — SBD는 % 만) "최대 구매율 70% 이상" 로직
  const amountCandidates = [
    amountCandidate(ctx.mlHome,    ctx.mlHomeAmt,  'ML',    'home',  '홈승'),
    amountCandidate(ctx.mlDraw,    ctx.mlDrawAmt,  'ML',    'draw',  '무승부'),
    amountCandidate(ctx.mlAway,    ctx.mlAwayAmt,  'ML',    'away',  '원정승'),
    amountCandidate(ctx.spHome,    ctx.spHomeAmt,  '핸디',  'home',  '홈핸디'),
    amountCandidate(ctx.spAway,    ctx.spAwayAmt,  '핸디',  'away',  '원정핸디'),
    amountCandidate(ctx.ouOver,    ctx.ouOverAmt,  'O/U',   'over',  '오버'),
    amountCandidate(ctx.ouUnder,   ctx.ouUnderAmt, 'O/U',   'under', '언더'),
    amountCandidate(ctx.bttsYesPct, ctx.bttsYesAmt, 'BTTS', 'yes',   '예'),
    amountCandidate(ctx.bttsNoPct,  ctx.bttsNoAmt,  'BTTS', 'no',    '아니오'),
  ].filter(Boolean)

  if (amountCandidates.length > 0) {
    const topByAmount = amountCandidates.reduce((best, cur) => cur.amount > best.amount ? cur : best, amountCandidates[0])
    if (topByAmount.value < 65) return null   // 최대 금액 픽의 구매율이 65% 미만이면 시그널 없음
    return topByAmount
  }

  // Fallback: 금액 데이터 없음 → 기존 % 70% 기반 (MLB/NBA/NHL)
  const candidates = [
    pctCandidate(ctx.mlHome, 'ML', 'home', '홈승'),
    pctCandidate(ctx.mlDraw, 'ML', 'draw', '무승부'),
    pctCandidate(ctx.mlAway, 'ML', 'away', '원정승'),
    pctCandidate(ctx.spHome, '핸디', 'home', '홈핸디'),
    pctCandidate(ctx.spAway, '핸디', 'away', '원정핸디'),
    pctCandidate(ctx.ouOver, 'O/U', 'over', '오버'),
    pctCandidate(ctx.ouUnder, 'O/U', 'under', '언더'),
  ].filter(Boolean)

  if (candidates.length === 0) return null
  const top = candidates.reduce((best, cur) => cur.value > best.value ? cur : best, candidates[0])
  if (top.value < 70) return null
  return top
}

function makeBuyReverseSignal(candidate, market, pick, reason) {
  // 금액 기반이면 라벨에 금액 표시
  const amountStr = candidate.amount != null
    ? ` (${fmtMoney(candidate.amount)})`
    : ''
  return {
    type: 'REVERSE',
    market,
    pick,
    strength: candidate.amount != null ? '금액 역방향' : '구매율 역방향',
    score: candidate.value,
    publicSide: `${candidate.label} ${candidate.value}%${amountStr}`,
    reason,
  }
}

function getFavoriteSide(game, ctx) {
  const homeOdds = game.ml_home ?? ctx.op.ml_home
  const awayOdds = game.ml_away ?? ctx.op.ml_away
  if (homeOdds == null || awayOdds == null || homeOdds === awayOdds) return null
  return homeOdds < awayOdds ? 'home' : 'away'
}

function mapTopBetToSignals(game, ctx, candidate) {
  const signals = []
  if (!candidate) return signals

  const favoriteSide = getFavoriteSide(game, ctx)
  const isSoccerLike = game.sport === 'soccer' || game.sport === 'hockey'
  const favoritePick = favoriteSide === 'home' ? '홈 승' : favoriteSide === 'away' ? '원정 승' : null
  const dogSide = favoriteSide === 'home' ? 'away' : favoriteSide === 'away' ? 'home' : null
  const dogMlPick = dogSide === 'home' ? '홈 승' : dogSide === 'away' ? '원정 승' : null
  const dogHandicapPick = dogSide === 'home' ? '홈 플핸' : dogSide === 'away' ? '원정 플핸' : null

  if (candidate.market === 'O/U') {
    signals.push(makeBuyReverseSignal(candidate, 'O/U', candidate.side === 'over' ? '언더' : '오버', '경기 내 최고 금액 반대'))
    return signals
  }

  if (candidate.market === '핸디') {
    signals.push(makeBuyReverseSignal(candidate, '핸디', candidate.side === 'home' ? '원정 핸디' : '홈 핸디', '경기 내 최고 금액 반대'))
    return signals
  }

  if (candidate.market === 'BTTS') {
    signals.push(makeBuyReverseSignal(candidate, 'BTTS', candidate.side === 'yes' ? '아니오 (No)' : '예 (Yes)', '경기 내 최고 금액 반대'))
    return signals
  }

  if (candidate.market !== 'ML') return signals

  if (isSoccerLike) {
    if (candidate.side === 'draw') {
      if (favoritePick) signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '무승부 최고 구매율 -> 정배 승'))
      return signals
    }

    if (candidate.side === favoriteSide) {
      if (dogHandicapPick) signals.push(makeBuyReverseSignal(candidate, '핸디', dogHandicapPick, '정배 최고 구매율 -> 상대 플핸'))
      return signals
    }

    if (favoritePick) signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '역배 최고 구매율 -> 정배 승'))
    return signals
  }

  if (candidate.side === favoriteSide && dogMlPick) {
    signals.push(makeBuyReverseSignal(candidate, 'ML', dogMlPick, '정배 최고 구매율 -> 역배 승'))
    if (dogHandicapPick) signals.push(makeBuyReverseSignal(candidate, '핸디', dogHandicapPick, '정배 최고 구매율 -> 역배 플핸'))
    return signals
  }

  if (candidate.side === 'home') {
    signals.push(makeBuyReverseSignal(candidate, 'ML', '원정 승', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.side === 'away') {
    signals.push(makeBuyReverseSignal(candidate, 'ML', '홈 승', '경기 내 최고 구매율 반대'))
    return signals
  }

  if (candidate.side === 'draw' && favoritePick) {
    signals.push(makeBuyReverseSignal(candidate, 'ML', favoritePick, '무승부 최고 구매율 -> 정배 승'))
  }

  return signals
}

// MLB/NBA/NHL 전용: 해외구매율(pb=SBD)만 사용 + 80% 이상 + 배당 > 1.4
const FOREIGN_ONLY_LEAGUES = new Set(['MLB', 'NBA', 'NHL'])

function foreignOnlyReverseSignals(game, ctx) {
  const pb = ctx.pb
  if (!pb) return []

  const candidates = []
  const push = (market, side, value, odds, label) => {
    if (Number.isFinite(value) && value >= 80) {
      candidates.push({ market, side, value, odds, label })
    }
  }
  push('ML',   'home',  Number(pb.ml_bets_home),  game.ml_home,  '홈')
  push('ML',   'away',  Number(pb.ml_bets_away),  game.ml_away,  '원정')
  push('핸디', 'home',  Number(pb.sp_bets_home),  game.sp_home,  '홈핸디')
  push('핸디', 'away',  Number(pb.sp_bets_away),  game.sp_away,  '원정핸디')
  push('O/U',  'over',  Number(pb.ou_bets_over),  game.ou_over,  '오버')
  push('O/U',  'under', Number(pb.ou_bets_under), game.ou_under, '언더')

  if (candidates.length === 0) return []

  const top = candidates.reduce((best, cur) => cur.value > best.value ? cur : best, candidates[0])

  // 배당 ≤ 1.4면 강정배 보호 — 시그널 없음
  if (top.odds == null || !Number.isFinite(top.odds) || top.odds <= 1.4) return []

  const reasonText = `해외구매율 ${top.value}% (배당 ${top.odds.toFixed(2)})`
  const sigBase = {
    type: 'REVERSE',
    strength: '해외구매율 역방향',
    score: top.value,
    publicSide: `${top.label} ${top.value}%`,
    reason: reasonText,
  }

  if (top.market === 'O/U') {
    return [{ ...sigBase, market: 'O/U', pick: top.side === 'over' ? '언더' : '오버' }]
  }
  if (top.market === '핸디') {
    return [{ ...sigBase, market: '핸디', pick: top.side === 'home' ? '원정 핸디' : '홈 핸디' }]
  }
  // ML: 반대팀 ML + 반대팀 플핸 둘 다
  const dogMlPick = top.side === 'home' ? '원정 승' : '홈 승'
  const dogHandicapPick = top.side === 'home' ? '원정 플핸' : '홈 플핸'
  return [
    { ...sigBase, market: 'ML',   pick: dogMlPick },
    { ...sigBase, market: '핸디', pick: dogHandicapPick },
  ]
}

function publicBetReverseSignals(game, ctx) {
  // MLB / NBA / NHL은 해외구매율 전용 룰
  if (FOREIGN_ONLY_LEAGUES.has(game.league)) {
    return foreignOnlyReverseSignals(game, ctx)
  }
  return mapTopBetToSignals(game, ctx, getTopBetCandidate(ctx))
}

function reverseSignals(game) {
  try {
    return _reverseSignals(game)
  } catch (e) {
    console.error('[reverseSignals] crash for', game?.matchup_id, e)
    return []
  }
}

// 시그널 표시 윈도우 (몇 시간 전부터 보일지)
// - 기본: 게임 시작 2시간 전
// - 00:00 ~ 06:00 KST 시작 게임 (한국 새벽 시간대 = 유럽 저녁 경기): 전날 22:00 KST 부터 표시
function signalWindowHours(starts_at) {
  if (!starts_at) return 2
  const m = String(starts_at).match(/(\d{2}):(\d{2})/)
  if (!m) return 2
  const gameMin = parseInt(m[1]) * 60 + parseInt(m[2])  // 분 단위
  // 00:00 (0분) <= 게임시작 <= 06:00 (360분) → 전날 22:00 부터
  if (gameMin >= 0 && gameMin <= 360) {
    // 전날 22:00 = 게임시각보다 (gameMin + 120)분 전
    return (gameMin + 120) / 60
  }
  return 2
}

function _reverseSignals(game) {
  // 경기 시작 시간대 따라 시그널 표시 윈도우 결정
  const h = hoursUntil(game.starts_at)
  const maxWindow = signalWindowHours(game.starts_at)
  if (h == null || h > maxWindow || h < 0) return []
  const ctx = buildSignalContext(game)
  const sigs = publicBetReverseSignals(game, ctx)
  // 디버그: 축구 게임의 시그널 계산 결과 (window.debugSignals=true로 활성화)
  if (typeof window !== 'undefined' && window.debugSignals && game.sport === 'soccer') {
    console.log('[signal]', game.home, 'vs', game.away, '|', game.league)
    console.log('  pb:', game.publicBetting ? 'YES' : 'NO', 'proto:', game.protoBetting ? 'YES' : 'NO')
    console.log('  ctx amounts:', { mlH: ctx.mlHomeAmt, mlD: ctx.mlDrawAmt, mlA: ctx.mlAwayAmt, bttsY: ctx.bttsYesAmt, bttsN: ctx.bttsNoAmt })
    console.log('  ctx pcts:', { mlH: ctx.mlHome, mlD: ctx.mlDraw, mlA: ctx.mlAway, bttsY: ctx.bttsYesPct, bttsN: ctx.bttsNoPct })
    console.log('  signals:', sigs)
  }
  return sigs
}
// 브라우저 콘솔에서 window.debugSignals = true 후 새로고침하면 시그널 디버그 로그 출력

function ReverseSignals({ signals, game }) {
  if (!signals || signals.length === 0) return null
  const sorted = [...signals].sort((a, b) => b.score - a.score)
  return (
    <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="text-xs font-semibold text-slate-400 tracking-wide mb-2">시그널</div>
      <div className="flex gap-2 flex-wrap">
        {sorted.map((s, i) => {
          const isFollow   = s.type === 'FOLLOW'
          const isValueDog = s.type === 'VALUE_DOG'
          const bgClass    = isFollow ? 'bg-emerald-50 border-emerald-100' : isValueDog ? 'bg-amber-50 border-amber-100' : 'bg-violet-50 border-violet-100'
          const pickClass  = isFollow ? 'text-emerald-800' : isValueDog ? 'text-amber-800' : 'text-violet-800'
          return (
            <div key={i} className={`rounded-xl px-3 py-2 border ${bgClass}`}>
              <div className={`text-sm font-bold ${pickClass}`}>
                {formatSignalPick(game, s)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 시그널 픽 → 깔끔한 표시 문자열 ("볼티모어 +1.5 핸승" 같은 형식)
function formatSignalPick(game, signal) {
  if (!signal) return ''
  if (signal.market === '핸디') {
    const sp = game?.sp_pts
    const isHome = signal.pick.includes('홈')
    const team = isHome ? game?.home : game?.away
    if (sp == null || !team) return signal.pick
    const points = isHome ? sp : -sp
    const sign = points > 0 ? '+' : ''
    return `${team} ${sign}${points} 핸승`
  }
  if (signal.market === 'ML') {
    if (signal.pick.includes('무')) return '무승부'
    const isHome = signal.pick.includes('홈') && !signal.pick.includes('원정')
    const team = isHome ? game?.home : game?.away
    return team ? `${team} 승` : signal.pick
  }
  if (signal.market === 'O/U') {
    const ouPts = game?.ou_pts
    const isOver = signal.pick.includes('오버')
    return `${isOver ? '오버' : '언더'}${ouPts != null ? ` ${ouPts}` : ''}`
  }
  if (signal.market === 'BTTS') {
    return signal.pick.includes('예') ? '양팀득점 Yes' : '양팀득점 No'
  }
  return signal.pick
}

// ── 역추세 픽의 배당 추출 ─────────────────────────────────────
function getPickOdds(game, signal) {
  const op  = game.opening || {}
  const val = (cur, open) => cur ?? open
  if (signal.market === 'ML') {
    if (signal.pick.includes('홈') && !signal.pick.includes('원정')) return val(game.ml_home, op.ml_home)
    if (signal.pick.includes('원정')) return val(game.ml_away, op.ml_away)
    if (signal.pick.includes('무'))   return val(game.ml_draw, op.ml_draw)
  }
  if (signal.market === '핸디') {
    if (signal.pick.includes('홈'))   return val(game.sp_home, op.sp_home)
    if (signal.pick.includes('원정')) return val(game.sp_away, op.sp_away)
  }
  if (signal.market === 'O/U') {
    if (signal.pick.includes('오버')) return val(game.ou_over,  op.ou_over)
    if (signal.pick.includes('언더')) return val(game.ou_under, op.ou_under)
  }
  return null
}

// ── 픽 중복 제거 + 핸디↔ML 변환 ─────────────────────────────
function consolidatePicks(rawPicks) {
  const byGame = {}
  for (const pick of rawPicks) {
    const id = pick.game.matchup_id
    if (!byGame[id]) byGame[id] = []
    byGame[id].push(pick)
  }

  const result  = []
  const usedKey = new Set()

  for (const gamePicks of Object.values(byGame)) {
    const game   = gamePicks[0].game
    const op     = game.opening || {}
    const sp_pts = game.sp_pts ?? op.sp_pts

    const mlPicks = gamePicks.filter(p => p.signal.market === 'ML')
    const spPicks = gamePicks.filter(p => p.signal.market === '핸디')
    const ouPicks = gamePicks.filter(p => p.signal.market === 'O/U')

    for (const pick of mlPicks) {
      const { signal } = pick
      const isHome = signal.pick.includes('홈') && !signal.pick.includes('원정')
      const isDraw = !signal.pick.includes('홈') && !signal.pick.includes('원정') && signal.pick.includes('무')
      const key = isDraw ? `${game.matchup_id}_draw`
        : `${game.matchup_id}_${isHome ? 'home' : 'away'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)
      result.push(pick)
    }

    for (const pick of spPicks) {
      const { signal } = pick
      const isHome = signal.pick.includes('홈')
      const key    = `${game.matchup_id}_${isHome ? 'home' : 'away'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)

      const teamHandi = isHome ? sp_pts : (sp_pts != null ? -sp_pts : null)
      if (teamHandi != null && teamHandi > 0) {
        result.push(pick)
      } else {
        const mlPickLabel = isHome ? '홈 승' : '원정 승'
        const mlOdds      = isHome ? (game.ml_home ?? op.ml_home) : (game.ml_away ?? op.ml_away)
        result.push({ game, signal: { ...signal, market: 'ML', pick: mlPickLabel }, odds: mlOdds })
      }
    }

    for (const pick of ouPicks) {
      const { signal } = pick
      const key = `${game.matchup_id}_${signal.pick.includes('오버') ? 'over' : 'under'}`
      if (usedKey.has(key)) continue
      usedKey.add(key)
      result.push(pick)
    }
  }

  return result
}

function SignalView({ games, hasAccess, onShowUpgrade, isGuest = false }) {
  const allPicks = useMemo(() => {
    const raw = []
    for (const game of games) {
      if (isInPast(game.starts_at)) continue
      for (const sig of reverseSignals(game)) {
        raw.push({ game, signal: sig, odds: getPickOdds(game, sig) })
      }
    }
    return raw.sort((a, b) => (a.game.starts_at > b.game.starts_at ? 1 : -1))
  }, [games])

  if (!hasAccess) return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" className="text-slate-400">
          <rect x="3" y="11" width="18" height="11" rx="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
      </div>
      <div className="text-sm text-slate-500 text-center">
        {isGuest ? '로그인 후 시그널 픽을 볼 수 있습니다' : '구독 후 시그널 픽을 볼 수 있습니다'}
      </div>
      <button onClick={onShowUpgrade}
        className="text-sm font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 px-5 py-2 rounded-full">
        {isGuest ? '로그인' : '잠금 해제'}
      </button>
    </div>
  )

  if (allPicks.length === 0)
    return (
      <div className="text-center py-20">
        <div className="text-slate-300 text-4xl mb-3">—</div>
        <div className="text-slate-400 text-sm">현재 시그널 없음</div>
      </div>
    )

  return (
    <div className="space-y-3">
      {allPicks.map((pick, i) => {
        const { game, signal, odds } = pick
        const flag     = LEAGUE_FLAGS[game.league] || '🏟'
        const isFollow = signal.type === 'FOLLOW'
        const h        = hoursUntil(game.starts_at)
        const urgent   = h != null && h <= 1

        return (
          <div key={i} className={`bg-white rounded-2xl p-4 border shadow-sm ${
            urgent ? 'border-indigo-200' : 'border-slate-100'
          }`}>
            {/* 리그 + 시간 */}
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
                {flag} {game.league}
              </span>
              <div className="flex items-center gap-1.5">
                {urgent && (
                  <span className="text-xs font-semibold text-rose-500 bg-rose-50 px-2 py-0.5 rounded-full">
                    {h < 0 ? '진행중' : `${Math.round(h * 60)}분 후`}
                  </span>
                )}
                <span className="text-[12px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md">📅 {game.starts_at?.replace(' KST','')}</span>
              </div>
            </div>

            {/* 팀명 */}
            <div className="text-sm font-bold text-slate-900 mb-2.5">
              {game.home} <span className="text-slate-300 font-normal">vs</span> {game.away}
            </div>

            {/* 시그널 */}
            <div className={`rounded-xl px-3 py-2.5 flex items-center justify-between border ${
              isFollow ? 'bg-emerald-50 border-emerald-100' : 'bg-violet-50 border-violet-100'
            }`}>
              <div className={`text-base font-bold ${isFollow ? 'text-emerald-800' : 'text-violet-800'}`}>
                {formatSignalPick(game, signal)}
              </div>
              {odds != null && (
                <div className="text-right ml-4 shrink-0">
                  <div className="text-xs text-slate-400 mb-0.5">배당</div>
                  <div className="text-2xl font-bold text-slate-900">{odds.toFixed(2)}</div>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 베트맨 배당 박스 (한국 사이트) ────────────────────
// ── 피나클 픽 박스 (AddPickFlow 전용) — 피나클 배당 기반, 24/7 작동 ──
function PinnaclePickBox({ game, onPickTap, isSelected }) {
  const isSoccer = game.sport === 'soccer'
  const mlHome = game.ml_home
  const mlDraw = game.ml_draw
  const mlAway = game.ml_away
  const spHome = game.sp_home
  const spAway = game.sp_away
  const spPts  = game.sp_pts
  const ouOver = game.ou_over
  const ouUnder = game.ou_under
  const ouPts  = game.ou_pts

  const hasML = mlHome != null || mlAway != null
  const hasSP = spPts != null && (spHome != null || spAway != null)
  const hasOU = ouPts != null && (ouOver != null || ouUnder != null)
  if (!hasML && !hasSP && !hasOU) return null

  const requestPick = (market, pick, pickLabel, odds) => {
    if (onPickTap) onPickTap(game, market, pick, pickLabel, odds)
    else openPickModal({ game, market, pick, pickLabel, odds })
  }
  const sel = (market, pick) => isSelected ? isSelected(market, pick) : false

  return (
    <div className="mb-3 p-2.5 rounded-xl bg-indigo-50/40 dark:bg-indigo-950/20 border border-indigo-200/60 dark:border-indigo-900/40">
      <div className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 mb-2">
        🌐 피나클 배당
      </div>
      {hasML && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label="홈"   value={mlHome}
            pickable selected={sel('ml','home')} onPick={() => requestPick('ml', 'home', '홈 승', mlHome)} />
          {isSoccer && mlDraw != null && <OddsTag label="무" value={mlDraw}
            pickable selected={sel('ml','draw')} onPick={() => requestPick('ml', 'draw', '무승부', mlDraw)} />}
          <OddsTag label="원정" value={mlAway}
            pickable selected={sel('ml','away')} onPick={() => requestPick('ml', 'away', '원정 승', mlAway)} />
        </div>
      )}
      {hasSP && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label={`홈 ${spPts >= 0 ? '+' : ''}${spPts}`} value={spHome}
            pickable selected={sel('sp','home')} onPick={() => requestPick('sp', 'home', `홈 ${spPts >= 0 ? '+' : ''}${spPts}`, spHome)} />
          <OddsTag label={`원정 ${(-spPts) >= 0 ? '+' : ''}${-spPts}`} value={spAway}
            pickable selected={sel('sp','away')} onPick={() => requestPick('sp', 'away', `원정 ${(-spPts) >= 0 ? '+' : ''}${-spPts}`, spAway)} />
        </div>
      )}
      {hasOU && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${ouPts}`}  value={ouOver}
            pickable selected={sel('ou','over')}  onPick={() => requestPick('ou', 'over',  `오버 ${ouPts}`,  ouOver)} />
          <OddsTag label={`언더 ${ouPts}`}  value={ouUnder}
            pickable selected={sel('ou','under')} onPick={() => requestPick('ou', 'under', `언더 ${ouPts}`, ouUnder)} />
        </div>
      )}
    </div>
  )
}

function BetmanBox({ game, pickable: pickableProp = false, onPickTap, isSelected }) {
  const proto = game.protoBetting
  if (!proto) return null
  const isSoccer = game.sport === 'soccer'

  const mlHome = proto.ml_allot_home
  const mlAway = proto.ml_allot_away
  const mlDraw = proto.ml_allot_draw
  const spHome = proto.sp_allot_home
  const spDraw = proto.sp_allot_draw
  const spAway = proto.sp_allot_away
  const spBase = proto.sp_base
  const ouOver = proto.ou_allot_over
  const ouUnder = proto.ou_allot_under
  const ouBase = proto.ou_base

  // 베트맨 결과 (있을 때만 색칠)
  const mlRes = proto.ml_result   // "홈" | "무" | "원정"
  const spRes = proto.sp_result   // "홈" | "무(핸무)" | "원정"
  const ouRes = proto.ou_result   // "오버" | "언더" (드물게 "무")

  // 결과 매칭 헬퍼: 픽이 결과랑 같으면 true, 다른 픽 있고 결과 있으면 false, 결과 없으면 null
  const matchRes = (pickLabel, resultStr) => {
    if (!resultStr) return null
    return resultStr.includes(pickLabel) ? true : false
  }

  const hasML = mlHome != null || mlAway != null
  const hasSP = spBase != null && (spHome != null || spAway != null)
  const hasOU = ouBase != null && (ouOver != null || ouUnder != null)

  if (!hasML && !hasSP && !hasOU) return null

  // 경기 시작 전 + 결과 없을 때만 픽 저장 가능
  const startsAt = game.starts_at ? new Date(game.starts_at).getTime() : 0
  const isUpcoming = startsAt === 0 || startsAt > Date.now()
  const canPickHere = pickableProp && isUpcoming
  const requestPick = (market, pick, pickLabel, odds) => {
    if (onPickTap) onPickTap(game, market, pick, pickLabel, odds)
    else openPickModal({ game, market, pick, pickLabel, odds })
  }
  const sel = (market, pick) => isSelected ? isSelected(market, pick) : false

  return (
    <div className="mb-3 p-2.5 rounded-xl bg-rose-50/40 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40">
      <div className="text-[11px] font-bold text-rose-600 dark:text-rose-400 mb-2 flex items-center gap-1 flex-wrap">
        🇰🇷 베트맨 배당
        {proto.mch_score && (
          <span className="ml-auto text-[11px] font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-900/60">
            🏆 {proto.mch_score}
          </span>
        )}
        {(mlRes || spRes || ouRes) && !proto.mch_score && (
          <span className="ml-auto text-[10px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
            경기 종료
          </span>
        )}
      </div>
      {hasML && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label="홈"   value={mlHome} result={matchRes('홈', mlRes)}
            pickable={canPickHere} selected={sel('ml','home')} onPick={() => requestPick('ml', 'home', '홈 승', mlHome)} />
          {isSoccer && mlDraw != null && <OddsTag label="무" value={mlDraw} result={matchRes('무', mlRes)}
            pickable={canPickHere} selected={sel('ml','draw')} onPick={() => requestPick('ml', 'draw', '무승부', mlDraw)} />}
          <OddsTag label="원정" value={mlAway} result={matchRes('원정', mlRes)}
            pickable={canPickHere} selected={sel('ml','away')} onPick={() => requestPick('ml', 'away', '원정 승', mlAway)} />
        </div>
      )}
      {hasSP && (
        <div className="flex gap-1.5 mb-1.5">
          <OddsTag label={`핸승 ${spBase}`} value={spHome} result={matchRes('홈', spRes)}
            pickable={canPickHere} selected={sel('sp','home')} onPick={() => requestPick('sp', 'home', `핸승 ${spBase}`, spHome)} />
          {isSoccer && spDraw != null && <OddsTag label="핸무" value={spDraw} result={matchRes('무', spRes)}
            pickable={canPickHere} selected={sel('sp','draw')} onPick={() => requestPick('sp', 'draw', `핸무 ${spBase}`, spDraw)} />}
          <OddsTag label={`핸패 -${spBase}`} value={spAway} result={matchRes('원정', spRes)}
            pickable={canPickHere} selected={sel('sp','away')} onPick={() => requestPick('sp', 'away', `핸패 -${spBase}`, spAway)} />
        </div>
      )}
      {hasOU && (
        <div className="flex gap-1.5">
          <OddsTag label={`오버 ${ouBase}`}  value={ouOver}  result={matchRes('오버', ouRes)}
            pickable={canPickHere} selected={sel('ou','over')} onPick={() => requestPick('ou', 'over', `오버 ${ouBase}`, ouOver)} />
          <OddsTag label={`언더 ${ouBase}`}  value={ouUnder} result={matchRes('언더', ouRes)}
            pickable={canPickHere} selected={sel('ou','under')} onPick={() => requestPick('ou', 'under', `언더 ${ouBase}`, ouUnder)} />
        </div>
      )}
    </div>
  )
}

// ── 핀나클 배당 박스 (글로벌 분석) ────────────────────
function PinnacleBox({ game, collapsedByDefault = false }) {
  // 사용자 수동 토글 우선, 없으면 prop 따라감
  const [userOverride, setUserOverride] = useState(null)
  const collapsed = userOverride !== null ? userOverride : collapsedByDefault
  const setCollapsed = (next) => setUserOverride(typeof next === 'function' ? next(collapsed) : next)
  const isSoccer = game.sport === 'soccer'
  const op = game.opening || {}

  const mlHome  = game.ml_home  ?? op.ml_home
  const mlAway  = game.ml_away  ?? op.ml_away
  const mlDraw  = game.ml_draw  ?? op.ml_draw
  const spHome  = game.sp_home  ?? op.sp_home
  const spAway  = game.sp_away  ?? op.sp_away
  const ouOver  = game.ou_over  ?? op.ou_over
  const ouUnder = game.ou_under ?? op.ou_under
  const spPts   = game.sp_pts   ?? op.sp_pts
  const ouPts   = game.ou_pts   ?? op.ou_pts

  if (mlHome == null && mlAway == null && spPts == null && ouPts == null) return null

  return (
    <div className="mb-3 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 overflow-hidden">
      <button
        onClick={(e) => { e.stopPropagation(); haptic.light(); setCollapsed(c => !c) }}
        className="w-full px-2.5 py-2 flex items-center gap-1 active:bg-slate-100 dark:active:bg-slate-700 transition-colors">
        <span className="text-[11px] font-bold text-slate-600 dark:text-slate-400">🌍 해외 배당</span>
        <span className={`ml-auto text-slate-400 dark:text-slate-500 text-xs transition-transform ${collapsed ? '' : 'rotate-180'}`}>▼</span>
      </button>
      {!collapsed && (
        <div className="px-2.5 pb-2.5 fade-in">
          <div className="flex gap-1.5 mb-1.5">
            <OddsTag label="홈" value={mlHome} openValue={game.ml_home != null ? op.ml_home : null} />
            {isSoccer && mlDraw && <OddsTag label="무" value={mlDraw} openValue={game.ml_draw != null ? op.ml_draw : null} />}
            <OddsTag label="원정" value={mlAway} openValue={game.ml_away != null ? op.ml_away : null} />
          </div>
          {spPts != null && (
            <div className="flex gap-1.5 mb-1.5">
              <OddsTag label={`홈 ${spPts >= 0 ? '+' : ''}${spPts}`} value={spHome} openValue={game.sp_home != null ? op.sp_home : null} />
              <OddsTag label={`원정 ${(-spPts) >= 0 ? '+' : ''}${-spPts}`} value={spAway} openValue={game.sp_away != null ? op.sp_away : null} />
            </div>
          )}
          {ouPts != null && (
            <div className="flex gap-1.5">
              <OddsTag label={`오버 ${ouPts}`} value={ouOver} openValue={game.ou_over != null ? op.ou_over : null} />
              <OddsTag label={`언더 ${ouPts}`} value={ouUnder} openValue={game.ou_under != null ? op.ou_under : null} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GameCard({ game, onClick, hasAccess, onShowUpgrade, pbRank, isGuest = false }) {
  const flag     = LEAGUE_FLAGS[game.league] || '🏟'
  const isSoccer = game.sport === 'soccer'
  const op       = game.opening || {}

  const revSigs = reverseSignals(game)
  const hasPick = (market, side) => revSigs.some(s => s.market === market && s.pick.includes(side))
  const mlHomeHL  = hasAccess && hasPick('ML', '홈') ? 'blue' : null
  const mlAwayHL  = hasAccess && hasPick('ML', '원정') ? 'blue' : null
  const spHomeHL  = hasAccess && hasPick('핸디', '홈') ? 'blue' : null
  const spAwayHL  = hasAccess && hasPick('핸디', '원정') ? 'blue' : null
  const ouOverHL  = hasAccess && hasPick('O/U', '오버') ? 'blue' : null
  const ouUnderHL = hasAccess && hasPick('O/U', '언더') ? 'blue' : null

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
    <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 mb-3 border border-slate-100 dark:border-slate-800 shadow-sm cursor-pointer active:scale-[0.98] active:opacity-90 transition-all"
      onClick={hasAccess ? onClick : onShowUpgrade}>

      {/* 리그 + 시간 */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <span className="text-[13px] font-bold text-indigo-700 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-950/50 px-3 py-1.5 rounded-full whitespace-nowrap">
          {flag} {game.league}
        </span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="whitespace-nowrap text-[13px] font-bold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-full">
            {game.starts_at?.replace(' KST','')}
          </span>
          {minsAgo(game.ts) && (
            <span className="whitespace-nowrap text-[10px] text-slate-400">{minsAgo(game.ts)} 기준</span>
          )}
        </div>
      </div>

      {/* 기준점 변동 배지 */}
      <SharpBadge alerts={game.recentAlerts} game={game} />

      {/* 팀명 */}
      <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-0">
        <span className="text-slate-900 dark:text-slate-100 font-extrabold text-[20px] leading-tight break-keep">{game.home}</span>
        <span className="text-slate-300 dark:text-slate-600 text-sm font-normal">vs</span>
        <span className="text-slate-900 dark:text-slate-100 font-extrabold text-[20px] leading-tight break-keep">{game.away}</span>
      </div>

      {hasAccess ? (
        <>
          {/* 1. 베트맨 배당 박스 (한국, 위) */}
          <BetmanBox game={game} />

          {/* 2. 핀나클 배당 박스 (글로벌, 아래) - 베트맨 있으면 접힘, 없으면 펼침 */}
          <PinnacleBox game={game} collapsedByDefault={!!(game.protoBetting && (
            game.protoBetting.ml_allot_home != null ||
            game.protoBetting.ml_allot_away != null ||
            game.protoBetting.sp_allot_home != null ||
            game.protoBetting.ou_allot_over != null
          ))} />

          {/* 3. 국내 구매율 */}
          <ProtoBetting proto={game.protoBetting} />

          {/* 4. 해외 구매율 */}
          <PublicBetting pb={game.publicBetting} isSoccer={isSoccer} pbRank={pbRank} />

          {/* 시그널 */}
          <ReverseSignals signals={reverseSignals(game)} game={game} />
        </>
      ) : (
        <LockBox onUnlock={onShowUpgrade} isGuest={isGuest} />
      )}
    </div>
  )
}

// ── 바카라 탭 (sharpsignal.cloud 완전 동일) ─────────────────
const BACCARAT_API  = 'https://sharpsignal.cloud/api/public/state'
const BAC_WILSON_Z  = 1.645
const BAC_MIN_REL   = 10

// ── dashboard.js / room.js roadItems 로직 그대로 ──
function bacRoadItems(values, rows = 6, tieAsSlash = false) {
  const items = []
  const tieCounts = new Map()
  let lastMain = '', col = 0, row = 0, streakStartCol = 0, lastKey = ''

  values.forEach(value => {
    if (!value) return
    if (tieAsSlash && value === 'T') {
      if (lastKey) tieCounts.set(lastKey, (tieCounts.get(lastKey) || 0) + 1)
      return
    }
    if (!lastMain) {
      lastMain = value; col = 0; row = 0; streakStartCol = 0
    } else if (value === lastMain && row < rows - 1) {
      row += 1
    } else if (value === lastMain) {
      col += 1
    } else {
      col = streakStartCol + 1; row = 0; streakStartCol = col; lastMain = value
    }
    lastKey = `${col}:${row}`
    items.push({ value, col, row, tieCount: 0 })
  })
  items.forEach(item => { item.tieCount = tieCounts.get(`${item.col}:${item.row}`) || 0 })
  return items
}

// ── 도로 차트 컴포넌트 (웹사이트 road-chart CSS 동일) ──
function BacRoadChart({ shoeStr, compact = false }) {
  const rows     = 6
  const minCols  = compact ? 14 : 32
  const maxVals  = compact ? 42 : 300
  const cellSize = compact ? 19 : 28
  const scrollRef = useRef(null)

  const values = [...String(shoeStr || '').toUpperCase()]
    .filter(v => ['P','B','T'].includes(v))
    .slice(-maxVals)

  const counts = values.reduce((a, v) => { a[v] = (a[v]||0)+1; return a }, { P:0, B:0, T:0 })
  const items  = bacRoadItems(values, rows, true) // tieAsSlash=true

  const maxCol     = Math.max(minCols - 1, ...items.map(i => i.col), 0)
  const visibleCols = Math.max(minCols, maxCol + 1)
  const firstCol   = Math.max(0, visibleCols - minCols)
  const shown      = items.filter(i => i.col >= firstCol)

  // 새 데이터 올 때마다 오른쪽 끝으로 자동 스크롤
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
    }
  })

  const gridW = minCols * cellSize
  const gridH = rows  * cellSize

  // 각 마크의 색
  function markBg(v) {
    if (v === 'B') return 'linear-gradient(145deg,#fb7185 0%,#ef4444 56%,#b91c1c 100%)'
    if (v === 'P') return 'linear-gradient(145deg,#60a5fa 0%,#2563eb 58%,#1d4ed8 100%)'
    return 'linear-gradient(145deg,#34d399 0%,#16a34a 60%,#15803d 100%)'
  }

  return (
    <div>
      {/* 요약 */}
      <div style={{ display:'flex', gap: compact ? 10 : 20, marginBottom: compact ? 4 : 10, flexWrap:'wrap' }}>
        <span style={{ color:'#94a3b8', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}># {values.length}</span>
        <span style={{ color:'#2563eb', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>P <b>{counts.P}</b></span>
        <span style={{ color:'#dc2626', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>B <b>{counts.B}</b></span>
        <span style={{ color:'#16a34a', fontWeight:700, fontSize: compact ? '0.7rem' : '0.85rem' }}>T <b>{counts.T}</b></span>
      </div>
      {/* 그리드 */}
      <div ref={scrollRef} style={{ overflowX:'auto', borderRadius:8, border:'1px solid #e2e8f0' }}>
        <div style={{
          position:'relative', display:'grid',
          gridTemplateColumns:`repeat(${minCols},${cellSize}px)`,
          gridTemplateRows:`repeat(${rows},${cellSize}px)`,
          width: gridW, height: gridH,
          background:'#ffffff',
          backgroundImage:`linear-gradient(to right,rgba(100,116,139,0.15) 1px,transparent 1px),linear-gradient(to bottom,rgba(100,116,139,0.15) 1px,transparent 1px)`,
          backgroundSize:`${cellSize}px ${cellSize}px`,
        }}>
          {Array.from({ length: rows * minCols }).map((_, i) => (
            <div key={i} style={{ width:cellSize, height:cellSize }} />
          ))}
          {shown.map((item, i) => {
            const sc = item.col - firstCol
            const sz = cellSize - 5
            return (
              <div key={i} style={{
                position:'absolute',
                left: sc * cellSize + 2,
                top:  item.row * cellSize + 2,
                width: sz, height: sz,
                borderRadius:'50%',
                background: markBg(item.value),
                display:'grid', placeItems:'center',
                fontSize: compact ? 7 : 10,
                fontWeight:700, color:'white',
                boxShadow:'0 1px 4px rgba(0,0,0,0.2)',
                overflow:'hidden',
              }}>
                {item.value}
                {item.tieCount > 0 && (
                  <>
                    {/* 슬래시 선 */}
                    <div style={{
                      position:'absolute', left:'50%', top:'50%',
                      transform:'translate(-50%,-50%) rotate(-45deg)',
                      width: sz + 2, height: compact ? 2 : 2.5, borderRadius:999,
                      background:'#16a34a', opacity:0.95, pointerEvents:'none',
                    }} />
                    {/* 타이 횟수 숫자 — 2개 이상일 때만 */}
                    {item.tieCount >= 2 && (
                      <div style={{
                        position:'absolute',
                        right: compact ? -1 : 0,
                        bottom: compact ? -1 : 0,
                        minWidth: compact ? 10 : 13,
                        height: compact ? 10 : 13,
                        borderRadius:999,
                        background:'#16a34a',
                        color:'white',
                        fontSize: compact ? 7 : 9,
                        fontWeight:800,
                        display:'flex', alignItems:'center', justifyContent:'center',
                        lineHeight:1,
                        border: '1px solid white',
                        pointerEvents:'none',
                      }}>
                        {item.tieCount}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// room.js PATTERN_CONFIGS 그대로
const BAC_PATTERN_CONFIGS = [
  { key: 'Custom6Group',     label: '중국점 6군 변형 (Custom Logic)',       color: '#a78bfa' },
  { key: 'Cross2',           label: '2군 교차색 (Cross2)',                  color: '#63cac0' },
  { key: 'Combo6GCross2',    label: '통합 6군+2군 일치 (Combo)',             color: '#818cf8' },
  { key: 'StreakMomentum',   label: 'A) 줄 길이 모멘텀',                    color: '#fbbf24' },
  { key: 'InShoeCond',       label: 'B) 슈 내 조건부 빈도',                  color: '#34d399' },
  { key: 'MACross',          label: 'C) 이동평균 크로스',                    color: '#a78bfa' },
  { key: 'AlternationIndex', label: 'D) 교번 지수',                         color: '#fb7185' },
  { key: 'Autocorrelation',  label: 'E) 자기상관 Lag-1',                    color: '#fb923c' },
  { key: 'EWMA',             label: 'F) 지수 가중 이동평균',                  color: '#22d3ee' },
  { key: 'ZScoreBias',       label: 'G) Z-Score 편향 탐지',                 color: '#a3e635' },
  { key: 'MarkovChain',      label: 'H) 마르코프 체인 (1차)',                color: '#f97316' },
  { key: 'RollingDiff',      label: 'I) 롤링 차이값 모멘텀',                 color: '#14b8a6' },
  { key: 'Ensemble',         label: 'J) 앙상블 투표',                       color: '#ec4899' },
  { key: 'AntiPattern',      label: 'K) 반전 패턴',                         color: '#ef4444' },
  { key: 'MarkovChain2',     label: 'L) 마르코프 체인 (2차)',                color: '#f59e0b' },
  { key: 'MarkovChain3',     label: 'M) 마르코프 체인 (3차)',                color: '#d97706' },
  { key: 'Bigram',           label: 'N) 바이그램 (2-gram)',                  color: '#6ee7b7' },
  { key: 'FourGram',         label: 'O) 포그램 (4-gram)',                   color: '#4ade80' },
  { key: 'BestNGram',        label: 'P) 최적 N-gram (자동선택)',             color: '#86efac' },
  { key: 'RunsTest',         label: 'Q) 런 검정 (Runs Test)',               color: '#67e8f9' },
  { key: 'Bayesian',         label: 'R) 베이지안 추론',                      color: '#c4b5fd' },
  { key: 'EntropyFilter',    label: 'S) 엔트로피 필터',                      color: '#fda4af' },
  { key: 'PhaseDetection',   label: 'T) 슈 페이즈 탐지',                    color: '#fdba74' },
  { key: 'ChangePoint',      label: 'U) 체인지포인트 탐지',                   color: '#fcd34d' },
  { key: 'StreakReversal3',  label: 'V) 줄 반전 (3연속)',                    color: '#f87171' },
  { key: 'StreakReversal4',  label: 'W) 줄 반전 (4연속)',                    color: '#fb923c' },
  { key: 'StreakReversal5',  label: 'X) 줄 반전 (5연속)',                    color: '#fbbf24' },
  { key: 'DoubleConfirm',    label: 'Y) 더블 컨펌 (Ensemble 2연속)',         color: '#e879f9' },
  { key: 'BestTracker',      label: 'Z1) 베스트 추적자 (Best Tracker)',      color: '#38bdf8' },
  { key: 'WinStreakTracker',  label: 'Z2) 연승 추적자 (Win Streak)',          color: '#818cf8' },
  // ── 신규 독립 패턴 ──
  { key: 'BigEyeRoad',       label: '큰눈이로 (중국점)',                       color: '#dc2626' },
  { key: 'SmallRoad',        label: '소로 (중국점)',                          color: '#2563eb' },
  { key: 'CockroachRoad',    label: '자로 (중국점)',                          color: '#16a34a' },
  { key: 'LempelZiv',        label: 'LZ 압축 복잡도',                         color: '#7c3aed' },
  { key: 'FFTPeriod',        label: 'FFT 주기 탐지',                         color: '#0891b2' },
  { key: 'TieConditional',   label: '타이 컨디셔널',                          color: '#ca8a04' },
  { key: 'HeuristicRule',    label: '휴리스틱 룰',                           color: '#be185d' },
  { key: 'ShoeSignature',    label: '슈 시그니처',                           color: '#0d9488' },
  { key: 'TrendStrength',    label: '추세 강도 (ADX)',                       color: '#9333ea' },
]

function bacWilson(wins, total) {
  if (total === 0) return -1
  const p = wins / total
  const z2 = BAC_WILSON_Z * BAC_WILSON_Z
  return (p + z2 / (2 * total) - BAC_WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total)
}

// 패턴 카드 — 라이트 테마
function BacPatternCard({ rank, cfg, data, score }) {
  const pick      = data.pick || ''
  const pickLabel = pick === 'B' ? '🔴 뱅커' : pick === 'P' ? '🔵 플레이어' : '—'
  const wr        = (data.win_rate || 0).toFixed(1)
  const total     = data.total    || 0
  const wins      = data.wins     || 0
  const losses    = data.losses   || 0
  const maxWin    = data.max_win  || 0
  const maxLoss   = data.max_loss || 0
  const curWin    = data.current_win  || 0
  const curLoss   = data.current_loss || 0
  const history   = data.history  || []
  const isRel     = total >= BAC_MIN_REL
  const scoreDisp = (score * 100).toFixed(1)
  const barPct    = Math.min(100, (total / 60) * 100).toFixed(0)
  const col       = cfg.color

  const wrColor    = parseFloat(wr) >= 55 ? '#10b981' : parseFloat(wr) >= 45 ? '#f59e0b' : '#ef4444'
  const scoreColor = score >= 0.5 ? '#10b981' : score >= 0.4 ? '#f59e0b' : '#94a3b8'
  const rankBg     = rank === 1 ? '#fbbf24' : rank <= 3 ? '#94a3b8' : rank <= 5 ? '#b45309' : '#e2e8f0'
  const rankFg     = rank <= 5 ? '#0f172a' : '#64748b'
  const pickColor  = pick === 'B' ? '#dc2626' : pick === 'P' ? '#2563eb' : '#64748b'

  const curStreakEl = curWin > 0
    ? <span style={{ color:'#10b981', fontWeight:700 }}>+{curWin}연승</span>
    : curLoss > 0
    ? <span style={{ color:'#ef4444', fontWeight:700 }}>-{curLoss}연패</span>
    : <span style={{ color:'#94a3b8' }}>-</span>

  return (
    <div style={{
      marginTop: '0.75rem',
      padding: '0.75rem',
      background: '#ffffff',
      borderRadius: 12,
      border: `1px solid ${col}55`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      {/* 헤더 */}
      <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:10, flexWrap:'wrap' }}>
        <div style={{
          minWidth:28, height:28, borderRadius:'50%',
          background:rankBg, color:rankFg,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontWeight:900, fontSize:'0.75rem', flexShrink:0,
        }}>{rank}</div>
        <div style={{ flex:1, minWidth:0, wordBreak:'keep-all' }}>
          <span style={{ color:col, fontWeight:700, fontSize:'0.85rem' }}>{cfg.label}</span>
          {!isRel && (
            <span style={{
              fontSize:'0.6rem', background:'#fef3c7',
              color:'#92400e', border:'1px solid #fcd34d',
              borderRadius:4, padding:'1px 5px', marginLeft:6,
              whiteSpace:'nowrap', display:'inline-block',
            }}>참고용({total}건)</span>
          )}
        </div>
        <div style={{ fontSize:'0.72rem', color:'#94a3b8', flexShrink:0, whiteSpace:'nowrap' }}>{total}건</div>
      </div>

      {/* 스탯 그리드 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,minmax(0,1fr))', gap:6 }}>
        {[
          { label:'최종 픽',          value:pickLabel,          color:pickColor,   size:'0.85rem' },
          { label:`적중률 (${total}건)`, value:`${wr}%`,         color:wrColor,     size:'1rem' },
          { label:'신뢰점수',         value:`${scoreDisp}%`,    color:scoreColor,  size:'0.95rem' },
          { label:'적중/미적중',      value:`${wins}/${losses}`, color:'#334155', size:'0.85rem' },
          { label:'최대 연승/연패',   value:`${maxWin}/${maxLoss}`, color:'#334155', size:'0.85rem' },
          { label:'현재 흐름',        valueEl:curStreakEl,      size:'0.85rem' },
          ...(data.agreement ? [{ label:'일치율', value:data.agreement, color:'#7c3aed', size:'0.95rem' }] : []),
        ].map((s, i) => (
          <div key={i} style={{
            background:'#f8fafc', padding:'0.5rem 0.3rem',
            borderRadius:8, textAlign:'center', border:'1px solid #f1f5f9',
            minWidth:0, overflow:'hidden',
          }}>
            <div style={{ fontSize:'0.62rem', color:'#94a3b8', marginBottom:3, wordBreak:'keep-all' }}>{s.label}</div>
            <div style={{ fontSize:s.size, fontWeight:600, color:s.color||'#1e293b', wordBreak:'keep-all' }}>
              {s.valueEl || s.value}
            </div>
          </div>
        ))}
      </div>

      {/* 건수 바 */}
      <div style={{ marginTop:8, height:3, background:'#f1f5f9', borderRadius:9, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${barPct}%`, background:col, borderRadius:9 }} />
      </div>

      {/* 히스토리 도트 */}
      <div style={{ marginTop:'0.75rem' }}>
        <div style={{ color:'#94a3b8', fontSize:'0.75rem', marginBottom:5 }}>이번 슈 배팅 결과</div>
        <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
          {history.length === 0
            ? <span style={{ color:'#94a3b8', fontSize:'0.75rem' }}>데이터 대기중...</span>
            : history.map((h, i) => (
              <div key={i} style={{
                width:22, height:22, borderRadius:'50%',
                background: h === 'O' ? '#10b981' : '#ef4444',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:10, fontWeight:'bold', color:'white', flexShrink:0,
              }}>{h}</div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

// ── 4개 패턴 cfg (phocoa 3matrix4 A/B/C/D, 일반 패턴 리스트에 통합) ──
const MATRIX3_PATTERN_CONFIGS = [
  { key: 'Matrix3A', label: '패턴 A', color: '#e11d48' },
  { key: 'Matrix3B', label: '패턴 B', color: '#f43f5e' },
  { key: 'Matrix3C', label: '패턴 C', color: '#ec4899' },
  { key: 'Matrix3D', label: '패턴 D', color: '#be123c' },
]

// ── 3매 OX 그리드 (phocoa 스타일: 3행 × N열, column-major + 우측 자동 스크롤) ──
function Matrix3OXChart({ ox, label }) {
  const cellSize = 18
  // 실제 데이터 기준 cols — 빈 패딩 cell 없음. 최소 1col 보장 (빈 ox 케이스).
  const actualCols = Math.max(1, Math.ceil(ox.length / 3))
  // 시각적 일관성을 위해 데이터가 적을 때만 최소 가시 col 보장 (작아도 박스가 짠 보이지 않게)
  const minVisibleCols = 6
  const cols = Math.max(actualCols, minVisibleCols)
  const scrollRef = useRef(null)

  // 데이터/마운트 시 마지막 데이터 셀이 보이도록 자동 스크롤
  // - 데이터가 많아 가로 스크롤 필요할 때만 작동
  // - 데이터 < minVisibleCols 인 경우엔 그냥 좌측(=처음)에 고정
  useEffect(() => {
    const scroll = () => {
      const el = scrollRef.current
      if (!el) return
      // 실제 마지막 데이터 col 위치 (오른쪽 끝이 아니라!)
      const targetLeft = Math.max(0, actualCols * (cellSize + 1) - el.clientWidth)
      el.scrollLeft = targetLeft
    }
    scroll()
    const raf = requestAnimationFrame(scroll)
    const t1 = setTimeout(scroll, 50)
    const t2 = setTimeout(scroll, 200)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [ox.length, actualCols])

  const cells = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = c * 3 + r
      cells.push({ r, c, val: ox[idx], hasData: idx < ox.length && (ox[idx] === 'O' || ox[idx] === 'X') })
    }
  }

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <div style={{ fontSize: '0.6rem', color: '#94a3b8', marginBottom: 3, fontWeight: 600 }}>{label}</div>
      {/* wrapper: 부모 폭 강제 — 자식 그리드가 wrapper를 못 넘게 */}
      <div style={{ width: '100%', maxWidth: '100%', overflow: 'hidden', borderRadius: 6 }}>
        <div
          ref={scrollRef}
          onTouchStart={e => e.stopPropagation()}
          onTouchMove={e => e.stopPropagation()}
          onTouchEnd={e => e.stopPropagation()}
          style={{
            overflowX: 'scroll',
            overflowY: 'hidden',
            background: '#1e293b',
            padding: 3,
            touchAction: 'pan-x',
            WebkitOverflowScrolling: 'touch',
            width: '100%',
            maxWidth: '100%',
          }}
        >
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
            gridTemplateRows: `repeat(3, ${cellSize}px)`,
            gap: 1,
            width: cols * (cellSize + 1),
          }}>
            {cells.map((cell, i) => (
              <div key={i} style={{
                gridRow: cell.r + 1,
                gridColumn: cell.c + 1,
                background: cell.hasData ? '#0f172a' : '#334155',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem', fontWeight: 800,
                color: cell.val === 'O' ? '#3b82f6' : cell.val === 'X' ? '#ef4444' : 'transparent',
              }}>{cell.val || ''}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 진짜 3매 분석 섹션 (phocoa 3matrix data=1) — 별도 표시 ───────
function Matrix3RealSection({ shoe }) {
  const r = useMemo(() => analyze3MatrixReal(shoe || ''), [shoe])
  const { normal, reverse, pCount, bCount, tCount, n1, n2 } = r
  const normalOX = useMemo(() => n1.filter(v => v && (v.ox === 'O' || v.ox === 'X')).map(v => v.ox), [n1])
  const reverseOX = useMemo(() => n2.filter(v => v && (v.ox === 'O' || v.ox === 'X')).map(v => v.ox), [n2])

  if (normal.total === 0 && reverse.total === 0) {
    return (
      <div className="mb-4 p-3 rounded-xl border border-rose-200 bg-rose-50/40 overflow-hidden" style={{ minWidth: 0 }}>
        <div className="text-xs font-bold text-rose-700 mb-2">🃏 3매 분석</div>
        <div className="text-center text-slate-400 text-xs py-3">데이터 부족 (shoe ≥ 6 필요)</div>
      </div>
    )
  }

  return (
    <div className="mb-4 p-3 rounded-xl border border-rose-200 bg-rose-50/40 overflow-hidden" style={{ minWidth: 0 }}>
      <div className="text-xs font-bold text-rose-700 mb-2">🃏 3매 분석</div>

      {/* 정/역 박스 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div style={{ background: '#2563eb', borderRadius: 10, padding: '0.5rem', textAlign: 'center' }}>
          <div style={{ color: 'white', fontSize: '0.7rem', fontWeight: 700, marginBottom: 2 }}>정</div>
          <div style={{ color: 'white', fontSize: '1.2rem', fontWeight: 900 }}>{normal.prediction || '-'}</div>
          <div style={{ color: 'white', fontSize: '1rem', fontWeight: 800 }}>{normal.rate.toFixed(0)}%</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.55rem', marginTop: 2 }}>{normal.wins}/{normal.losses}</div>
        </div>
        <div style={{ background: '#dc2626', borderRadius: 10, padding: '0.5rem', textAlign: 'center' }}>
          <div style={{ color: 'white', fontSize: '0.7rem', fontWeight: 700, marginBottom: 2 }}>역</div>
          <div style={{ color: 'white', fontSize: '1.2rem', fontWeight: 900 }}>{reverse.prediction || '-'}</div>
          <div style={{ color: 'white', fontSize: '1rem', fontWeight: 800 }}>{reverse.rate.toFixed(0)}%</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.55rem', marginTop: 2 }}>{reverse.wins}/{reverse.losses}</div>
        </div>
      </div>

      {/* P/B/T 카운트 */}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 8, fontSize: '0.7rem', fontWeight: 700 }}>
        <span style={{ color: '#2563eb' }}>P <b style={{ color: '#0f172a' }}>{pCount}</b></span>
        <span style={{ color: '#dc2626' }}>B <b style={{ color: '#0f172a' }}>{bCount}</b></span>
        <span style={{ color: '#16a34a' }}>T <b style={{ color: '#0f172a' }}>{tCount}</b></span>
      </div>

      {/* 정/역 OX 그리드 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
        <Matrix3OXChart ox={normalOX} label={`정 OX (적중률 ${normal.rate.toFixed(0)}%)`} />
        <Matrix3OXChart ox={reverseOX} label={`역 OX (적중률 ${reverse.rate.toFixed(0)}%)`} />
      </div>
    </div>
  )
}

// matrix3 결과 한 패턴을 BacPatternCard가 기대하는 형식으로 변환
function matrix3ToPatternData(d) {
  return {
    pick:          d.prediction,
    win_rate:      d.rate,
    total:         d.total,
    wins:          d.wins,
    losses:        d.losses,
    max_win:       d.maxWin,
    max_loss:      d.maxLoss,
    current_win:   d.nowWin,
    current_loss:  d.nowLoss,
    history:       d.history,
  }
}

// 룸 카드 — 라이트 테마, 픽 배지 제거
function BacRoomCard({ room }) {
  const [open, setOpen] = useState(false)
  const [bacCat, setBacCat] = useState('matrix3')  // matrix3 | patterns
  const patterns = room.patterns || {}
  const shoe     = room.shoe || ''
  const consensus = room.consensus
  const tieRecency = room.tie_recency
  const tieWarning = tieRecency !== null && tieRecency !== undefined && tieRecency < 3
  const shoeCount = room.shoe_count
  const lastShoe  = room.last_shoe
  const crossRoom = room.cross_room

  // 4개 패턴 (phocoa 3matrix4 A/B/C/D)을 일반 패턴 리스트에 통합
  // (진짜 3매는 별도 Matrix3RealSection으로 빠짐)
  const matrix3Patterns = useMemo(() => {
    const r = analyzeMatrix3(shoe)
    return {
      Matrix3A: matrix3ToPatternData(r.patterns.A),
      Matrix3B: matrix3ToPatternData(r.patterns.B),
      Matrix3C: matrix3ToPatternData(r.patterns.C),
      Matrix3D: matrix3ToPatternData(r.patterns.D),
    }
  }, [shoe])

  const allConfigs  = [...BAC_PATTERN_CONFIGS, ...MATRIX3_PATTERN_CONFIGS]
  const allPatterns = { ...patterns, ...matrix3Patterns }

  const entries = allConfigs
    .map(cfg => {
      const data  = allPatterns[cfg.key]
      const score = data ? bacWilson(data.wins || 0, data.total || 0) : -1
      return { cfg, data, score }
    })
    .filter(e => e.data && (e.data.total || 0) >= 1)
    .sort((a, b) => b.score - a.score)

  const noData = allConfigs
    .map(cfg => ({ cfg, data: allPatterns[cfg.key] }))
    .filter(e => !e.data || (e.data.total || 0) < 1)

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm mb-3 overflow-hidden">
      {/* 룸 헤더 — 항상 표시 */}
      <div className="px-3 pt-3 pb-3">
        <div className="flex items-start justify-between mb-3 gap-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 text-sm break-keep">{room.name}</div>
            <div className="text-[11px] text-slate-400 mt-0.5 break-keep">
              슈 {shoe.length}판 · 패턴 {entries.length}개
              {shoeCount > 0 && <span> · 추적 {shoeCount}슈</span>}
            </div>
          </div>
        </div>

        {/* 컴팩트 차트 — 항상 표시 */}
        <BacRoadChart shoeStr={shoe} compact={true} />

        {/* 펼치기 버튼 */}
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full mt-3 py-2 text-xs font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-center gap-1">
          {open ? '▲ 패턴 닫기' : '▼ 패턴 보기'}
        </button>
      </div>

      {/* 펼쳤을 때: 카테고리 탭 (3매분석 / 패턴분석) */}
      {open && (
        <div className="px-4 pb-4">
          {/* 카테고리 탭 */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setBacCat('matrix3')}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                ${bacCat === 'matrix3'
                  ? 'bg-rose-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-500'}`}>
              🃏 3매 분석
            </button>
            <button
              onClick={() => setBacCat('patterns')}
              className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all
                ${bacCat === 'patterns'
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-500'}`}>
              🎯 패턴 분석 ({entries.length})
            </button>
          </div>

          {/* 3매 분석 카테고리 */}
          {bacCat === 'matrix3' && <Matrix3RealSection shoe={shoe} />}

          {/* 패턴 분석 카테고리 */}
          {bacCat === 'patterns' && entries.map((e, i) => (
            <BacPatternCard key={e.cfg.key} rank={i+1} cfg={e.cfg} data={e.data} score={e.score} />
          ))}

          {/* 대기중 — 패턴 분석 카테고리에서만 표시 */}
          {bacCat === 'patterns' && noData.length > 0 && (
            <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="text-xs text-slate-400 mb-2">대기중 (배팅 데이터 없음)</div>
              <div className="flex flex-wrap gap-1.5">
                {noData.map(e => (
                  <span key={e.cfg.key} className="text-xs text-slate-400 bg-white border border-slate-200 px-2 py-0.5 rounded-lg">
                    {e.cfg.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const BACCARAT_PRAGMATIC_API = 'https://sharpsignal.cloud/api/public/state-pragmatic'

function BaccaratTab({ hasAccess, onShowUpgrade, onSignIn, user, apiUrl = BACCARAT_API }) {
  const [state, setState]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [search, setSearch]   = useState('')

  async function fetchState() {
    try {
      const res = await fetch(apiUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setState(json)
      setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
      setError(null)
    } catch (e) {
      setError('데이터 로드 실패. 잠시 후 다시 시도해주세요.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    setState(null)
    fetchState()
    const timer = setInterval(fetchState, 3000) // 웹사이트 동일 3초
    return () => clearInterval(timer)
  }, [apiUrl])

  if (!hasAccess) {
    return (
      <div className="px-4 pt-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
        <LockBox
          label="구독 후 바카라 패턴을 이용할 수 있습니다"
          onUnlock={user ? onShowUpgrade : onSignIn}
          isGuest={!user}
        />
      </div>
    )
  }

  // 검색 필터링
  const filteredRooms = (state?.rooms || []).filter(room => {
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (room.name || '').toLowerCase().includes(q)
  })

  return (
    <div className="px-3 py-4 fade-in">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-base font-bold text-slate-900 dark:text-slate-100">{apiUrl === BACCARAT_PRAGMATIC_API ? '프라그마틱' : 'EVOLUTION'}</div>
          {lastUpdate && <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">갱신 {lastUpdate}</div>}
        </div>
        <button onClick={() => { haptic.light(); fetchState() }}
          className="text-xs font-semibold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 active:bg-slate-200 dark:active:bg-slate-700 px-3 py-1.5 rounded-full active:scale-95 transition-all">
          새로고침
        </button>
      </div>

      {/* 검색바 */}
      {state?.rooms?.length > 3 && (
        <div className="relative mb-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="룸 이름 검색..."
            className="w-full pl-9 pr-9 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-full
              text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500
              focus:outline-none focus:border-indigo-500 dark:focus:border-indigo-400 transition-colors"
          />
          {search && (
            <button onClick={() => { setSearch(''); haptic.light() }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400 active:scale-95 transition-all">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>
      )}

      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <div className="text-center text-rose-400 dark:text-rose-300 py-10 text-sm">{error}</div>
      ) : !state?.rooms?.length ? (
        <div className="text-center text-slate-400 dark:text-slate-500 py-20 text-sm">룸 데이터 없음</div>
      ) : filteredRooms.length === 0 ? (
        <div className="text-center text-slate-400 dark:text-slate-500 py-12 text-sm">
          "{search}" 검색 결과 없음
        </div>
      ) : (
        filteredRooms.map(room => <BacRoomCard key={room.id} room={room} />)
      )}
    </div>
  )
}

// ── 축구 팀명 정규화 (Pinnacle 짧은 이름 ↔ betman 긴 이름) ─────────────────
const SOCCER_NAME_ALIASES = {
  // EPL: Pinnacle은 짧은 이름 사용
  newcastleunited: 'newcastle', westhamunited: 'westham',
  tottenhamhotspur: 'tottenham', brightonhovealbion: 'brighton',
  wolverhamptonwanderers: 'wolverhampton',
  leedsunited: 'leeds', manchesterunited: 'manchesterunited',
  manchestercity: 'manchestercity', astonvilla: 'astonvilla',
  // EFL Championship 단축형 (Pinnacle 풀네임 → Excapper 단축형)
  hullcity: 'hull', westbromwichalbion: 'westbrom', westbromwich: 'westbrom',
  queensparkrangers: 'qpr', norwichcity: 'norwich',
  prestonnorthend: 'preston', cardiffcity: 'cardiff',
  birminghamcity: 'birmingham', coventrycity: 'coventry',
  plymouthargyle: 'plymouth', stokecity: 'stoke', swanseacity: 'swansea',
  oxfordunited: 'oxford', sheffieldunited: 'sheffieldunited',
  sheffieldwednesday: 'sheffieldwednesday', blackburnrovers: 'blackburn',
  derbycounty: 'derby', ipswichtown: 'ipswich', leicestercity: 'leicester',
  // Inter
  inter: 'internazionale', intermilan: 'internazionale',
  intermilano: 'internazionale', intermilanfc: 'internazionale',
  // MLS
  lafc: 'losangelesfc', lagalaxy: 'losangelesgalaxy',
  newyorkcityfc: 'newyorkcity', stlouiscity: 'stlouiscitysc',
  // K리그
  gangwon: 'gangwonfc', fcanyang: 'anyang',
  bucheonfc: 'bucheonfc1995', gyeongnam: 'gyeongnamfc',
  suwonbluewings: 'suwonsamsung',
  // K리그 Excapper 단축형 매칭
  incheonutd: 'incheonunited', incheon: 'incheonunited',
  jejusk: 'jejuskfc', jeonbukmotors: 'jeonbukhyundaimotors',
  ulsanhd: 'ulsanhyundai',
  busanipark: 'busaniparkfc', busanfc: 'busaniparkfc',
  seoulland: 'seoulelandfc',
  // La Liga Excapper 단축형 매칭 (충돌 위험 있는 풀 단축은 회피)
  realbetis: 'betis',
  realoviedo: 'oviedo',
}
function normSoccerName(s) {
  const key = (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return SOCCER_NAME_ALIASES[key] || key
}

// ── findProto 공유 구현 (betmanDirect + protoData, 클로저 무관) ──────────────
function findProtoImpl(game, betmanDirect, protoData) {
  const sportMap = { baseball: 'baseball', basketball: 'basketball', soccer: 'soccer' }
  const protoSport = sportMap[game.sport]
  if (!protoSport) return null

  const norm = s => (s || '').trim().toLowerCase()
  const orientProto = (p, reversed = false) => {
    if (!p || !reversed) return p
    return {
      ...p,
      home: p.away, away: p.home,
      home_abbr: p.away_abbr, away_abbr: p.home_abbr,
      ml_bets_home: p.ml_bets_away, ml_bets_away: p.ml_bets_home,
      ml_bets_home_count: p.ml_bets_away_count, ml_bets_away_count: p.ml_bets_home_count,
      ml_bets_home_amount: p.ml_bets_away_amount, ml_bets_away_amount: p.ml_bets_home_amount,
      sp_bets_home: p.sp_bets_away, sp_bets_away: p.sp_bets_home,
      sp_bets_home_count: p.sp_bets_away_count, sp_bets_away_count: p.sp_bets_home_count,
      sp_bets_home_amount: p.sp_bets_away_amount, sp_bets_away_amount: p.sp_bets_home_amount,
    }
  }
  const STALE_MS = 36 * 60 * 60 * 1000
  const isRecent = p => !p.updated_at || (Date.now() - new Date(p.updated_at).getTime()) < STALE_MS
  const pinDate = game.starts_at ? game.starts_at.slice(0, 5) : null
  const dateScore = p => {
    if (!pinDate || !p.game_date) return 0
    return p.game_date.slice(5, 10).replace('-', '/') === pinDate ? 2 : 0
  }
  const latestTime = p => p?.updated_at ? new Date(p.updated_at).getTime() || 0 : 0

  const pickFromSource = (source, filter, reversed = false) => {
    const found = source
      .filter(p => filter(p) && isRecent(p))
      .map(p => ({ p, score: dateScore(p) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || latestTime(b.p) - latestTime(a.p))[0]?.p
    return found ? orientProto(found, reversed) : null
  }
  // ❌ previewN(protoData) 완전 차단. 베트맨 실시간만 사용.
  // 베트맨 매칭 안 되면 null 반환 → 박스 안 보임 (서버 캐시 절대 안 섞임)
  const pickProto = (filter, reversed = false) =>
    pickFromSource(betmanDirect || [], filter, reversed)

  if (game.league === 'MLB' || game.league === 'NBA') {
    const homeAbbr = TEAM_ABBREV[game.home] || ''
    const awayAbbr = TEAM_ABBREV[game.away] || ''
    if (!homeAbbr || !awayAbbr) return null
    const baseFilter = p =>
      p.sport === protoSport && p.league === game.league &&
      p.home_abbr?.toUpperCase() === homeAbbr.toUpperCase() &&
      p.away_abbr?.toUpperCase() === awayAbbr.toUpperCase()
    const reverseFilter = p =>
      p.sport === protoSport && p.league === game.league &&
      p.home_abbr?.toUpperCase() === awayAbbr.toUpperCase() &&
      p.away_abbr?.toUpperCase() === homeAbbr.toUpperCase()
    return pickProto(baseFilter) || pickProto(reverseFilter, true)
  }
  // 축구/KBO/NPB: normSoccerName으로 'Newcastle United' ↔ 'Newcastle' 등 처리
  const ns = normSoccerName
  const baseFilter = p =>
    p.sport === protoSport &&
    ns(p.home_abbr) === ns(game.home) &&
    ns(p.away_abbr) === ns(game.away)
  const reverseFilter = p =>
    p.sport === protoSport &&
    ns(p.home_abbr) === ns(game.away) &&
    ns(p.away_abbr) === ns(game.home)
  return pickProto(baseFilter) || pickProto(reverseFilter, true)
}

function MainApp({ user, isAdmin, hasAccess, sub, onSignOut, onSignIn, signInLoading, themeMode, setThemeMode }) {
  const [games, setGames]           = useState([])
  const [mainTab, setMainTab]       = useState('sports')  // 하단 탭: sports | pattern | mypicks | more
  // 스포츠 탭 3단계 계층:
  // - topCat (대분류): 'signal'(시그널픽) | 'upcoming'(진행예정) | 'past'(지난경기)
  // - tab (중분류 = sport): 'all' | baseball | soccer | basketball | hockey  (signal일 땐 적용 안 됨)
  // - subLeague (소분류 = 리그): 'all' | MLB | KBO ...
  const [topCat, setTopCat]         = useState('upcoming')
  const [tab, setTab]               = useState('all')
  const [subLeague, setSubLeague]   = useState('all')
  const [loading, setLoading]       = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [selected, setSelected]     = useState(null)
  const [showAdmin, setShowAdmin]   = useState(false)
  // Ref로 최신 값 유지 (클로저 캡처 문제 방지)
  const betmanDirectRef = useRef([])
  const protoDataRef    = useRef([])
  const excDataRef      = useRef([])  // 축구 해외구매율 (Excapper) 캐시
  const pbDataRef       = useRef([])
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [showMyPage, setShowMyPage] = useState(false)
  const [pickModalData, setPickModalData] = useState(null)
  const [showAddPickFlow, setShowAddPickFlow] = useState(false)
  useEffect(() => _registerPickModal(setPickModalData), [])
  useEffect(() => _registerAddPickFlow(setShowAddPickFlow), [])
  const [betmanDirect, setBetmanDirect] = useState([])  // 앱 직접 호출 국내구매율
  // 패턴 통합 서브탭: ev | pragmatic | eos | dh
  const [patternSub, setPatternSub] = useState('ev')
  const daysLeft = trialDaysLeft(sub)

  // 앱 강제 업데이트 체크 (시작 시 1회)
  const [forceUpdate, setForceUpdate] = useState(null) // null | { current, min, url }
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let cancelled = false
    ;(async () => {
      try {
        const info = await CapApp.getInfo()
        const current = info?.version || '0'
        const res = await fetch(`${API_BASE}/api/app-version`, { cache: 'no-store' })
        if (!res.ok) return
        const { minVersion, updateUrl } = await res.json()
        if (!minVersion) return
        const cmp = (a, b) => {
          const pa = String(a || '0').split('.').map(n => parseInt(n) || 0)
          const pb = String(b || '0').split('.').map(n => parseInt(n) || 0)
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] || 0, y = pb[i] || 0
            if (x !== y) return x - y
          }
          return 0
        }
        if (cmp(current, minVersion) < 0 && !cancelled) {
          setForceUpdate({ current, min: minVersion, url: updateUrl || '' })
        }
      } catch (e) { console.error('[version check]', e) }
    })()
    return () => { cancelled = true }
  }, [])

  // 뒤로가기 버튼 처리 — 우선순위로 모달/탭 닫기 → 메인 도달 시 종료
  useEffect(() => {
    let listener
    CapApp.addListener('backButton', () => {
      // 1) 픽 추가 플로우
      if (showAddPickFlow) { setShowAddPickFlow(false); return }
      // 2) 게임 상세 모달
      if (selected) { setSelected(null); return }
      // 3) 관리자 화면
      if (showAdmin) { setShowAdmin(false); return }
      // 4) 업그레이드 모달
      if (showUpgrade) { setShowUpgrade(false); return }
      // 5) 마이페이지
      if (showMyPage) { setShowMyPage(false); return }
      // 6) 메인 탭이 sports가 아니면 sports로
      if (mainTab !== 'sports') { setMainTab('sports'); return }
      // 7) 메인(sports) 탭 → 종료 confirm
      if (window.confirm('샤프시그널 앱을 종료하시겠습니까?')) {
        CapApp.exitApp()
      }
    }).then(l => { listener = l })
    return () => { listener?.remove() }
  }, [selected, showAddPickFlow, showAdmin, showUpgrade, showMyPage, mainTab])

  // 모달 열릴 때 배경 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = selected ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [selected])

  useEffect(() => {
    fetchGames()
    fetchBetmanDirect()
    const timer = setInterval(() => fetchGames(true), 30 * 60 * 1000)
    const betmanTimer = setInterval(() => fetchBetmanDirect(), 5 * 60 * 1000) // 5분마다 실시간 갱신
    // 앱이 백그라운드 → 포그라운드로 돌아올 때 자동 새로고침
    let appStateListener
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) { fetchGames(true); fetchBetmanDirect() }
    }).then(l => { appStateListener = l })
    return () => {
      clearInterval(timer)
      clearInterval(betmanTimer)
      appStateListener?.remove()
    }
  }, [])

  // 베트맨 결과 비동기 조회 (백그라운드, 끝나면 게임에 병합)
  async function fetchBetmanResultsAsync(gmId, gmTs, proto) {
    const resultMap = {}
    const tsList = [gmTs]
    for (let i = 1; i <= 5; i++) tsList.push(gmTs - i)
    // 병렬 호출
    await Promise.all(tsList.map(async (ts) => {
      try {
        const resRefer = `${BETMAN_RESULT_URL}?gmId=${gmId}&gmTs=${ts}`
        const winRes = await CapacitorHttp.post({
          url: BETMAN_RESULT_API,
          headers: { ...BETMAN_HEADERS, 'Referer': resRefer },
          data: { gmId, gmTs: String(ts), _sbmInfo: { debugMode: 'false' } },
        })
        const m = parseBetmanResults(winRes.data)
        for (const k in m) {
          if (!resultMap[k]) resultMap[k] = m[k]
          else Object.assign(resultMap[k], m[k])
        }
      } catch (_) {}
    }))
    // proto에 결과 병합
    let updated = false
    for (const p of proto) {
      const k = `${p.sport}|${p.home}|${p.away}|${p.game_date}`
      const res = resultMap[k]
      if (res) {
        if (res.ml_result)  { p.ml_result  = res.ml_result; updated = true }
        if (res.sp_result)  { p.sp_result  = res.sp_result; updated = true }
        if (res.ou_result)  { p.ou_result  = res.ou_result; updated = true }
        if (res.mch_score)  { p.mch_score  = res.mch_score; updated = true }
      }
    }
    // pending 픽 자동 settle (결과 들어온 픽들 적중/실패 판정)
    try {
      const settledCount = settlePendingPicks(proto)
      if (settledCount > 0) toast.info(`내 픽 ${settledCount}건 결과 업데이트됨`)
    } catch (_) {}

    if (updated) {
      // betmanDirectRef는 이미 같은 proto 객체 참조하니 이 시점에 자동 반영됨
      // setGames로 리렌더링 트리거
      setGames(prev => prev.map(g => {
        if (g._betmanOnly) {
          const k = `${g.sport}|${g.home}|${g.away}|${g.game_date}`
          const r = resultMap[k]
          if (r) return { ...g, protoBetting: { ...(g.protoBetting || {}), ...r } }
          return g
        } else if (g.protoBetting) {
          const k = `${g.sport}|${g.protoBetting.home || g.home}|${g.protoBetting.away || g.away}|${g.protoBetting.game_date}`
          const r = resultMap[k]
          if (r) return { ...g, protoBetting: { ...g.protoBetting, ...r } }
        }
        return g
      }))
    }
  }

  // betman.co.kr 직접 호출 (앱 전용, CapacitorHttp로 CORS 우회)
  async function fetchBetmanDirect() {
    if (!Capacitor.isNativePlatform()) return
    try {
      // 1단계: 현재 G101 회차 조회
      const roundRes = await CapacitorHttp.post({
        url: BETMAN_BUYABLE_API,
        headers: { ...BETMAN_HEADERS, 'Referer': BETMAN_BUYABLE_URL },
        data: { _sbmInfo: { debugMode: 'false' } },
      })
      const protoGames = roundRes.data?.protoGames || []
      let g101 = protoGames.find(g => g.gmId === 'G101')

      let gmId = 'G101', gmTs
      if (g101) {
        // 회차 진행 중 → 사용 + localStorage 저장
        gmTs = g101.gmTs
        try { localStorage.setItem('last_betman_g101_ts', String(gmTs)) } catch (_) {}
      } else {
        // 회차 사이 공백기: 1) localStorage → 2) winrstDetl로 최근 회차 찾기 → 3) hardcoded fallback
        try {
          const saved = localStorage.getItem('last_betman_g101_ts')
          if (saved) gmTs = parseInt(saved)
        } catch (_) {}

        if (!gmTs) {
          // winrstDetl.do로 최근 회차 가져오기 (seed gmTs 필요)
          try {
            const seedTs = 260055  // 알려진 최근 회차 (실패해도 다음 단계로)
            const winRes = await CapacitorHttp.post({
              url: 'https://www.betman.co.kr/gamebuy/winrst/inqWinrstDetl.do',
              headers: { ...BETMAN_HEADERS, 'Referer': `${BETMAN_RESULT_URL}?gmId=G101&gmTs=${seedTs}` },
              data: { gmId: 'G101', gmTs: String(seedTs), _sbmInfo: { debugMode: 'false' } },
            })
            const winList = winRes.data?.winrstList || []
            const recent = winList.find(w => w.GM_ID === 'G101')
            if (recent?.GM_TS) gmTs = parseInt(recent.GM_TS)
          } catch (_) {}
        }

        if (!gmTs) gmTs = 260055  // 최후 fallback (known good)
      }

      const referer = `${BETMAN_GAMESLIP}?gmId=${gmId}&gmTs=${gmTs}`

      // 2단계: 경기 데이터 조회 (즉시 표시용)
      const gameRes = await CapacitorHttp.post({
        url: BETMAN_GAME_API,
        headers: { ...BETMAN_HEADERS, 'Referer': referer },
        data: { gmId, gmTs: String(gmTs), gameYear: '', _sbmInfo: { debugMode: 'false' } },
      })
      const proto = parseBetmanData(gameRes.data)
      // 자동 매칭 학습: 현재 화면의 피나클 게임과 비교해서 미매핑 한글팀명 자동 학습
      setGames(prev => {
        const learned = learnBetmanTeams(proto, prev)
        // 학습 후 betman 게임의 한글 → 영문 재변환 (학습된 매핑 반영)
        if (learned > 0) {
          for (const p of proto) {
            if (p.home_raw) p.home = p.home_abbr = betmanTeamName(p.home_raw)
            if (p.away_raw) p.away = p.away_abbr = betmanTeamName(p.away_raw)
          }
        }
        betmanDirectRef.current = proto
        if (typeof window !== 'undefined') window._betmanDirectDump = proto

        // 피나클 게임만 골라서 protoBetting 재매핑 + 합성 카드 재생성
        const pinnacleOnly = prev.filter(g => !g._betmanOnly)
        const remapped = pinnacleOnly.map(g => ({ ...g, protoBetting: findProtoImpl(g, proto, protoDataRef.current) }))

        const nsLocal = s => (s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '')
        const teamKeys = name => {
          const full = nsLocal(name)
          const abbr = TEAM_ABBREV[name] ? nsLocal(TEAM_ABBREV[name]) : null
          return abbr ? [full, abbr] : [full]
        }
        const synthetic = []
        for (const bg of proto) {
          const bgH = nsLocal(bg.home), bgA = nsLocal(bg.away)
          const bgHa = nsLocal(bg.home_abbr || ''), bgAa = nsLocal(bg.away_abbr || '')
          const candidates = [bgH, bgA, bgHa, bgAa].filter(Boolean)
          const matched = remapped.some(g => {
            if (g.sport !== bg.sport) return false
            const pb = g.protoBetting
            if (pb && (
              (pb.home === bg.home && pb.away === bg.away) ||
              (pb.home_abbr && bg.home_abbr && pb.home_abbr === bg.home_abbr && pb.away_abbr === bg.away_abbr)
            )) return true
            const hKeys = teamKeys(g.home), aKeys = teamKeys(g.away)
            return candidates.some(c => hKeys.includes(c) || aKeys.includes(c))
          })
          if (matched) continue
          const lg = bg.league_norm || normalizeBetmanLeague(bg.league)
          // Excapper에서 해외구매율 매칭 (축구만)
          let publicBetting = null
          if (bg.sport === 'soccer') {
            const ns = normSoccerName
            const target = (excDataRef.current || []).filter(e => e.sport === 'soccer' && e.league === lg)
            const hit = target.find(e =>
              (ns(e.home) === ns(bg.home) && ns(e.away) === ns(bg.away)) ||
              (ns(e.home) === ns(bg.away) && ns(e.away) === ns(bg.home))
            )
            if (hit) {
              const reversed = ns(hit.home) === ns(bg.away)
              publicBetting = reversed ? {
                ...hit, home: hit.away, away: hit.home,
                ml_bets_home: hit.ml_bets_away, ml_bets_away: hit.ml_bets_home,
                ml_amount_home: hit.ml_amount_away, ml_amount_away: hit.ml_amount_home,
              } : hit
            }
          }
          synthetic.push({
            matchup_id:    `betman-${bg.sport}-${bg.home}-${bg.away}-${bg.game_date}`,
            sport: bg.sport, league: lg, home: bg.home, away: bg.away,
            starts_at: bg.starts_at, ts: bg.updated_at,
            ml_home: null, ml_away: null, ml_draw: null,
            sp_home: null, sp_away: null, sp_pts: null,
            ou_over: null, ou_under: null, ou_pts: null,
            opening: null, recentAlerts: [], publicBetting,
            protoBetting: bg, _betmanOnly: true,
          })
        }
        return [...remapped, ...synthetic]
      })
      setBetmanDirect(proto)

      // 3단계: 결과 백그라운드 조회 (지연시켜서 1단계/2단계와 충돌 방지)
      setTimeout(() => {
        fetchBetmanResultsAsync(gmId, gmTs, proto).catch(e => {
          console.warn('[betman-results]', e?.message || e)
        })
      }, 3000)
    } catch (e) {
      console.warn('[betman-direct]', e?.message || e)
    }
  }

  // ref 기반 findProto (클로저 시점에 무관하게 최신 데이터 사용)
  function findProtoFromRefs(game) {
    return findProtoImpl(game, betmanDirectRef.current, protoDataRef.current)
  }

  // silent=true 이면 기존 데이터를 유지한 채 백그라운드 갱신 (스크롤 위치 보존)
  async function fetchGames(silent = false, retryCount = 0) {
    if (!silent) setLoading(true)
    let json
    try {
      const res = await fetch(`${GAMES_API}/api/games`)
      json = await res.json()
    } catch (e) {
      // 초기 로드 실패시 최대 3회 재시도 (2초 간격)
      if (!silent && retryCount < 3) {
        setTimeout(() => fetchGames(false, retryCount + 1), 2000)
        return
      }
      if (!silent) setLoading(false)
      return
    }

    const linesData  = json.lines           || []
    const openings   = json.openings        || []
    const alertsData = json.alerts          || []
    const pbData     = json.publicBetting   || []
    const protoData  = json.protoBetting    || []
    const excData    = json.excapperBetting || []   // 축구 해외구매율 (Excapper)
    protoDataRef.current = protoData  // 최신 값을 ref에 보존
    excDataRef.current   = excData
    pbDataRef.current    = pbData

    const currentIds  = new Set(linesData.map(g => g.matchup_id))
    const openingsMap = Object.fromEntries(openings.map(o => [o.matchup_id, o]))
    const alertsMap   = {}
    for (const a of alertsData) {
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

    function findPb(game) {
      // 축구는 Excapper 데이터에서 찾기 (리그 + 팀명 fuzzy 매칭)
      if (game.sport === 'soccer') {
        const ns = normSoccerName
        const target = (excData || []).filter(e => e.sport === 'soccer' && e.league === game.league)
        const hit = target.find(e =>
          (ns(e.home) === ns(game.home) && ns(e.away) === ns(game.away)) ||
          (ns(e.home) === ns(game.away) && ns(e.away) === ns(game.home))
        )
        if (!hit) return null
        // 방향이 반대면 좌우 교체
        const reversed = ns(hit.home) === ns(game.away)
        return reversed ? {
          ...hit,
          home: hit.away, away: hit.home,
          ml_bets_home:   hit.ml_bets_away,   ml_bets_away:   hit.ml_bets_home,
          ml_amount_home: hit.ml_amount_away, ml_amount_away: hit.ml_amount_home,
        } : hit
      }
      // 야구/농구/하키는 기존 sportsbettingdime 데이터
      const sportMap = { baseball: 'mlb', basketball: 'nba', hockey: 'nhl' }
      const sport = sportMap[game.sport] || game.sport
      if (!['mlb','nba','nhl'].includes(sport)) return null
      const homeAbbr = TEAM_ABBREV[game.home] || ''
      const awayAbbr = TEAM_ABBREV[game.away] || ''
      if (!homeAbbr || !awayAbbr) return null
      const norm = s => (s || '').toUpperCase()
      return pbData.find(pb =>
        pb.sport === sport && (
          (norm(pb.home) === norm(homeAbbr) && norm(pb.away) === norm(awayAbbr)) ||
          (norm(pb.home) === norm(awayAbbr) && norm(pb.away) === norm(homeAbbr))
        )
      ) || null
    }

    function findProto(game) {
      return findProtoImpl(game, betmanDirectRef.current, protoData)
    }

    const merged = linesData.filter(g =>
      !/(Games\))/i.test(g.home || '') && !/(Games\))/i.test(g.away || '')
    ).map(g => ({
      ...g,
      league:        normalizeLeague(g.league),
      opening:       openingsMap[g.matchup_id] || null,
      recentAlerts:  alertsMap[g.matchup_id] ? Object.values(alertsMap[g.matchup_id]) : [],
      publicBetting: findPb(g),
      protoBetting:  findProto(g),
    }))

    // ── 베트맨에는 있지만 피나클에는 없는 경기를 합성 카드로 추가 ─────
    // (예: EFL Championship 같이 피나클 스크래퍼가 안 가져오는 리그)
    const betmanGames = betmanDirectRef.current || []
    const nsLocal = s => (s || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '')
    // MLB/NBA: 베트맨이 약어로 매핑(CLE/LAA/BAL/NYY)되므로 피나클 풀네임을 TEAM_ABBREV로 변환해서 비교
    const teamKeys = name => {
      const full = nsLocal(name)
      const abbr = TEAM_ABBREV[name] ? nsLocal(TEAM_ABBREV[name]) : null
      return abbr ? [full, abbr] : [full]
    }
    const synthetic = []
    for (const bg of betmanGames) {
      const bgH = nsLocal(bg.home), bgA = nsLocal(bg.away)
      const bgHa = nsLocal(bg.home_abbr || ''), bgAa = nsLocal(bg.away_abbr || '')
      const candidates = [bgH, bgA, bgHa, bgAa].filter(Boolean)
      const matched = merged.some(g => {
        if (g.sport !== bg.sport) return false
        // 1) 이미 findProto가 묶었으면 동일 경기
        const pb = g.protoBetting
        if (pb && (
          (pb.home === bg.home && pb.away === bg.away) ||
          (pb.home_abbr && bg.home_abbr && pb.home_abbr === bg.home_abbr && pb.away_abbr === bg.away_abbr)
        )) return true
        // 2) 팀명 기반 (한글/영문 풀네임 + 영문 약어 모두 시도)
        const hKeys = teamKeys(g.home), aKeys = teamKeys(g.away)
        return candidates.some(c => hKeys.includes(c) || aKeys.includes(c))
      })
      if (matched) continue
      // 합성 카드 생성 (피나클 odds는 null)
      const lg = bg.league_norm || normalizeBetmanLeague(bg.league)
      const syntheticGame = {
        matchup_id:    `betman-${bg.sport}-${bg.home}-${bg.away}-${bg.game_date}`,
        sport:         bg.sport,
        league:        lg,
        home:          bg.home,
        away:          bg.away,
        starts_at:     bg.starts_at,
        ts:            bg.updated_at,
        ml_home: null, ml_away: null, ml_draw: null,
        sp_home: null, sp_away: null, sp_pts: null,
        ou_over: null, ou_under: null, ou_pts: null,
        opening:       null,
        recentAlerts:  [],
        protoBetting:  bg,
        _betmanOnly:   true,
      }
      syntheticGame.publicBetting = findPb(syntheticGame)  // Excapper에서 매칭 시도
      synthetic.push(syntheticGame)
    }
    setGames([...merged, ...synthetic])
    setLastUpdate(new Date().toLocaleTimeString('ko-KR'))
    if (!silent) setLoading(false)
  }

  const isPastView  = topCat === 'past'
  const isComboView = topCat === 'signal'
  const filtered = games.filter(g => {
    const past = isInPast(g.starts_at)
    if (isComboView) return !past   // SignalView가 자체 필터 (미래 경기만)
    if (isPastView !== past) return false
    // 중분류(sport) 필터
    if (tab !== 'all' && g.sport !== tab) return false
    // 소분류(league) 필터 — '전체' 중분류일 때는 무시
    if (tab !== 'all' && subLeague !== 'all' && g.league !== subLeague) return false
    return true
  })
  const sorted = [...filtered].sort((a, b) =>
    isPastView ? (b.starts_at > a.starts_at ? 1 : -1) : (a.starts_at > b.starts_at ? 1 : -1)
  )

  // 해외구매율 총 베팅금액 순위 (스포츠별, 미래 경기만 대상)
  // 예: 축구 토트넘 4억(1위), 나폴리 6533만(2위)
  const pbRankMap = (() => {
    const map = {}
    const bySport = {}
    for (const g of games) {
      if (isInPast(g.starts_at)) continue
      const total = g.publicBetting?.total_money
      if (!total || total <= 0) continue
      if (!bySport[g.sport]) bySport[g.sport] = []
      bySport[g.sport].push({ id: g.matchup_id, total })
    }
    for (const sport of Object.keys(bySport)) {
      bySport[sport].sort((a, b) => b.total - a.total)
      bySport[sport].forEach((entry, i) => {
        map[entry.id] = { rank: i + 1, total: bySport[sport].length }
      })
    }
    return map
  })()
  // 현재 대분류(upcoming/past)에 맞는 활성 스포츠/리그 추출
  const activeSports = SPORT_GROUPS.filter(sg =>
    games.some(g => sg.leagues.includes(g.league) && isInPast(g.starts_at) === isPastView)
  )
  const currentSportGroup = SPORT_GROUPS.find(sg => sg.key === tab)
  const subLeagues = currentSportGroup
    ? currentSportGroup.leagues.filter(l => games.some(g => g.league === l && isInPast(g.starts_at) === isPastView))
    : []

  // 메인 탭별 액센트 컬러 (헤더 뱃지/하단탭에서 일관성)
  const tabAccent = {
    sports:    'indigo',
    baccarat:  'rose',
    powerball: 'emerald',
    more:      'slate',
  }[mainTab] || 'indigo'

  // 강제 업데이트 화면 (다른 UI 차단)
  if (forceUpdate) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-20 h-20 rounded-2xl bg-indigo-100 flex items-center justify-center mb-5">
          <span className="text-4xl">📲</span>
        </div>
        <h1 className="text-xl font-bold text-slate-900 mb-2">업데이트 필요</h1>
        <p className="text-sm text-slate-600 mb-1">새 버전이 출시되었습니다.</p>
        <p className="text-xs text-slate-400 mb-6">현재 {forceUpdate.current} → 최소 {forceUpdate.min}</p>
        <a href={forceUpdate.url} target="_blank" rel="noopener noreferrer"
          className="w-full max-w-xs bg-indigo-600 text-white text-base font-bold py-3 rounded-2xl active:bg-indigo-700">
          업데이트하러 가기
        </a>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 max-w-[520px] mx-auto"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 84px)' }}>
      {/* ── 상단 헤더 (간소화) ── */}
      <div className="sticky top-0 z-10 bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-100 dark:border-slate-800 px-4 pb-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 14px)' }}>
        <div className="flex justify-between items-center gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <img src="/app-icon.png" alt="샤프시그널 어플" className="w-9 h-9 rounded-xl flex-shrink-0 shadow-sm" />
            <h1 className="text-[18px] font-extrabold text-slate-900 dark:text-slate-100 tracking-tight truncate">샤프시그널</h1>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!isAdmin && (() => {
              const subEnd = sub?.sub_expires_at ? new Date(sub.sub_expires_at) : null
              const subDays = subEnd && subEnd > new Date()
                ? Math.ceil((subEnd - Date.now()) / 86400000) : 0
              if (subDays > 0) return (
                <span className="text-[12px] font-bold text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-950/50 px-3 py-1.5 rounded-full whitespace-nowrap">
                  구독 D-{subDays}
                </span>
              )
              if (daysLeft > 0) return (
                <span className={`text-[12px] font-bold px-3 py-1.5 rounded-full whitespace-nowrap ${
                  daysLeft <= 2 ? 'text-rose-600 bg-rose-100 dark:text-rose-300 dark:bg-rose-950/50' : 'text-indigo-600 bg-indigo-100 dark:text-indigo-300 dark:bg-indigo-950/50'
                }`}>
                  체험 D-{daysLeft}
                </span>
              )
              return null
            })()}
            <button onClick={() => { haptic.light(); fetchGames(); toast.info('새로고침 중...') }}
              aria-label="새로고침"
              className="w-10 h-10 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 active:bg-slate-200 dark:active:bg-slate-700 transition-colors flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600 dark:text-slate-300">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 16h5v5"/>
              </svg>
            </button>
            {!user && (
              <button onClick={onSignIn}
                disabled={signInLoading}
                className="text-[13px] font-bold text-white bg-indigo-600 active:bg-indigo-800 px-4 py-2 rounded-full transition-colors disabled:opacity-60 flex-shrink-0 shadow-sm">
                {signInLoading ? '연결 중' : '로그인'}
              </button>
            )}
          </div>
        </div>

        {/* ── 스포츠 탭 안 필터 (스포츠 탭일 때만) — 3단계 계층: 대분류 / 중분류 / 소분류 ── */}
        {mainTab === 'sports' && (
          <>
            {/* 대분류: 시그널픽 / 진행예정 / 지난경기 — 가로 컴팩트 카드 */}
            <div className="flex gap-2 mt-3">
              {[
                { k: 'signal',   l: '시그널픽',  active: 'bg-violet-600 text-white shadow-sm', iconBg: 'bg-violet-100 text-violet-600',
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.39 7.36H22l-6.19 4.5L18.2 21 12 16.5 5.8 21l2.39-7.14L2 9.36h7.61z"/></svg> },
                { k: 'upcoming', l: '진행예정',  active: 'bg-indigo-600 text-white shadow-sm', iconBg: 'bg-indigo-100 text-indigo-600',
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
                { k: 'past',     l: '지난경기',  active: 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 shadow-sm', iconBg: 'bg-slate-200 text-slate-600',
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/></svg> },
              ].map(c => {
                const isActive = topCat === c.k
                return (
                  <button key={c.k}
                    onClick={() => { setTopCat(c.k); setTab('all'); setSubLeague('all') }}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-2xl transition-all whitespace-nowrap
                      ${isActive ? c.active : 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-100 dark:border-slate-800'}`}>
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center
                      ${isActive ? 'bg-white/20' : c.iconBg}`}>
                      {c.icon}
                    </div>
                    <span className="text-[14px] font-extrabold">{c.l}</span>
                  </button>
                )
              })}
            </div>

            {/* 중분류: 전체 / 야구 / 축구 / 농구 / 하키 — 시그널픽 모드에서는 숨김 */}
            {!isComboView && (
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-3">
                <button
                  onClick={() => { setTab('all'); setSubLeague('all') }}
                  className={`px-4 py-2 rounded-full text-[14px] font-bold whitespace-nowrap transition-all
                    ${tab === 'all' ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 shadow-sm' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
                  전체
                </button>
                {activeSports.map(sg => (
                  <button key={sg.key}
                    onClick={() => { setTab(sg.key); setSubLeague('all') }}
                    className={`px-4 py-2 rounded-full text-[14px] font-bold whitespace-nowrap transition-all
                      ${tab === sg.key ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 shadow-sm' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
                    {sg.label}
                  </button>
                ))}
              </div>
            )}

            {/* 소분류(리그): 중분류가 'all'이 아닐 때만 표시 */}
            {!isComboView && currentSportGroup && subLeagues.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide mt-2">
                <button onClick={() => setSubLeague('all')}
                  className={`px-3 py-1.5 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition-all
                    ${subLeague === 'all' ? 'bg-slate-700 dark:bg-slate-300 text-white dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
                  전체
                </button>
                {subLeagues.map(l => (
                  <button key={l} onClick={() => setSubLeague(l)}
                    className={`px-3 py-1.5 rounded-full text-[12.5px] font-semibold whitespace-nowrap transition-all
                      ${subLeague === l ? 'bg-slate-700 dark:bg-slate-300 text-white dark:text-slate-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}>
                    {LEAGUE_FLAGS[l]} {l}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* 패턴 서브탭 (바카라 + 파워볼 통합) — 대분류 스타일 */}
        {mainTab === 'pattern' && (
          <div className="grid grid-cols-4 gap-2 mt-3">
            {[
              { k: 'ev',        l: 'EVOLUTION',   sub: '바카라',     active: 'bg-rose-500 text-white shadow-sm',      iconBg: 'bg-rose-100 text-rose-600',
                icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm7 3.5L8.5 12 12 17.5 15.5 12 12 6.5z"/></svg> },
              { k: 'pragmatic', l: '프라그마틱',  sub: '바카라',     active: 'bg-amber-500 text-white shadow-sm',     iconBg: 'bg-amber-100 text-amber-600',
                icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="white"/></svg> },
              { k: 'eos',       l: 'EOS',         sub: '파워볼 5분', active: 'bg-emerald-600 text-white shadow-sm',   iconBg: 'bg-emerald-100 text-emerald-600',
                icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/></svg> },
              { k: 'dh',        l: '동행',        sub: '파워볼 5분', active: 'bg-violet-600 text-white shadow-sm',    iconBg: 'bg-violet-100 text-violet-600',
                icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/><text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="900" fill="white">7</text></svg> },
            ].map(s => {
              const isActive = patternSub === s.k
              return (
                <button key={s.k}
                  onClick={() => setPatternSub(s.k)}
                  className={`flex flex-col items-center gap-1 py-2.5 px-1 rounded-2xl transition-all whitespace-nowrap
                    ${isActive ? s.active : 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border border-slate-100 dark:border-slate-800'}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center
                    ${isActive ? 'bg-white/20' : s.iconBg}`}>
                    {s.icon}
                  </div>
                  <span className="text-[12px] font-extrabold leading-tight">{s.l}</span>
                  <span className={`text-[10px] font-semibold leading-none ${isActive ? 'text-white/80' : 'text-slate-400'}`}>{s.sub}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── 메인 컨텐츠 (Swipe 래핑, Pull-to-Refresh 비활성) ── */}
      <SwipeNav tabs={['sports','mypicks','pattern','more']} activeKey={mainTab} onChange={setMainTab}>
      {mainTab === 'pattern' ? (
        (patternSub === 'ev' || patternSub === 'pragmatic') ? (
          <BaccaratTab
            hasAccess={hasAccess}
            user={user}
            onShowUpgrade={() => setShowUpgrade(true)}
            onSignIn={onSignIn}
            apiUrl={patternSub === 'pragmatic' ? BACCARAT_PRAGMATIC_API : BACCARAT_API}
          />
        ) : patternSub === 'dh' ? (
          <DhPowerballTab
            hasAccess={hasAccess}
            user={user}
            onShowUpgrade={() => setShowUpgrade(true)}
            onSignIn={onSignIn}
          />
        ) : (
          <PowerballTab
            hasAccess={hasAccess}
            user={user}
            onShowUpgrade={() => setShowUpgrade(true)}
            onSignIn={onSignIn}
          />
        )
      ) : mainTab === 'mypicks' ? (
        <div className="px-3 py-4 fade-in">
          <MyPicks user={user} hasAccess={hasAccess} isAdmin={isAdmin} />
        </div>
      ) : mainTab === 'more' ? (
        <MorePage
          user={user}
          sub={sub}
          isAdmin={isAdmin}
          daysLeft={daysLeft}
          onSignIn={onSignIn}
          onSignOut={onSignOut}
          onShowMyPage={() => setShowMyPage(true)}
          onShowUpgrade={() => setShowUpgrade(true)}
          onShowAdmin={() => setShowAdmin(true)}
          themeMode={themeMode}
          setThemeMode={setThemeMode}
        />
      ) : (
        <div className={`${loading ? '' : 'px-3 py-4 fade-in'}`}>
          {loading ? (
            <SkeletonList count={5} />
          ) : isComboView ? (
            <SignalView games={games} hasAccess={hasAccess} isGuest={!user}
              onShowUpgrade={user ? () => setShowUpgrade(true) : onSignIn} />
          ) : filtered.length === 0 ? (
            <div className="text-center text-slate-400 dark:text-slate-500 py-20 text-sm">경기 없음</div>
          ) : (
            sorted.map(g => <GameCard key={g.matchup_id} game={g}
              pbRank={pbRankMap[g.matchup_id]}
              hasAccess={hasAccess} isGuest={!user}
              onShowUpgrade={user ? () => setShowUpgrade(true) : onSignIn}
              onClick={() => setSelected(g)} />)
          )}
        </div>
      )}
      </SwipeNav>

      {/* ── 하단 탭바 ── */}
      <BottomTabBar mainTab={mainTab} setMainTab={setMainTab} hasNewAlert={false} />

      {/* ── Toast 컨테이너 ── */}
      <ToastContainer />

      {selected && <HistoryModal game={selected} onClose={() => setSelected(null)} />}
      {showAdmin && <AdminScreen onClose={() => setShowAdmin(false)} />}
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
      {pickModalData && <PickSaveModal data={pickModalData} onClose={() => setPickModalData(null)} />}
      {showAddPickFlow && <AddPickFlow betmanDirect={betmanDirect} games={games} onClose={() => setShowAddPickFlow(false)} />}
      {showMyPage && (
        <MyPage
          user={user}
          sub={sub}
          onSignOut={onSignOut}
          onShowUpgrade={() => { setShowMyPage(false); setShowUpgrade(true) }}
          onClose={() => setShowMyPage(false)}
        />
      )}
    </div>
  )
}

// ── 앱 진입점 (인증 래퍼) ────────────────────────────────────
// ── 다크모드 훅 ──────────────────────────────────────────
function useDarkMode() {
  const [mode, setMode] = useState(() => {
    if (typeof window === 'undefined') return 'light'
    return localStorage.getItem('sharp_theme') || 'system'  // 'light' | 'dark' | 'system'
  })

  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const effective = mode === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : mode
      root.classList.toggle('dark', effective === 'dark')
    }
    apply()
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [mode])

  const setTheme = (next) => {
    localStorage.setItem('sharp_theme', next)
    setMode(next)
  }

  return [mode, setTheme]
}

export default function App() {
  const [user, setUser]             = useState(null)
  const [sub, setSub]               = useState(null)
  const [authReady, setReady]       = useState(false)
  const [showTrialPrompt, setShowTrialPrompt] = useState(false)
  const [signInLoading, setSignInLoading] = useState(false)
  const [themeMode, setThemeMode]   = useDarkMode()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) loadSub(session.user.id)
      setReady(true)
    })

    const { data: { subscription: authSub } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      setUser(session?.user ?? null)
      if (session?.user) loadSub(session.user.id)
      else { setSub(null); setShowTrialPrompt(false) }
    })

    CapApp.addListener('appUrlOpen', async ({ url }) => {
      if (url?.startsWith('com.sharpsignal.app://auth-callback')) {
        await Browser.close()
        const hash   = url.split('#')[1] || ''
        const params = new URLSearchParams(hash)
        const access_token  = params.get('access_token')
        const refresh_token = params.get('refresh_token')
        if (access_token) {
          const { data } = await supabase.auth.setSession({ access_token, refresh_token })
          if (data.user) loadSub(data.user.id)
        }
      }
    })

    return () => authSub.unsubscribe()
  }, [])

  async function loadSub(userId) {
    const { data } = await supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle()
    if (!data) {
      // 첫 로그인: 구독 레코드 생성
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: inserted } = await supabase
          .from('subscriptions').insert({ user_id: user.id, email: user.email })
          .select().maybeSingle()
        setSub(inserted)
        setShowTrialPrompt(true) // 신규 유저 → 체험 프롬프트
      }
    } else {
      setSub(data)
      // 체험도 구독도 없으면 프롬프트 표시
      if (!data.trial_started_at && !data.sub_expires_at) setShowTrialPrompt(true)
    }
    // device_id 자동 등록 (체험 시작 여부 무관) — 중복 진단용
    try {
      const deviceId = await getDeviceId()
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token
      if (deviceId && token) {
        fetch(`${API_BASE}/api/me/device`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deviceId }),
        }).catch(() => {})
      }
    } catch (_) {}
  }

  const [showLoginModal, setShowLoginModal] = useState(false)

  async function signInWith(provider) {
    if (signInLoading) return
    setSignInLoading(true)
    try {
      const isNative = Capacitor.isNativePlatform()
      const redirectTo = isNative
        ? 'https://pinnacle-bot.vercel.app'
        : `${window.location.origin}`
      try { await Browser.close() } catch (_) {}
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo, skipBrowserRedirect: isNative },
      })
      if (error) throw error
      if (isNative && data?.url) {
        await Browser.open({ url: data.url, presentationStyle: 'fullscreen' })
      }
      setShowLoginModal(false)
    } catch (e) {
      console.error('[signIn]', e)
      toast.error('로그인 오류: ' + (e?.message || String(e)))
    } finally {
      setSignInLoading(false)
    }
  }
  // 헤더의 onSignIn은 모달 띄우기
  const openLoginModal = () => setShowLoginModal(true)

  async function signOut() {
    await supabase.auth.signOut()
    setUser(null); setSub(null); setShowTrialPrompt(false)
  }

  function handleTrialStart() {
    setShowTrialPrompt(false)
    // sub 재조회
    if (user) loadSub(user.id)
  }

  // 웹 브라우저 접속 차단 (앱 전용)
  if (!Capacitor.isNativePlatform()) {
    const hash = window.location.hash
    // OAuth 콜백 → 토큰을 앱 딥링크로 릴레이
    if (hash.includes('access_token=')) {
      window.location.href = `com.sharpsignal.app://auth-callback${hash}`
      return null
    }
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center mb-5">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">샤프시그널</h1>
        <p className="text-slate-500 text-sm mb-6">앱 전용 서비스입니다.<br/>안드로이드 앱에서 이용해주세요.</p>
        <a href="https://play.google.com/store/apps/details?id=com.sharpsignal.app"
          className="bg-indigo-600 text-white text-sm font-semibold px-6 py-3 rounded-2xl">
          Play Store에서 다운로드
        </a>
      </div>
    )
  }

  if (!authReady) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-slate-400 text-sm">로딩 중...</div>
    </div>
  )

  const isAdmin   = user ? user.email === ADMIN_EMAIL : false
  const isOnTrial = sub?.trial_started_at &&
    new Date(new Date(sub.trial_started_at).getTime() + TRIAL_DAYS * 86400000) > new Date()
  const isSubbed  = sub?.sub_expires_at && new Date(sub.sub_expires_at) > new Date()
  const hasAccess = isAdmin || isOnTrial || isSubbed

  return (
    <ErrorBoundary>
      <MainApp
        user={user}
        isAdmin={isAdmin}
        hasAccess={hasAccess}
        sub={sub}
        onSignOut={signOut}
        onSignIn={openLoginModal}
        signInLoading={signInLoading}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
      />
      {showLoginModal && (
        <LoginModal
          onClose={() => setShowLoginModal(false)}
          onPick={signInWith}
          loading={signInLoading}
        />
      )}
      {showTrialPrompt && !isAdmin && (
        <TrialPromptModal
          onStart={handleTrialStart}
          onDecline={() => setShowTrialPrompt(false)}
        />
      )}
    </ErrorBoundary>
  )
}
