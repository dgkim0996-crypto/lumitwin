#!/usr/bin/env bash
# LumiTwin 서버 한 대 준비 (Ubuntu 24.04 LTS, x86_64·arm64). 여러 번 돌려도 된다(이미 된 단계는 건너뛴다).
#   쓰는 법: 코드를 받은 폴더에서 일반 사용자(ubuntu)로
#     bash deploy/aws/setup-ubuntu.sh lumitwin.example.com   내 도메인(A 레코드가 이 서버 공인 IP)
#     bash deploy/aws/setup-ubuntu.sh auto                   도메인 없이: 공인 IP로 a-b-c-d.sslip.io 주소를 만든다
#   도메인을 빼면 Caddy 설정은 건너뛴다(나중에 다시 돌리면 된다).
#   환경 변수 (server/.env에 적어 두므로 다음에 다시 돌리거나 재부팅해도 같게 뜬다)
#     SIM_LINK=opcua  설비 신호를 가상 PLC(OPC UA) → 엣지 게이트웨이 → MQTT로 (asyncua 설치, 기본 mqtt)
#     SIM_SPEED=5     시뮬레이터 배속
#     WHISPER=1       음성 받아쓰기 서버(faster-whisper)도 설치하고 켠다
# Oracle Cloud(상시 무료 A1)에서 처음부터 하는 순서: deploy/oracle/README.md
set -euo pipefail

