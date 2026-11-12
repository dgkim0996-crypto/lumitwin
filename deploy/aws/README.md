# AWS 서버 한 대에 올리기

LumiTwin 전체(화면·MES·MQTT 브로커·시뮬레이터·DB)를 Ubuntu 서버 한 대에 올리는 방법입니다.
면접관이 링크 하나로 3D 공장, MES 화면, 작업자 태블릿, AI 비서를 볼 수 있게 하는 것이 목표입니다.

```
            인터넷 (80·443만 열림)
                    │
              ┌─────▼─────┐   HTTPS 인증서 자동 발급·갱신 (Let's Encrypt)
              │   Caddy   │
              └─┬───────┬─┘
   /api/v1/*    │       │   그 밖의 주소
   /socket.io/* │       │
        ┌───────▼──┐  ┌─▼──────────┐
        │ MES 서버 │  │ 화면 (Next)│        pm2가 세 프로세스를 띄우고
        │  :8790   │  │   :5180    │        죽으면 다시 띄운다
        └─┬──────▲─┘  └────────────┘
          │      │ MQTT :1884
   ┌──────▼───┐  │  ┌────────────────┐
   │PostgreSQL│  └──┤ 시뮬레이터     │
   │  :5432   │     │ (Python SimPy) │
   └──────────┘     └────────────────┘
          모두 127.0.0.1에서만 받는다 (밖에서 닿지 않음)
```

| 파일 | 하는 일 |
|---|---|
| `setup-ubuntu.sh` | 새 서버 준비 한 번에: 스왑, 패키지, Node 22·pm2, Caddy, DB, `server/.env`, 빌드, 기동, 재부팅 자동 시작 |
| `update.sh` | 새 버전 반영: 받기 → 설치 → 마이그레이션 → 빌드 → 서버·화면 재시작 (시뮬레이터는 그대로) |
| `ecosystem.config.cjs` | pm2 프로세스 정의 (`lumitwin-server`, `lumitwin-client`, `lumitwin-sim`, 선택 `lumitwin-whisper`·`lumitwin-db`) |
| `Caddyfile` | HTTPS 역방향 프록시 템플릿. AI 비서 스트리밍·음성 업로드·웹소켓 설정 포함 |
| `server.env.example` | 운영용 `server/.env` 예시 |

## 1. 서버 고르기

| | EC2 | Lightsail |
|---|---|---|
| 추천 크기 | `t3.medium` (2 vCPU · 4GB) | 4GB 플랜 |
| 운영체제 | Ubuntu Server 24.04 LTS (x86_64) | Ubuntu 24.04 LTS |
| 디스크 | gp3 20GB (음성 받아쓰기까지 켜면 30GB) | 플랜 기본 |
| 장점 | 크기·네트워크를 자유롭게 바꿈 | 월 고정 요금, 화면이 단순함 |

- 램이 4GB는 되어야 합니다. 화면 빌드가 램을 많이 써서 1GB(`t3.micro`)로는 빌드가 죽습니다. 스크립트가 4GB 스왑을 만들어 2GB 서버에서도 빌드는 되지만 느립니다.
- 음성 받아쓰기 서버(faster-whisper `small`)를 같이 켜면 램을 1GB쯤 더 씁니다. 켜지 않아도 Chrome·Edge의 브라우저 음성 인식으로 음성 질문이 됩니다.
- 서울 리전(`ap-northeast-2`)을 고르면 국내에서 빠릅니다.
- arm64(`t4g`)는 시험하지 않았습니다. x86_64를 권합니다.
- 요금은 AWS 요금표에서 확인하세요. 면접 기간에만 켜 두고, 끝나면 인스턴스를 중지하거나 지우면 됩니다. 중지해도 디스크와 공인 IPv4는 요금이 나갑니다. AWS Budgets로 예산 알림을 걸어 두면 안전합니다.

## 2. AWS에서 할 일

**EC2 기준** (Lightsail도 순서는 같습니다)

