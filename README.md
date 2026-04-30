# hottam-threads-data

Cloudflare Workers 의 Browser Rendering 무료 한도 (10분/일) 를 우회하기 위한 GitHub Actions 기반 수집기.

## 동작
- 6시간마다 cron 발동
- Meta Threads API (BYOT) 로 19 카테고리 trending fetch
- Playwright 로 게시물 페이지 fetch → likes/replies/reposts/quotes 추출
- `data/trending/<category>.json` 으로 commit
- Frontend (hottam) 는 `raw.githubusercontent.com` 에서 JSON 직접 fetch (CDN, 0 latency)

## Public + standard runner = 무료 무제한
GitHub Actions 정책상 public repo + standard runner = 영구 무료. 수집 비용 0원.

## Fallback chain
1. **GitHub JSON** (이 repo, 6h 신선도) — 0 한도
2. **CF Browser Rendering** (hottam-api Worker) — KV 24h 캐시, 10분/일
3. **Graceful 안내** (둘 다 실패 시)

## Secret
- `THREADS_TOKEN` — 운영자(`@howtoai73`) Threads API access token. 60일 만료, 50일째 자동 갱신 워크플로우.
