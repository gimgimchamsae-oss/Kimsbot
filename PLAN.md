# 국내 구매율 팀명 매핑 확장

## 목표
피나클(영문 팀명)과 proto_betting(한글 팀명)의 매칭 개선.
`proto_scraper.py`의 `KR_ABBREV`/`KR_SOCCER`에 피나클 영문 풀네임 추가,
`App.jsx`의 `findProto`에서 MLB/NBA 약자 없는 리그는 풀네임 직접 비교로 폴백.

## 단계

- [x] 1단계: PLAN.md 작성 + KBO/NPB → `KR_ABBREV` 추가
- [ ] 2단계: 유럽컵(UCL/Europa/Conference) 팀 → `KR_SOCCER` 추가
- [ ] 3단계: `App.jsx` `findProto` 수정 (KBO/NPB 풀네임 폴백 매칭)