1. **인스턴스 시작**: Ubuntu Server 24.04 LTS, `t3.medium`, 디스크 20GB gp3, 새 키 페어(`.pem` 내려받기).
2. **보안 그룹** 인바운드 규칙:

   | 포트 | 소스 | 용도 |
   |---|---|---|
   | 22/tcp | 내 IP | SSH |
   | 80/tcp | 0.0.0.0/0 | 인증서 발급, HTTP→HTTPS 이동 |
   | 443/tcp | 0.0.0.0/0 | HTTPS |
   | 443/udp | 0.0.0.0/0 | (선택) HTTP/3 |

   8790·5180·1884·5432는 열지 않습니다.
3. **탄력적 IP**를 할당해 인스턴스에 연결합니다. 그래야 서버를 껐다 켜도 주소가 그대로입니다. Lightsail은 고정 IP를 만들어 붙입니다.
4. **도메인**의 A 레코드를 그 IP로 겨눕니다.
   - 가진 도메인이 있으면 하위 도메인 하나(예: `lumitwin.내도메인`)를 씁니다.
   - 없으면 [DuckDNS](https://www.duckdns.org) 같은 무료 하위 도메인(`xxx.duckdns.org`)도 됩니다.
   - **HTTPS가 꼭 필요합니다.** 태블릿·휴대폰 브라우저는 HTTPS에서만 마이크를 허락합니다. Caddy가 인증서를 저절로 받지만, 도메인이 이 서버를 가리키고 80 포트가 열려 있어야 합니다.

## 3. 코드 올리기

둘 중 하나를 고릅니다.

**가. GitHub 비공개 저장소로** (나중에 `update.sh`로 바로 반영하기 편함)

```bash
git clone https://github.com/<계정>/<저장소>.git ~/lumitwin
```

비공개 저장소면 서버에서 읽기 전용 배포 키나 토큰이 필요합니다.

**나. 파일을 직접 올리기** (Windows PowerShell에서)

빌드 결과물, 패키지, 로컬 DB, 가상환경, 로컬 `.env`는 빼고 묶습니다.

```powershell
tar --exclude=node_modules --exclude=.next --exclude=dist --exclude=.local-db --exclude=.venv --exclude=.env -czf $env:TEMP\lumitwin.tgz -C C:\Dev\SL .
```

```powershell
scp -i lumitwin.pem $env:TEMP\lumitwin.tgz ubuntu@<서버 IP>:~
```

서버에서 압축을 풉니다.

```bash
mkdir -p ~/lumitwin && tar -xzf ~/lumitwin.tgz -C ~/lumitwin
```

## 4. 설치·기동

SSH로 들어가 일반 사용자(`ubuntu`)로 실행합니다. root로 돌리면 스크립트가 멈춥니다.

```bash
ssh -i lumitwin.pem ubuntu@<서버 IP>
```

```bash
cd ~/lumitwin && bash deploy/aws/setup-ubuntu.sh lumitwin.내도메인
```

처음에는 10~15분쯤 걸립니다(패키지 설치, Python 가상환경, 화면 빌드). 여러 번 돌려도 되며, 이미 된 단계는 건너뜁니다.

스크립트가 하는 일:

1. 4GB 스왑을 만듭니다.
2. apt로 git, 빌드 도구, Python, PostgreSQL을 설치합니다.
3. Node.js 22와 pm2를 설치합니다.
4. Caddy를 설치합니다.
5. DB 사용자·DB `lumitwin`을 무작위 비밀번호로 만들고, DB 시간대를 UTC로 둡니다.
6. `server/.env`를 만들고(권한 600) DB 주소와 도메인을 채웁니다.
7. `npm ci`로 패키지를 설치합니다.
8. 시뮬레이터 가상환경을 만듭니다.
9. DB 마이그레이션을 합니다.
10. 빌드합니다.
11. Caddy 설정을 넣습니다.
12. pm2로 띄우고 재부팅 때 자동으로 시작하게 합니다.

**선택 옵션** (스크립트 앞에 붙입니다)

| 옵션 | 하는 일 |
|---|---|
| `WHISPER=1` | 음성 받아쓰기 서버(faster-whisper)를 설치해 켜고 `server/.env`에 `STT_BASE_URL`을 넣는다. 처음 실행 때 `small` 모델 약 460MB를 내려받는다 |
| `WHISPER_MODEL=base` | 받아쓰기 모델을 바꾼다 (`tiny`·`base`·`small`·`medium`). 작을수록 가볍고 덜 정확하다 |
| `SIM_SPEED=20` | 시뮬레이터 배속 (기본 5) |

```bash
WHISPER=1 bash deploy/aws/setup-ubuntu.sh lumitwin.내도메인
```

**도메인 없이 IP로만 먼저 볼 때**: 도메인을 빼고 돌리면 Caddy 설정을 건너뜁니다. HTTP로 IP 접속만 할 때는 Caddyfile의 사이트 주소를 `:80`으로 바꿔 넣습니다. 이 경우 마이크(음성 질문)는 브라우저가 막습니다.

```bash
sed 's/^lumitwin\.example\.com {/:80 {/' deploy/aws/Caddyfile | sudo tee /etc/caddy/Caddyfile >/dev/null && sudo systemctl reload caddy
```

## 5. 띄운 뒤 확인

```bash
pm2 status
```

```bash
curl -s http://127.0.0.1:8790/api/v1/sim/status
```

`connected`가 `true`면 시뮬레이터까지 붙은 것입니다.

```bash
sudo ss -tlnp
```

밖(`0.0.0.0`·`*`)으로 열린 포트가 22·80·443뿐인지 봅니다. 나머지는 `127.0.0.1`이어야 합니다.

브라우저에서는 이렇게 확인합니다.

- [ ] `https://<도메인>`에서 3D 공장이 뜨고, 상단 오른쪽 MES·엣지 점이 초록색이다.
- [ ] 생산 현황·SPC·불량 분석·추적 화면에 숫자가 찬다 (몇 분 돌아야 쌓임).
- [ ] 태블릿이나 휴대폰으로 `https://<도메인>/operator`에 들어가 설비를 고를 수 있다.
- [ ] 작업자 화면에서 계획 정지 → 재가동이 되고, 3D 화면 설비 패널에 사유가 보인다.
- [ ] "말로 묻기"를 누르면 마이크 권한을 묻는다 (HTTPS라서 가능).
- [ ] AI 비서가 답한다. 키가 없으면 "모의 모드"로 답한다.

## 6. 운영

**자주 쓰는 명령**

| 하는 일 | 명령 |
|---|---|
| 상태 보기 | `pm2 status` |
| 서버 로그 | `pm2 logs lumitwin-server --lines 100` |
| 시뮬레이터 로그 | `pm2 logs lumitwin-sim --lines 50` |
| Caddy 로그 | `sudo journalctl -u caddy -n 50` · `sudo tail -f /var/log/caddy/lumitwin.log` |
| 새 버전 반영 | `bash deploy/aws/update.sh` |
| 시뮬레이터 다시 시작 | `pm2 restart lumitwin-sim` (가상 시계가 처음부터 시작해 새 실행이 된다) |

pm2 로그가 쌓이는 것이 걱정되면 로그 회전을 켭니다.

```bash
pm2 install pm2-logrotate
```

**새 버전 반영**

- git으로 받았으면 그대로 `bash deploy/aws/update.sh`를 돌립니다.
- 파일로 올렸으면 3장 "나"처럼 다시 올려 같은 폴더에 풀고 `update.sh`를 돌립니다. git이 아니면 받기 단계는 건너뜁니다.
- `update.sh`는 서버와 화면만 다시 띄웁니다. 시뮬레이터 코드(`sim/`)를 바꿨으면 끝난 뒤 `pm2 restart lumitwin-sim`을 합니다.

**AI 비서를 Claude로 돌리기**

`server/.env`에 키를 넣고 서버만 다시 띄웁니다.

```bash
nano ~/lumitwin/server/.env
```

`ANTHROPIC_API_KEY=` 줄의 `#`을 지우고 키를 넣습니다. 그다음 서버를 다시 띄웁니다.

```bash
pm2 restart lumitwin-server
```

- 공개 링크에서 비용이 새지 않도록 Claude 모드에서는 질문 수를 막습니다. 접속 IP마다 시간당 `ASSISTANT_MAX_PER_HOUR`(기본 20)번, 서버 전체로 하루 `ASSISTANT_MAX_PER_DAY`(기본 300)번이며, 하루는 한국 시각 자정에 바뀝니다.
- 모의 모드는 비용이 없어 세지 않습니다.
- Anthropic 콘솔에서 월 사용 한도도 함께 걸어 두면 안전합니다.

**보기 전용** (기본으로 켜짐)

`server/.env`의 `READ_ONLY=all`이라 방문자는 화면·AI 비서만 쓰고 배속·시나리오·초기화·설비 조작은 못 합니다. 시연자는 화면의 `보기 전용`을 눌러 `CONTROL_KEY`(설치 스크립트가 만들어 넣음)를 넣으면 조작할 수 있습니다. 설명은 [deploy/cloudflare/README.md](../cloudflare/README.md#공개-링크는-보기-전용)와 같습니다.

**아이디·비밀번호 걸기** (공개 링크 대신)

비밀번호 해시를 만듭니다.

```bash
caddy hash-password
```

`/etc/caddy/Caddyfile`의 `basic_auth` 블록 주석을 풀고 해시를 넣은 뒤 다시 읽힙니다.

```bash
sudo systemctl reload caddy
```

`setup-ubuntu.sh`를 다시 돌리면 `/etc/caddy/Caddyfile`을 템플릿으로 덮어씁니다. 그때는 다시 넣거나 `deploy/aws/Caddyfile`에서 미리 주석을 풀어 둡니다.

**DB 백업** (데이터가 가상 공장 기록이라 필수는 아닙니다)

```bash
sudo -u postgres pg_dump -Fc lumitwin > ~/lumitwin-$(date +%F).dump
```

**PostgreSQL을 따로 깔지 않을 때**

개발 때 쓰는 embedded-postgres로 띄울 수도 있습니다(`EMBEDDED_DB=1`). `server/.env`의 `DATABASE_URL`을 `server.env.example`에 적힌 54332 주소로 바꾸고 pm2를 다시 띄웁니다.

```bash
EMBEDDED_DB=1 pm2 startOrReload deploy/aws/ecosystem.config.cjs --update-env && pm2 save
```

## 7. 문제가 생기면

| 증상 | 볼 곳 |
|---|---|
| HTTPS 인증서를 못 받음 | 도메인 A 레코드가 이 서버 IP인지(`dig +short <도메인>`), 보안 그룹에 80·443이 열렸는지, `sudo journalctl -u caddy -n 50` |
| 502 Bad Gateway | `pm2 status`에서 `lumitwin-server`·`lumitwin-client`가 online인지, `pm2 logs` |
| 상단 엣지 점이 빨강 | `pm2 logs lumitwin-sim` — 가상환경이 없으면 `npm run sim:setup` 후 `pm2 restart lumitwin-sim` |
| 빌드가 `Killed`로 끝남 | 램 부족. `swapon --show`로 스왑을 확인하고 더 큰 인스턴스를 쓴다 |
| AI 비서 답이 한꺼번에 나옴 | Caddyfile의 `/api/v1/*`에 `flush_interval -1`이 있는지, 압축(`encode`)이 API에 걸리지 않았는지 |
| 음성 질문이 안 됨 | HTTPS로 들어왔는지(마이크), 서버 받아쓰기를 쓰면 `pm2 logs lumitwin-whisper` |
| 질문이 "한도를 넘었다"고 막힘 | Claude 모드의 질문 한도. `server/.env`의 `ASSISTANT_MAX_PER_*`를 바꾸고 `pm2 restart lumitwin-server` |
