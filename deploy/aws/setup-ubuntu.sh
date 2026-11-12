#!/usr/bin/env bash
# LumiTwin 서버 한 대 준비 (Ubuntu 24.04 LTS, x86_64·arm64). 여러 번 돌려도 된다(이미 된 단계는 건너뛴다).
#   쓰는 법: 코드를 받은 폴더에서 일반 사용자(ubuntu)로
#     bash deploy/aws/setup-ubuntu.sh lumitwin.example.com
#   도메인을 빼면 Caddy 설정은 건너뛴다(나중에 다시 돌리면 된다).
#   WHISPER=1 bash deploy/aws/setup-ubuntu.sh …  → 음성 받아쓰기 서버(faster-whisper)도 설치하고 켠다
set -euo pipefail

DOMAIN="${1:-}"
CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$CODE_DIR"
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "root가 아니라 일반 사용자(예: ubuntu)로 실행하세요. 필요한 곳에서만 sudo를 씁니다." >&2
  exit 1
fi

step "1. 스왑 4GB (화면 빌드가 램을 많이 쓴다)"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "이미 있음"
fi

step "2. 기본 패키지·PostgreSQL·Python"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg git build-essential openssl \
  python3 python3-venv python3-pip \
  postgresql \
  debian-keyring debian-archive-keyring apt-transport-https
sudo timedatectl set-ntp true || true

step "3. Node.js 22 + pm2"
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
command -v pm2 >/dev/null || sudo npm install -g pm2

step "4. Caddy (공식 apt 저장소)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
caddy version

step "5. DB 사용자·DB (lumitwin)"
NEW_DB_URL=""
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='lumitwin'" | grep -q 1; then
  PW="$(openssl rand -hex 16)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE lumitwin LOGIN PASSWORD '${PW}'"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE lumitwin OWNER lumitwin ENCODING 'UTF8' TEMPLATE template0"
  # Prisma는 시각을 UTC로 읽고 쓴다. 시간대별 집계 SQL도 UTC 기준으로 맞춘다 (개발용 embedded-postgres와 같게)
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER DATABASE lumitwin SET timezone TO 'UTC'"
  NEW_DB_URL="postgresql://lumitwin:${PW}@127.0.0.1:5432/lumitwin"
  echo "DB 사용자 lumitwin을 만들었습니다"
else
  echo "이미 있음 (비밀번호는 server/.env의 DATABASE_URL에 있습니다)"
fi

step "6. server/.env"
if [ ! -f server/.env ]; then
  cp deploy/aws/server.env.example server/.env
  echo "deploy/aws/server.env.example 을 server/.env 로 복사했습니다"
fi
if [ -n "$NEW_DB_URL" ]; then
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=${NEW_DB_URL}#" server/.env
fi
if grep -q '^DATABASE_URL=.*CHANGE_ME' server/.env; then
  echo "server/.env의 DATABASE_URL에 비밀번호가 없습니다. DB 사용자가 이미 있었다면 비밀번호를 다시 정하세요:" >&2
  echo "  sudo -u postgres psql -c \"ALTER ROLE lumitwin PASSWORD '새 비밀번호'\"  → server/.env에 반영" >&2
  exit 1
fi
if [ -n "$DOMAIN" ]; then
  sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=https://${DOMAIN}#" server/.env
fi
# 공개 서버의 제어 키 (보기 전용을 푸는 키). 처음 한 번만 만든다
if grep -q '^CONTROL_KEY=CHANGE_ME' server/.env; then
  sed -i "s#^CONTROL_KEY=CHANGE_ME#CONTROL_KEY=$(openssl rand -hex 8)#" server/.env
  echo "제어 키를 만들어 server/.env의 CONTROL_KEY에 넣었습니다"
fi
if [ "${WHISPER:-}" = "1" ] && ! grep -q '^STT_BASE_URL=' server/.env; then
  printf '\nSTT_BASE_URL=http://127.0.0.1:8792\nSTT_MODEL=%s\n' "${WHISPER_MODEL:-small}" >> server/.env
fi
chmod 600 server/.env

step "7. 패키지 설치 (shared 빌드·Prisma Client 생성까지)"
npm ci

step "8. 시뮬레이터 Python 가상환경"
npm run sim:setup
if [ "${WHISPER:-}" = "1" ]; then
  npm run whisper:setup
fi

step "9. DB 마이그레이션"
npm run db:migrate

step "10. 빌드 (shared → server → client, 처음에는 몇 분)"
NODE_OPTIONS=--max-old-space-size=3072 npm run build

step "11. Caddy 설정"
if [ -n "$DOMAIN" ]; then
  sed "s/lumitwin\.example\.com/${DOMAIN}/g" deploy/aws/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  sudo systemctl reload caddy || sudo systemctl restart caddy
  echo "https://${DOMAIN} — 도메인의 A 레코드가 이 서버 공인 IP를 가리켜야 인증서를 받습니다"
else
  echo "도메인을 주지 않아 건너뜁니다"
fi

step "12. pm2로 띄우고 재부팅 때 자동 시작"
pm2 startOrReload deploy/aws/ecosystem.config.cjs --update-env
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null
pm2 status

step "끝"
echo "확인: curl -s http://127.0.0.1:8790/api/v1/sim/status   (connected가 true면 시뮬레이터까지 붙은 것)"
echo "로그: pm2 logs lumitwin-server --lines 50"
