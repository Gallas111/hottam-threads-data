// 50일 이상 경과 시 토큰 자동 갱신 → GitHub Secret 업데이트
// gh CLI 가 runner 에 기본 설치됨

import { execSync } from "node:child_process";

const TOKEN = process.env.THREADS_TOKEN;
if (!TOKEN) { console.error("THREADS_TOKEN required"); process.exit(1); }

// debug_token: 만료까지 남은 시간 확인
async function getExpiresIn() {
  const r = await fetch(`https://graph.threads.net/v1.0/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  const j = await r.json();
  // expires_at = unix epoch sec; 0 means never expire (rare)
  return j.data?.expires_at ? (j.data.expires_at - Math.floor(Date.now() / 1000)) : null;
}

async function refresh() {
  const r = await fetch(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${TOKEN}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j.access_token;
}

async function main() {
  const expSec = await getExpiresIn();
  console.log(`token expires_in: ${expSec ? `${(expSec / 86400).toFixed(1)} days` : "unknown"}`);
  // 만료까지 10일 미만이면 갱신 (보수적)
  if (expSec === null || expSec > 10 * 86400) {
    console.log("no refresh needed");
    return;
  }
  const newToken = await refresh();
  console.log(`refreshed, new token len ${newToken.length}`);
  // gh secret 업데이트 — GH_TOKEN env 가 자동으로 설정됨 (workflows 내부에서)
  execSync(`gh secret set THREADS_TOKEN --body "${newToken}"`, { stdio: "inherit" });
  console.log("THREADS_TOKEN secret updated");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
