"""
previewn.com/odds/proto 구매율 스크래퍼 (Playwright + GraphQL 인터셉트)
야구(MLB/KBO/NPB): ML + O/U
축구: 1X2 + O/U
농구(NBA/KBL): ML + 핸디 + O/U
"""

import asyncio
import os
import re
from datetime import datetime, timezone, timedelta
from playwright.async_api import async_playwright

KST = timezone(timedelta(hours=9))

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# 야구에서 원하는 bet_type
BASEBALL_TYPES = {"winLose", "overUnder"}
# 축구에서 원하는 bet_type
SOCCER_TYPES   = {"winLose", "overUnder"}
# 농구에서 원하는 bet_type
BASKET_TYPES   = {"winLose", "handi", "overUnder"}

BASEBALL_BBTYPES = {"mlb", "kbo", "npb", "baseball"}
BASKETBALL_BBTYPES = {"nba", "kbl", "basketball"}
# 나머지는 soccer

# 한글 팀명 → 영문 약자 (MLB/NBA 매핑)
# 팀명 정규화(normalize) 후 비교: 앞뒤공백 제거 + 연속공백→단일공백
KR_ABBREV = {
    # ── MLB 단축명 ─────────────────────────────────────
    '볼티모어': 'BAL', '보스턴': 'BOS', '뉴욕Y': 'NYY', '뉴욕M': 'NYM',
    '탬파베이': 'TB', '토론토': 'TOR', '클리블랜드': 'CLE',
    '시카고W': 'CWS', '시카고C': 'CHC', '디트로이트': 'DET',
    '캔자스시티': 'KC', '미네소타': 'MIN', '휴스턴': 'HOU',
    'LA에': 'LAA', 'LA다': 'LAD', '애슬레틱스': 'ATH', '오클랜드': 'ATH',
    '시애틀': 'SEA', '텍사스': 'TEX', '애틀랜타': 'ATL',
    '마이애미': 'MIA', '필라델피아': 'PHI', '워싱턴': 'WSH',
    '밀워키': 'MIL', '신시내티': 'CIN', '피츠버그': 'PIT',
    '세인트루이스': 'STL', '콜로라도': 'COL', '애리조나': 'AZ',
    '샌디에이고': 'SD', '샌프란시스코': 'SF',
    # ── MLB 풀네임/영문 변형 ────────────────────────────
    '뉴욕메츠': 'NYM', '뉴욕양키스': 'NYY',
    '콜로라도로키스': 'COL', '콜로라도 로키스': 'COL',
    'LAA': 'LAA', 'LAD': 'LAD',
    'LA에인절스': 'LAA', 'LA다저스': 'LAD',
    # ── NBA 단축명 ─────────────────────────────────────
    '골든스테이트': 'GSW', 'LA클': 'LAC', 'LA레': 'LAL',
    '댈러스': 'DAL', '덴버': 'DEN', '인디애나': 'IND',
    '멤피스': 'MEM', '뉴올리언스': 'NOP', '뉴욕K': 'NYK',
    '오클라호마': 'OKC', '올랜도': 'ORL', '피닉스': 'PHX',
    '포틀랜드': 'POR', '새크라멘토': 'SAC', '샌안토니오': 'SAS',
    '유타': 'UTA', '브루클린': 'BKN', '샬럿': 'CHA',
    # ── NBA 풀네임 (실제 previewn 표기) ─────────────────
    '보스턴 셀틱스': 'BOS', '브루클린 네츠': 'BKN',
    '뉴욕 닉스': 'NYK', '필라델피아 76': 'PHI', '필라델피아 76어스': 'PHI',
    '토론토 랩터스': 'TOR', '골든스테이트 워리어스': 'GSW',
    'LA 클리퍼스': 'LAC', 'LA 레이커스': 'LAL',
    '피닉스 선즈': 'PHX', '새크라멘토 킹스': 'SAC',
    '댈러스 매버릭스': 'DAL', '휴스턴 로케츠': 'HOU',
    '멤피스 그리즐리스': 'MEM', '뉴올리언스 펠리컨스': 'NOP',
    '샌안토니오 스퍼스': 'SAS', '오클라호마 시티 썬더': 'OKC',
    '덴버 너게츠': 'DEN', '미네소타 팀버울브스': 'MIN',
    '포틀랜드 트레일블레이저스': 'POR', '포틀랜드 트레일': 'POR',
    '유타 재즈': 'UTA', '클리블랜드 캐벌리어스': 'CLE',
    '인디애나 페이서스': 'IND', '시카고 불스': 'CHI',
    '디트로이트 피스톤스': 'DET', '밀워키 벅스': 'MIL',
    '마이애미 히트': 'MIA', '올랜도 매직': 'ORL',
    '샬럿 호네츠': 'CHA', '애틀랜타 호크스': 'ATL',
    '워싱턴 위저즈': 'WSH',
    # ── 공통 (MLB/NBA 동일 도시) ─────────────────────
    '보스턴': 'BOS', '클리블랜드': 'CLE', '마이애미': 'MIA',
    '밀워키': 'MIL', '미네소타': 'MIN', '필라델피아': 'PHI',
    '시카고': 'CHI', '애틀랜타': 'ATL', '디트로이트': 'DET',
    '휴스턴': 'HOU', '토론토': 'TOR', '워싱턴': 'WSH',
    # ── KBO (피나클 영문 풀네임) ──────────────────────
    '두산 베어스': 'Doosan Bears', '두산베어스': 'Doosan Bears', '두산': 'Doosan Bears',
    '한화 이글스': 'Hanwha Eagles', '한화이글스': 'Hanwha Eagles', '한화': 'Hanwha Eagles',
    'KT 위즈': 'KT Wiz', 'kt wiz': 'KT Wiz', 'KT위즈': 'KT Wiz', 'kt 위즈': 'KT Wiz', 'KT': 'KT Wiz',
    'KIA 타이거즈': 'Kia Tigers', 'KIA타이거즈': 'Kia Tigers',
    '기아 타이거즈': 'Kia Tigers', '기아타이거즈': 'Kia Tigers', 'KIA': 'Kia Tigers', '기아': 'Kia Tigers',
    '키움 히어로즈': 'Kiwoom Heroes', '키움히어로즈': 'Kiwoom Heroes', '키움': 'Kiwoom Heroes',
    'LG 트윈스': 'LG Twins', 'LG트윈스': 'LG Twins', 'LG': 'LG Twins',
    '롯데 자이언츠': 'Lotte Giants', '롯데자이언츠': 'Lotte Giants', '롯데': 'Lotte Giants',
    'NC 다이노스': 'NC Dinos', 'NC다이노스': 'NC Dinos', 'NC': 'NC Dinos',
    'SSG 랜더스': 'SSG Landers', 'SSG랜더스': 'SSG Landers', 'SSG': 'SSG Landers',
    '삼성 라이온즈': 'Samsung Lions', '삼성라이온즈': 'Samsung Lions', '삼성': 'Samsung Lions',
    # ── NPB (피나클 영문 풀네임) ──────────────────────
    '요코하마 DeNA 베이스타스': 'Yokohama Bay Stars',
    '요코하마DeNA베이스타스': 'Yokohama Bay Stars',
    '요코하마 DeNA': 'Yokohama Bay Stars', '요코하마': 'Yokohama Bay Stars',
    '요미우리 자이언츠': 'Yomiuri Giants', '요미우리자이언츠': 'Yomiuri Giants', '요미우리': 'Yomiuri Giants',
    '한신 타이거즈': 'Hanshin Tigers', '한신타이거즈': 'Hanshin Tigers',
    '한신 타이거스': 'Hanshin Tigers', '한신': 'Hanshin Tigers',
    '후쿠오카 소프트뱅크 호크스': 'Fukuoka Softbank Hawks',
    '소프트뱅크 호크스': 'Fukuoka Softbank Hawks', '소프트뱅크': 'Fukuoka Softbank Hawks',
    '후쿠오카': 'Fukuoka Softbank Hawks',
    '오릭스 버펄로스': 'Orix Buffaloes', '오릭스버펄로스': 'Orix Buffaloes', '오릭스': 'Orix Buffaloes',
    '주니치 드래곤즈': 'Chunichi Dragons', '주니치드래곤즈': 'Chunichi Dragons',
    '주니치 드래건스': 'Chunichi Dragons', '주니치': 'Chunichi Dragons',
    '히로시마 도요 카프': 'Hiroshima Toyo Carp',
    '히로시마 카프': 'Hiroshima Toyo Carp', '히로시마': 'Hiroshima Toyo Carp',
    '히로시바 도요 카프': 'Hiroshima Toyo Carp',
    '도쿄 야쿠르트 스왈로즈': 'Tokyo Yakult Swallows',
    '야쿠르트 스왈로즈': 'Tokyo Yakult Swallows',
    '야쿠르트 스왈로스': 'Tokyo Yakult Swallows', '야쿠르트': 'Tokyo Yakult Swallows',
    '홋카이도 닛폰햄 파이터스': 'Hokkaido Nippon-Ham Fighters',
    '니혼햄 파이터스': 'Hokkaido Nippon-Ham Fighters',
    '닛폰햄 파이터스': 'Hokkaido Nippon-Ham Fighters', '닛폰햄': 'Hokkaido Nippon-Ham Fighters',
    '도호쿠 라쿠텐 골든이글스': 'Tohoku Rakuten Golden Eagles',
    '라쿠텐 이글스': 'Tohoku Rakuten Golden Eagles',
    '라쿠텐 골든이글스': 'Tohoku Rakuten Golden Eagles', '라쿠텐': 'Tohoku Rakuten Golden Eagles',
    '사이타마 세이부 라이온즈': 'Saitama Seibu Lions',
    '세이부 라이온즈': 'Saitama Seibu Lions',
    '세이부 라이온스': 'Saitama Seibu Lions', '세이부': 'Saitama Seibu Lions',
    '지바 롯데 마린즈': 'Chiba Lotte Marines',
    '지바 롯데 마린스': 'Chiba Lotte Marines', '지바 롯데': 'Chiba Lotte Marines',
}

