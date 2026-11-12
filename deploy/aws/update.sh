#!/usr/bin/env bash
# 새 버전 올리기: 받기(git이면) → 설치 → 마이그레이션 → 빌드 → 서버·화면 무중단 재시작
#   bash deploy/aws/update.sh
# 시뮬레이터는 다시 띄우지 않는다(다시 띄우면 가상 시계가 처음부터 시작해 새 실행이 된다).
# sim/ 코드가 바뀌었으면 끝난 뒤 직접: pm2 restart lumitwin-sim
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

if [ -d .git ]; then
  git pull --ff-only
else
  echo "git 저장소가 아니라 받기는 건너뜁니다 (파일을 직접 올린 경우)"
fi
npm ci
npm run sim:setup
npm run db:migrate
NODE_OPTIONS=--max-old-space-size=3072 npm run build
pm2 reload lumitwin-server lumitwin-client --update-env
pm2 status