DOMAIN="${1:-}"
CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$CODE_DIR"
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
die() { echo "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
  die "root가 아니라 일반 사용자(예: ubuntu)로 실행하세요. 필요한 곳에서만 sudo를 씁니다."
fi
if [ -n "${SIM_LINK:-}" ] && [ "$SIM_LINK" != mqtt ] && [ "$SIM_LINK" != opcua ]; then
  die "SIM_LINK는 mqtt 또는 opcua 입니다 (받은 값: ${SIM_LINK})"
fi
if [ -n "${SIM_SPEED:-}" ] && ! [[ "$SIM_SPEED" =~ ^(1|5|20|60)$ ]]; then
  die "SIM_SPEED는 1·5·20·60 중 하나입니다 (화면의 배속 단추와 같다)"
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

if [ "$DOMAIN" = "auto" ]; then
  # 이 서버가 밖에서 보이는 IPv4. 클라우드 내부 메타데이터는 사설 IP만 주므로 바깥 응답 서비스에 묻는다
  IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://checkip.amazonaws.com || true)"
  IP="$(printf '%s' "$IP" | tr -d '[:space:]')"
  [[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "공인 IP를 알아내지 못했습니다. 도메인을 직접 주세요: bash deploy/aws/setup-ubuntu.sh 내도메인"
  DOMAIN="${IP//./-}.sslip.io"
  echo "주소: ${DOMAIN} (sslip.io가 이름 속 IP를 그대로 돌려준다)"
fi
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  die "도메인 모양이 아닙니다: ${DOMAIN}"
fi

step "3. 방화벽: 80·443 열기"
# Oracle Cloud의 Ubuntu 이미지는 iptables가 22번(SSH) 말고는 REJECT로 막는다. 막는 줄 바로 앞에 허용 줄을 넣는다.
# 클라우드 쪽 방화벽(Oracle 보안 목록·AWS 보안 그룹)은 콘솔에서 따로 열어야 한다
if command -v iptables >/dev/null && sudo iptables -S INPUT | grep -q -- '-j REJECT'; then
  open_port() { # 프로토콜 포트
    if sudo iptables -C INPUT -p "$1" -m conntrack --ctstate NEW -m "$1" --dport "$2" -j ACCEPT 2>/dev/null; then
      echo "$1/$2 이미 열림"
      return
    fi
    local n
    n="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
    sudo iptables -I INPUT "$n" -p "$1" -m conntrack --ctstate NEW -m "$1" --dport "$2" -j ACCEPT
    echo "$1/$2 열었음"
  }
  open_port tcp 80   # 인증서 발급(HTTP-01)과 https로 넘기기
  open_port tcp 443
  open_port udp 443  # HTTP/3 (없어도 된다)
  if command -v netfilter-persistent >/dev/null; then
    sudo netfilter-persistent save >/dev/null
    echo "재부팅해도 남도록 /etc/iptables/rules.v4 에 저장했습니다"
  else
    echo "netfilter-persistent가 없어 재부팅하면 규칙이 사라집니다. 이 스크립트를 다시 돌리면 다시 엽니다" >&2
  fi
else
  echo "막는 규칙이 없음"
fi

step "4. Node.js 22 + pm2"
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
command -v pm2 >/dev/null || sudo npm install -g pm2

step "5. Caddy (공식 apt 저장소)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
caddy version

step "6. DB 사용자·DB (lumitwin)"
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

step "7. server/.env"
if [ ! -f server/.env ]; then
  cp deploy/aws/server.env.example server/.env
  echo "deploy/aws/server.env.example 을 server/.env 로 복사했습니다"
fi
# KEY=VALUE 한 줄을 바꾸거나 없으면 끝에 더한다
set_env() {
  if grep -q "^$1=" server/.env; then
    sed -i "s#^$1=.*#$1=$2#" server/.env
  else
    [ -z "$(tail -c1 server/.env)" ] || echo >> server/.env
    printf '%s=%s\n' "$1" "$2" >> server/.env
  fi
}
if [ -n "$NEW_DB_URL" ]; then
  set_env DATABASE_URL "$NEW_DB_URL"
fi
if grep -q '^DATABASE_URL=.*CHANGE_ME' server/.env; then
  echo "server/.env의 DATABASE_URL에 비밀번호가 없습니다. DB 사용자가 이미 있었다면 비밀번호를 다시 정하세요:" >&2
  echo "  sudo -u postgres psql -c \"ALTER ROLE lumitwin PASSWORD '새 비밀번호'\"  → server/.env에 반영" >&2
  exit 1
fi
if [ -n "$DOMAIN" ]; then
  set_env CORS_ORIGIN "https://${DOMAIN}"
fi
# 공개 서버의 제어 키 (보기 전용을 푸는 키). 처음 한 번만 만든다
if grep -q '^CONTROL_KEY=CHANGE_ME' server/.env; then
  set_env CONTROL_KEY "$(openssl rand -hex 8)"
  echo "제어 키를 만들어 server/.env의 CONTROL_KEY에 넣었습니다"
fi
if [ "${WHISPER:-}" = "1" ]; then
  set_env WHISPER 1  # ecosystem.config.cjs가 읽어 받아쓰기 서버를 띄운다 (다음에 WHISPER=1 없이 돌려도 그대로)
  if ! grep -q '^STT_BASE_URL=' server/.env; then
    set_env STT_BASE_URL "http://127.0.0.1:8792"
    set_env STT_MODEL "${WHISPER_MODEL:-small}"
  fi
fi
# 시뮬레이터 구성: deploy/aws/ecosystem.config.cjs가 여기서 읽는다
if [ -n "${SIM_LINK:-}" ]; then set_env SIM_LINK "$SIM_LINK"; fi
if [ -n "${SIM_SPEED:-}" ]; then set_env SIM_SPEED "$SIM_SPEED"; fi
chmod 600 server/.env
LINK="$(sed -n 's/^SIM_LINK=//p' server/.env | tail -n1)"
LINK="${LINK:-mqtt}"
echo "설비 신호 경로: ${LINK}"

step "8. 패키지 설치 (shared 빌드·Prisma Client 생성까지)"
npm ci

step "9. 시뮬레이터 Python 가상환경"
if [ "$LINK" = opcua ]; then
  npm run sim:setup:opcua
else
  npm run sim:setup
fi
if [ "${WHISPER:-}" = "1" ]; then
  npm run whisper:setup
fi

step "10. DB 마이그레이션"
npm run db:migrate

step "11. 빌드 (shared → server → client, 처음에는 몇 분)"
NODE_OPTIONS=--max-old-space-size=3072 npm run build

step "12. Caddy 설정"
if [ -n "$DOMAIN" ]; then
  sed "s/lumitwin\.example\.com/${DOMAIN}/g" deploy/aws/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  sudo systemctl reload caddy || sudo systemctl restart caddy
  echo "주소의 A 레코드가 이 서버 공인 IP를 가리키고 80·443이 열려 있으면 Caddy가 인증서를 받습니다 (처음 1분쯤)"
else
  echo "도메인을 주지 않아 건너뜁니다"
fi

step "13. pm2로 띄우고 재부팅 때 자동 시작"
# SIM_LINK·SIM_SPEED가 바뀌었으면 시뮬레이터·엣지 게이트웨이를 내렸다가 새 인자로 띄운다 (그때는 새 실행이 시작된다)
node deploy/aws/pm2-sync.cjs
pm2 startOrReload deploy/aws/ecosystem.config.cjs --update-env
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null
pm2 status

step "끝"
if [ -n "$DOMAIN" ]; then
  echo "열기: https://${DOMAIN}"
fi
echo "확인: curl -s http://127.0.0.1:8790/api/v1/sim/status   (connected가 true면 시뮬레이터까지 붙은 것)"
echo "로그: pm2 logs lumitwin-server --lines 50"
echo "제어 키(보기 전용 풀기)는 server/.env의 CONTROL_KEY에 있습니다: grep ^CONTROL_KEY= server/.env"