# 한글 축구팀명 → 피나클 영문 팀명 (축구는 약자 없이 풀네임 매핑)
KR_SOCCER: dict[str, str] = {
    # ── EPL ─────────────────────────────────────────
    '아스널': 'Arsenal', '첼시': 'Chelsea', '리버풀': 'Liverpool',
    '맨체스터시티': 'Manchester City', '맨체스터 시티': 'Manchester City',
    '토트넘홋스퍼': 'Tottenham', '토트넘 홋스퍼': 'Tottenham',
    '뉴캐슬유나이티드': 'Newcastle', '뉴캐슬 유나이티드': 'Newcastle',
    '맨체스터유나이티드': 'Manchester United',
    '웨스트햄유나이티드': 'West Ham', '웨스트햄 유나이티드': 'West Ham',
    '아스톤빌라': 'Aston Villa', '애스턴 빌라': 'Aston Villa', '애스턴빌라': 'Aston Villa',
    '에버턴': 'Everton', '풀럼': 'Fulham', '울버햄프턴원더러스': 'Wolverhampton',
    '울버햄프턴 원더러스': 'Wolverhampton', '브렌트퍼드': 'Brentford',
    '브라이튼': 'Brighton', '크리스털팰리스': 'Crystal Palace',
    '크리스털 팰리스': 'Crystal Palace', '노팅엄포리스트': 'Nottingham Forest',
    '노팅엄 포리스트': 'Nottingham Forest', '본머스': 'Bournemouth',
    '레스터시티': 'Leicester City', '레스터 시티': 'Leicester City',
    '사우샘프턴': 'Southampton', '입스위치타운': 'Ipswich Town',
    '입스위치 타운': 'Ipswich Town', '루턴타운': 'Luton Town',
    '번리': 'Burnley', '셰필드유나이티드': 'Sheffield United',
    '셰필드 유나이티드': 'Sheffield United',
    # ── La Liga ─────────────────────────────────────
    '레알마드리드': 'Real Madrid', '바르셀로나': 'Barcelona',
    '아틀레티코마드리드': 'Atletico Madrid', '아틀레티코 마드리드': 'Atletico Madrid',
    '세비야': 'Sevilla', '레알베티스': 'Real Betis', '레알소시에다드': 'Real Sociedad',
    '아틀레틱빌바오': 'Athletic Bilbao', '비야레알': 'Villarreal',
    '발렌시아': 'Valencia', '헤타페': 'Getafe', '오사수나': 'Osasuna',
    '라요바예카노': 'Rayo Vallecano', '알라베스': 'Alaves',
    '레알오비에도': 'Real Oviedo', '지로나': 'Girona',
    'RC셀타데비고': 'Celta Vigo', '셀타데비고': 'Celta Vigo', '엘체': 'Elche',
    'RCD마요르카': 'Mallorca', '마요르카': 'Mallorca',
    '웨스트브로미치앨비언': 'West Bromwich Albion', '웨스트브로미치 앨비언': 'West Bromwich Albion',
    'RCD에스파뇰': 'Espanyol', '레반테': 'Levante',
    # ── Bundesliga ───────────────────────────────────
    '바이에른뮌헨': 'Bayern Munich', '바이에른 뮌헨': 'Bayern Munich',
    '도르트문트': 'Borussia Dortmund', '바이어04레버쿠젠': 'Bayer Leverkusen',
    '바이어 04 레버쿠젠': 'Bayer Leverkusen', '묀헨글라트바흐': 'Borussia Monchengladbach',
    'RB라이프치히': 'RB Leipzig', '프랑크푸르트': 'Eintracht Frankfurt',
    'SC프라이부르크': 'Freiburg', '베르더브레멘': 'Werder Bremen',
    'VfB슈투트가르트': 'VfB Stuttgart', 'VfL볼프스부르크': 'Wolfsburg',
    'TSG1899호펜하임': 'TSG Hoffenheim', '아우크스부르크': 'Augsburg',
    '쾰른': 'FC Koln', '함부르크': 'Hamburger SV',
    '우니온베를린': 'Union Berlin', '장크트파울리': 'St. Pauli',
    '하이덴하임': 'Heidenheim',
    # ── Serie A ──────────────────────────────────────
    '유벤투스': 'Juventus', 'AC밀란': 'AC Milan', 'AS로마': 'AS Roma',
    'SSC나폴리': 'Napoli', '인테르나치오날레밀라노': 'Inter Milan',
    '인테르나치오날레 밀라노': 'Inter Milan', '볼로냐': 'Bologna',
    '아탈란타BC': 'Atalanta', '피오렌티나': 'Fiorentina',
    'ACF피오렌티나': 'Fiorentina', 'SS라치오': 'Lazio',
    '토리노': 'Torino', '제노아': 'Genoa', '파르마': 'Parma',
    '엘라스베로나': 'Hellas Verona', 'US레체': 'Lecce',
    '코모1907': 'Como', 'US사수올로': 'Sassuolo', '칼리아리': 'Cagliari',
    'US크레모네세': 'Cremonese', '피사SC': 'Pisa', '우디네세': 'Udinese',
    # ── Ligue 1 ──────────────────────────────────────
    '파리생제르맹': 'Paris Saint-Germain', '파리 생제르맹': 'Paris Saint-Germain',
    '올랭피크드마르세유': 'Marseille', '올랭피크리옹': 'Lyon',
    'AS모나코': 'Monaco', 'OGC니스': 'Nice', '릴OSC': 'Lille',
    'RC랑스': 'Lens', '스타드렌': 'Rennes', '낭트': 'Nantes',
    'RC스트라스부르': 'Strasbourg', '스타드브레스투아29': 'Brest',
    '툴루즈': 'Toulouse', 'AJ오세르': 'Auxerre', '로리앙': 'Lorient',
    '앙제SCO': 'Angers', '메스': 'Metz', '르아브르AC': 'Le Havre',
    '파리FC': 'Paris FC',
    # ── Eredivisie (네덜란드) ─────────────────────────
    'AFC아약스': 'Ajax', '페예노르트': 'Feyenoord', 'PSV': 'PSV',
    'NAC브레다': 'NAC Breda', 'NEC네이메헌': 'NEC Nijmegen',
    'SC헤이렌베인': 'Heerenveen', 'SBV엑셀시오르': 'Excelsior',
    '트벤테': 'FC Twente', '포르튀나시타르트': 'Fortuna Sittard',
    '헤라클레스알멜로': 'Heracles', '폴렌담': 'Volendam',
    '위트레흐트': 'Utrecht', '흐로닝언': 'Groningen',
    # ── Championship / EFL ───────────────────────────
    '리즈유나이티드': 'Leeds United', '미들즈브러': 'Middlesbrough',
    '셰필드웬즈데이': 'Sheffield Wednesday', '선덜랜드': 'Sunderland',
    '밀월': 'Millwall', '스완지시티': 'Swansea City', '왓포드': 'Watford',
    '노리치시티': 'Norwich City', '스토크시티': 'Stoke City',
    '버밍엄시티': 'Birmingham City', '더비카운티': 'Derby County',
    '브리스틀시티': 'Bristol City', '코번트리시티': 'Coventry City',
    '렉섬': 'Wrexham', '찰턴애슬레틱': 'Charlton Athletic',
    '퀸즈파크레인저스': 'QPR', '포츠머스': 'Portsmouth',
    '헐시티': 'Hull City', '옥스퍼드유나이티드': 'Oxford United',
    '프레스턴노스엔드': 'Preston North End',
    # ── K리그 1 ──────────────────────────────────────
    'FC서울': 'FC Seoul', '울산HDFC': 'Ulsan HD', '전북현대모터스': 'Jeonbuk Hyundai',
    '전북 현대모터스': 'Jeonbuk Hyundai', '포항스틸러스': 'Pohang Steelers',
    '인천유나이티드': 'Incheon United', '강원FC': 'Gangwon',
    '광주FC': 'Gwangju FC', '대전하나시티즌': 'Daejeon Citizen',
    '제주SKFC': 'Jeju United', '김천상무프로축구단': 'Gimcheon Sangmu',
    '수원삼성블루윙즈': 'Suwon Samsung',
    # ── K리그 2 / lower ──────────────────────────────
    '성남FC': 'Seongnam FC', '부산아이파크': 'Busan IPark',
    '경남FC': 'Gyeongnam FC', '서울이랜드': 'Seoul E-Land',
    '수원FC': 'Suwon FC', '부천FC1995': 'Bucheon FC',
    '안산그리너스': 'Ansan Greeners', '충남아산프로축구단': 'Chungnam Asan',
    '김포FC': 'Gimpo FC', '천안시티FC': 'Cheonan City',
    '충북청주프로축구단': 'Cheongju FC', '용인FC': 'Yongin FC',
    '화성FC': 'Hwaseong FC', '파주프런티어': 'Paju Citizen',
    '전남드래곤즈': 'Jeonnam Dragons', 'FC안양': 'FC Anyang',
    '김해FC2008': 'Gimhae FC',
    # ── MLS ──────────────────────────────────────────
    'LAFC': 'LAFC', 'LA갤럭시': 'LA Galaxy', '인터마이애미CF': 'Inter Miami',
    '애틀랜타유나이티드FC': 'Atlanta United', '뉴욕레드불스': 'New York Red Bulls',
    '뉴욕시티FC': 'New York City FC', '뉴잉글랜드레벌루션': 'New England Revolution',
    '시애틀사운더스FC': 'Seattle Sounders', '포틀랜드팀버스': 'Portland Timbers',
    'DC유나이티드': 'DC United', 'FC달라스': 'FC Dallas', 'FC댈러스': 'FC Dallas',
    '콜럼버스크루': 'Columbus Crew', '토론토FC': 'Toronto FC',
    '올랜도시티SC': 'Orlando City', '내슈빌SC': 'Nashville SC',
    '스포팅캔자스시티': 'Sporting Kansas City', '콜로라도래피즈': 'Colorado Rapids',
    '밴쿠버화이트캡스FC': 'Vancouver Whitecaps', '새너제이어스퀘이크스': 'San Jose Earthquakes',
    '레알솔트레이크': 'Real Salt Lake', '미네소타유나이티드FC': 'Minnesota United',
    '세인트루이스시티SC': 'St. Louis City', '오스틴FC': 'Austin FC',
    '시카고파이어FC': 'Chicago Fire', '샬럿FC': 'Charlotte FC',
    '샌디에이고FC': 'San Diego FC', '오클랜드FC': 'Oakland FC',
    '휴스턴다이너모FC': 'Houston Dynamo', 'CF몽레알': 'CF Montreal',
    '필라델피아유니언': 'Philadelphia Union',
    # ── J리그 ─────────────────────────────────────────
    '교토상가FC': 'Kyoto Sanga', '교토 상가 FC': 'Kyoto Sanga', '교토상가': 'Kyoto Sanga',
    '도쿄베르디': 'Tokyo Verdy', '도쿄 베르디': 'Tokyo Verdy',
    '비셀고베': 'Vissel Kobe', '비셀 고베': 'Vissel Kobe',
    '요코하마F마리노스': 'Yokohama F. Marinos', '가와사키프론탈레': 'Kawasaki Frontale',
    '가시마앤틀러스': 'Kashima Antlers', '감바오사카': 'Gamba Osaka',
    '우라와레드다이아몬즈': 'Urawa Red Diamonds', '나고야그램퍼스': 'Nagoya Grampus',
    '세레소오사카': 'Cerezo Osaka', '산프레체히로시마': 'Sanfrecce Hiroshima',
    'FC도쿄': 'FC Tokyo', '아비스파후쿠오카': 'Avispa Fukuoka',
    '가시와레이솔': 'Kashiwa Reysol', '홋카이도콘사도레삿포로': 'Consadole Sapporo',
    '베갈타센다이': 'Vegalta Sendai', '시미즈에스펄스': 'Shimizu S-Pulse',
    'FC마치다젤비아': 'Machida Zelvia', 'FC이마바리': 'FC Imabari',
    'RB오미야아르디자': 'Omiya Ardija', 'V바렌나가사키': 'V-Varen Nagasaki',
    '몬테디오야마가타': 'Montedio Yamagata', '미토홀리호크': 'Mito Hollyhock',
    '카탈레도야마': 'Kataller Toyama', '블라우블리츠아키타': 'Blaublitz Akita',
    '이와키FC': 'Iwaki FC', '반라우레하치노헤FC': 'Vanraure Hachinohe',
    '요미우리': 'Yomiuri', '요미우리 자이언츠': 'Yomiuri Giants',
    '제프유나이티드지바': 'JEF United Chiba', '파지아노오카야마': 'Fagiano Okayama',
    '후지에다MYFC': 'Fujiedha MYFC',
    # ── A-League (호주) ───────────────────────────────
    '멜버른빅토리': 'Melbourne Victory', '멜버른시티': 'Melbourne City',
    '시드니FC': 'Sydney FC', '웨스턴시드니원더러스': 'Western Sydney Wanderers',
    '브리즈번로어': 'Brisbane Roar', '퍼스글로리': 'Perth Glory',
    '애들레이드유나이티드': 'Adelaide United', '센트럴코스트매리너스': 'Central Coast Mariners',
    '웰링턴피닉스': 'Wellington Phoenix', '맥아서FC': 'Macarthur FC',
    '뉴캐슬제츠': 'Newcastle Jets',
    # ── MLS (추가) ────────────────────────────────────
    'FC신시내티': 'FC Cincinnati', 'FC 신시내티': 'FC Cincinnati',
    # ── 기타 ──────────────────────────────────────────
    '알아헐리사우디': 'Al-Ahli', 'FSV마인츠05': 'Mainz 05',
}


def _sb():
    from supabase import create_client
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def _pct(count, total):
    """raw count → 정수 % (total=0이면 None)"""
    if not total or count is None:
        return None
    return round(count / total * 100)


def _normalize(name: str) -> str:
    """연속 공백 제거 + 앞뒤 트림"""
    import re as _re
    return _re.sub(r'\s+', ' ', (name or "").strip())

def _abbrev(name: str) -> str:
    n = _normalize(name)
    return KR_ABBREV.get(n, "")

def _abbrev_soccer(name: str) -> str:
    n = _normalize(name)
    return KR_SOCCER.get(n, "")

def _sport(bbtype: str) -> str:
    bb = bbtype.lower()
    if any(x in bb for x in BASEBALL_BBTYPES):
        return 'baseball'
    if any(x in bb for x in BASKETBALL_BBTYPES):
        return 'basketball'
    return 'soccer'


def _league(bbtype: str) -> str:
    b = bbtype.upper()
    MAP = {
        'MLB': 'MLB', 'KBO': 'KBO', 'NPB': 'NPB',
        'NBA': 'NBA', 'KBL': 'KBL',
    }
    for k, v in MAP.items():
        if k in b:
            return v
    return bbtype.upper()


def parse_odds(items: list) -> list[dict]:
    """GraphQL odds 항목 리스트 → game dict 리스트"""
    # 게임 키: (bbtype, home_team, away_team) 로 그룹핑
    games: dict[tuple, dict] = {}
    unmatched = set()

    for item in items:
        home = (item.get("home_team_name") or "").strip()
        away = (item.get("away_team_name") or "").strip()
        bbtype = (item.get("bbtype") or "").lower()
        bet_type = item.get("bet_type") or ""
        w = item.get("w_bet_count")
        d = item.get("d_bet_count")
        l = item.get("l_bet_count")

        # 미정 / 데이터 없음 skip
        if home == "미정" or away == "미정" or home == "" or away == "":
            continue
        if w is None and d is None and l is None:
            continue

        sport = _sport(bbtype)

        # 원하는 bet_type 필터
        if sport == 'baseball' and bet_type not in BASEBALL_TYPES:
            continue
        if sport == 'soccer' and bet_type not in SOCCER_TYPES:
            continue
        if sport == 'basketball' and bet_type not in BASKET_TYPES:
            continue

        key = (bbtype, home, away)
        if key not in games:
            league = _league(bbtype)
            if sport == 'soccer':
                home_abbr = _abbrev_soccer(home)
                away_abbr = _abbrev_soccer(away)
                # 미매핑 축구팀 로깅
                if not home_abbr:
                    unmatched.add(f"{league}:{_normalize(home)}")
                if not away_abbr:
                    unmatched.add(f"{league}:{_normalize(away)}")
            else:
                home_abbr = _abbrev(home)
                away_abbr = _abbrev(away)
                # MLB/NBA/KBO/NPB 미매핑 팀명 기록
                if league in ('MLB', 'NBA', 'KBO', 'NPB'):
                    if not home_abbr:
                        unmatched.add(f"{league}:{_normalize(home)}")
                    if not away_abbr:
                        unmatched.add(f"{league}:{_normalize(away)}")

            games[key] = {
                "sport":   sport,
                "league":  league,
                "home":    home,
                "away":    away,
                "home_abbr": home_abbr,
                "away_abbr": away_abbr,
                "ml_bets_home": None, "ml_bets_away": None, "ml_bets_draw": None,
                "ou_bets_over": None, "ou_bets_under": None,
                "sp_bets_home": None, "sp_bets_away": None,
                "updated_at": datetime.now(KST).isoformat(),
            }

        g = games[key]

        if bet_type == "winLose":
            # 첫 번째 winLose만 사용 (일반승패) — 전반승패·승1패 등 덮어쓰기 방지
            if g["ml_bets_home"] is None:
                total = (w or 0) + (d or 0) + (l or 0)
                if sport == 'soccer' and d is not None:
                    # 축구 승무패: w=홈승, d=무, l=원정승
                    g["ml_bets_home"] = _pct(w, total)
                    g["ml_bets_draw"] = _pct(d, total)
                    g["ml_bets_away"] = _pct(l, total)
                else:
                    # 야구/농구 승패: w=홈승, l=원정승
                    total2 = (w or 0) + (l or 0)
                    g["ml_bets_home"] = _pct(w, total2)
                    g["ml_bets_away"] = _pct(l, total2)

        elif bet_type == "overUnder":
            # 첫 번째 overUnder만 사용 (일반언오버) — 전반언오버 덮어쓰기 방지
            if g["ou_bets_over"] is None:
                total = (w or 0) + (l or 0)
                g["ou_bets_under"] = _pct(w, total)
                g["ou_bets_over"]  = _pct(l, total)

        elif bet_type == "handi":
            # 첫 번째 handi만 사용 (일반핸디) — 전반핸디 덮어쓰기 방지
            if g["sp_bets_home"] is None:
                total = (w or 0) + (l or 0)
                g["sp_bets_home"] = _pct(w, total)
                g["sp_bets_away"] = _pct(l, total)

    result = list(games.values())
    if unmatched:
        print(f"  [미매핑 팀] {sorted(unmatched)}")
    return result


async def scrape_proto(page) -> list[dict]:
    print("previewn 스크래핑 중...")

    odds_data = []

    async def capture_response(res):
        if "graphql" in res.url:
            try:
                body = await res.json()
                data = body.get("data", {})
                if "odds" in data and data["odds"]:
                    odds_data.extend(data["odds"])
            except Exception:
                pass

    page.on("response", capture_response)

    try:
        await page.goto("https://www.previewn.com/odds/proto",
                        wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(10000)
    except Exception as e:
        print(f"페이지 로드 실패: {e}")
        return []

    print(f"GraphQL odds 항목 {len(odds_data)}건 캡처")
    games = parse_odds(odds_data)

    # 스포츠별 샘플 출력
    from itertools import groupby
    by_sport = {}
    for g in games:
        by_sport.setdefault(g['sport'], []).append(g)
    for sport, gs in by_sport.items():
        print(f"\n[{sport.upper()}] {len(gs)}경기")
        for g in gs[:3]:
            if sport == 'soccer':
                print(f"  {g['league']} {g['home']}({g['home_abbr']}) vs {g['away']}({g['away_abbr']})")
                print(f"    홈승{g['ml_bets_home']}% 무{g['ml_bets_draw']}% 원정{g['ml_bets_away']}% | OU오버{g['ou_bets_over']}% 언더{g['ou_bets_under']}%")
            elif sport == 'basketball':
                print(f"  {g['league']} {g['home']}({g['home_abbr']}) vs {g['away']}({g['away_abbr']})")
                print(f"    ML홈{g['ml_bets_home']}% 원정{g['ml_bets_away']}% | 핸디홈{g['sp_bets_home']}% 원정{g['sp_bets_away']}% | OU오버{g['ou_bets_over']}% 언더{g['ou_bets_under']}%")
            else:
                print(f"  {g['league']} {g['home']}({g['home_abbr']}) vs {g['away']}({g['away_abbr']})")
                print(f"    ML홈{g['ml_bets_home']}% 원정{g['ml_bets_away']}% | OU오버{g['ou_bets_over']}% 언더{g['ou_bets_under']}%")

    return games


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        page = await browser.new_page(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 900}
        )

        games = await scrape_proto(page)
        await browser.close()

    print(f"\n총 {len(games)}경기 수집 완료")

    if SUPABASE_URL and SUPABASE_KEY:
        sb = _sb()
        deleted = False
        try:
            # wisetoto가 관리하는 KBO/NPB/KBL 제외하고 나머지만 초기화
            sb.table("proto_betting").delete().neq("league", "KBO").neq("league", "NPB").neq("league", "KBL").execute()
            deleted = True
            print("proto_betting 초기화 완료 (KBO/NPB/KBL 제외)")
        except Exception as e:
            print(f"초기화 실패 (insert 스킵): {e}")

        if deleted and games:
            try:
                sb.table("proto_betting").insert(games).execute()
                print("Supabase 저장 완료!")
            except Exception as e:
                print(f"Supabase 저장 실패: {e}")
        elif deleted:
            print("데이터 없음 — 테이블 비움")
        else:
            print("초기화 실패로 중복 방지 위해 저장 스킵")
    else:
        print("[로컬] Supabase 미설정")


if __name__ == "__main__":
    asyncio.run(main())
