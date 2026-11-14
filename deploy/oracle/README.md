# Oracle Cloud 상시 무료 서버에 올리기

LumiTwin 전체(화면·MES·MQTT 브로커·가상 PLC·엣지 게이트웨이·시뮬레이터·DB)를 Oracle Cloud의 **상시 무료(Always Free)** ARM 서버 한 대에 올립니다.
PC를 꺼 두어도 링크가 열리고, 무료 한도 안에서만 쓰면 요금이 나가지 않습니다.

| | Cloudflare Tunnel ([deploy/cloudflare](../cloudflare/README.md)) | Oracle 상시 무료 (이 문서) |
|---|---|---|
| 서버 | 내 PC | Oracle 데이터센터의 VM |
| PC를 끄면 | 링크가 닫힌다 | 그대로 열려 있다 |
| 주소 | 띄울 때마다 바뀜 (`*.trycloudflare.com`) | 고정 (`이름.duckdns.org`) |
| 준비 | 명령 하나 | 가입·VM 만들기 30분쯤 + 설치 |

설치는 [deploy/aws](../aws/README.md)의 스크립트를 그대로 씁니다. Ubuntu 서버면 어느 클라우드든 같고, Oracle에서만 다른 점(ARM, 방화벽 두 겹, 무료 주소)을 스크립트가 처리합니다.

```
                     인터넷 (80·443만 열림)
                             │
   Oracle 보안 목록 ─────────┤  ← 콘솔에서 연다 (3장)
   VM 안 iptables ───────────┤  ← 설치 스크립트가 연다
                       ┌─────▼─────┐  HTTPS 인증서 자동 발급·갱신
                       │   Caddy   │
                       └─┬───────┬─┘
                 /api/v1 │       │ 그 밖
               /socket.io│       │
                ┌────────▼─┐  ┌──▼─────────┐
                │ MES 서버 │  │ 화면 (Next)│
                │  :8790   │  │   :5180    │
                └─┬──────▲─┘  └────────────┘
                  │      │ MQTT :1884
          ┌───────▼──┐ ┌─┴──────────────┐  OPC UA  ┌─────────────────────┐
          │PostgreSQL│ │ 엣지 게이트웨이│◀─:4840──│ 시뮬레이터·가상 PLC │
          │  :5432   │ └────────────────┘          └─────────────────────┘
          └──────────┘   pm2가 모두 띄우고 죽으면 다시 띄운다. 모두 127.0.0.1에서만 받는다
```

## 0. 무료 한도와 고를 크기

공식 문서([Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)) 기준입니다. 바뀔 수 있으니 가입 전에 한 번 확인하세요.

| 항목 | 무료 한도 | 이 프로젝트 |
|---|---|---|
| Ampere A1 (ARM) | 한 달 1,500 OCPU-시간 · 9,000 GB-시간 = 상시 **2 OCPU · 12GB** | **2 OCPU · 4GB** 한 대 |
| 블록 스토리지 | 부트 볼륨 포함 모두 합쳐 200GB | 부트 볼륨 기본 크기(약 47GB) |
| AMD 마이크로 (`VM.Standard.E2.1.Micro`) | 1/8 OCPU · 1GB 두 대 | 쓰지 않음 (램이 작아 화면 빌드가 죽는다) |

**왜 4GB인가: 쉬는 서버 회수 규칙 때문입니다.** 공식 문서에 따르면 7일 동안 아래가 **모두** 맞으면 Oracle이 쉬는 상시 무료 인스턴스로 보고 회수할 수 있습니다.

- CPU 사용률 95번째 백분위수가 20% 미만
- 네트워크 사용률이 20% 미만
- 메모리 사용률이 20% 미만 (A1만 해당)

가상 공장은 쉬지 않고 돌지만 CPU는 거의 놀고 방문자도 드물어, CPU·네트워크는 20%를 넘기 어렵습니다. 그래서 **메모리**로 20%를 넘깁니다. LumiTwin은 서버·화면·DB·시뮬레이터·엣지를 합쳐 늘 1GB 넘게 쓰므로, 메모리를 4GB로 잡으면 20%(0.8GB) 위에 있습니다. 12GB를 다 잡으면 오히려 20% 아래로 떨어질 수 있습니다. 띄운 뒤 8장에서 실제 사용률을 확인합니다.

음성 받아쓰기 서버(`WHISPER=1`, 램 약 1GB 더)까지 켤 거면 메모리를 6GB로 잡습니다.

## 1. 가입

1. [oracle.com/cloud/free](https://www.oracle.com/cloud/free/)에서 가입합니다. 카드는 본인 확인용입니다.
2. **홈 리전을 신중히 고릅니다.** 가입 뒤에는 바꿀 수 없고, 상시 무료 자원은 홈 리전에서만 만들 수 있습니다. 국내 접속이 빠른 곳은 `South Korea Central (Seoul)`과 `South Korea North (Chuncheon)`입니다.
3. 처음 30일은 체험 크레딧이 붙어, 그동안은 크레딧으로 유료 크기도 만들어집니다. 만들 때 크기 옆에 `Always Free-eligible`(상시 무료 가능) 표시가 있는지 꼭 봅니다. 이 문서대로만 만들면 체험이 끝나도 그대로 무료로 남습니다. 계정을 유료(Pay As You Go)로 올리지 않으면 체험 뒤에 요금이 나가지 않습니다.

## 2. VM 만들기

콘솔 왼쪽 위 메뉴 → **Compute → Instances → Create instance**

| 항목 | 고를 것 |
|---|---|
| Name | `lumitwin` |
| Image | **Canonical Ubuntu 24.04** (`Change image`에서 고른다. 크기를 A1로 바꾸면 aarch64판이 고정된다) |
| Shape | `Change shape` → **Ampere** → `VM.Standard.A1.Flex`, OCPU **2**, Memory **4GB** |
| Networking | 새 VCN·**공용 서브넷**, `Automatically assign public IPv4 address` 켬 |
| Add SSH keys | **Generate a key pair for me** → `Save private key`로 `.key` 파일을 받아 둔다 (다시 못 받는다) |
| Boot volume | 기본값 |

`Create`를 누르고 상태가 `Running`이 되면 인스턴스 화면의 **Public IP address**를 적어 둡니다.

**`Out of capacity for shape VM.Standard.A1.Flex`가 나오면** A1 자리가 그 순간 모자란 것입니다. 흔한 일입니다.

- `Placement`에서 다른 가용성 도메인(AD)이 있으면 바꿔 봅니다.
- 몇 시간 뒤나 새벽에 다시 눌러 봅니다.
- OCPU 1 · 메모리 4GB로 먼저 만들고, 나중에 인스턴스 화면의 `Edit` → `Shape`에서 2 OCPU로 늘려도 됩니다.

## 3. 클라우드 방화벽(보안 목록)에 80·443 열기

Oracle은 방화벽이 두 겹입니다. VM 안의 iptables는 설치 스크립트가 열고, 바깥의 **보안 목록**은 콘솔에서 엽니다.

인스턴스 화면 → `Primary VNIC`의 **Subnet** 링크 → `Security` 탭(또는 `Security Lists`) → `Default Security List for …` → **Add Ingress Rules**

| Source CIDR | IP Protocol | Destination Port | 용도 |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `80` | 인증서 발급(HTTP-01), http → https 이동 |
| `0.0.0.0/0` | TCP | `443` | HTTPS |
| `0.0.0.0/0` | UDP | `443` | (선택) HTTP/3 |

22번(SSH)은 처음부터 열려 있습니다. 더 막고 싶으면 그 규칙의 Source를 내 IP(`x.x.x.x/32`)로 바꿉니다. 8790·5180·1884·4840·5432는 열지 않습니다.

## 4. 주소 만들기 (DuckDNS, 무료)

태블릿·휴대폰 브라우저는 HTTPS에서만 마이크(음성 질문)를 허락하므로 인증서를 받을 이름이 필요합니다.

1. [duckdns.org](https://www.duckdns.org)에 GitHub나 Google 계정으로 로그인합니다.
2. `sub domain`에 원하는 이름(예: `lumitwin-내이름`)을 넣고 `add domain`을 누릅니다.
3. 그 줄의 `current ip`에 2장에서 적은 공인 IP를 넣고 `update ip`를 누릅니다.

PC에서 이름이 IP로 풀리는지 확인합니다.

```powershell
Resolve-DnsName 이름.duckdns.org -Type A
```

**계정을 만들기 싫으면** 4장을 건너뛰고 6장에서 도메인 자리에 `auto`를 넣습니다. 스크립트가 공인 IP로 `140-238-1-23.sslip.io` 같은 주소를 만듭니다.
다만 sslip.io는 [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat)에 없어 sslip.io를 쓰는 모든 사람이 [Let's Encrypt 발급 한도](https://letsencrypt.org/docs/rate-limits/)를 함께 씁니다. 붐비면 인증서 발급이 한동안 막힐 수 있습니다. duckdns.org는 그 목록에 있어 이름마다 한도가 따로입니다. 그래서 DuckDNS를 기본으로 권합니다.

## 5. SSH로 들어가기 (Windows)

Windows의 OpenSSH는 다른 사용자도 읽을 수 있는 키 파일을 거부합니다(`UNPROTECTED PRIVATE KEY FILE`). 받은 키를 `.ssh` 폴더로 옮기고 권한을 나만 읽게 바꿉니다. PowerShell에서 한 줄씩 실행합니다.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh"
```

```powershell
Move-Item "$env:USERPROFILE\Downloads\ssh-key-*.key" "$env:USERPROFILE\.ssh\lumitwin.key"
```

```powershell
icacls "$env:USERPROFILE\.ssh\lumitwin.key" /inheritance:r /grant:r "$($env:USERNAME):R"
```

접속합니다. 사용자 이름은 `ubuntu`입니다.

```powershell
ssh -i "$env:USERPROFILE\.ssh\lumitwin.key" ubuntu@<공인 IP>
```

## 6. 설치·기동 (VM 안에서)

설치는 처음에 시간이 꽤 걸립니다(패키지, Python 가상환경, 화면 빌드). SSH가 끊겨도 계속 돌도록 `tmux` 안에서 돌립니다.

```bash
sudo apt-get update && sudo apt-get install -y git tmux
```

```bash
git clone https://github.com/dgkim0996-crypto/lumitwin.git ~/lumitwin
```

```bash
tmux new -s setup
```

```bash
cd ~/lumitwin && SIM_LINK=opcua bash deploy/aws/setup-ubuntu.sh 이름.duckdns.org
```

- 끊겼으면 다시 SSH로 들어와 `tmux attach -t setup`으로 이어서 봅니다.
- `SIM_LINK=opcua`는 설비 신호를 현장과 같은 길(가상 PLC → OPC UA → 엣지 게이트웨이 → MQTT)로 보냅니다. 빼면 시뮬레이터가 MQTT로 바로 보냅니다.
- 이 설정은 `server/.env`에 적혀 재부팅해도, 스크립트를 다시 돌려도 그대로입니다. 바꿀 때는 값만 바꿔 스크립트를 다시 돌립니다(그때 시뮬레이터가 새 실행으로 다시 시작합니다).

스크립트가 하는 일은 [deploy/aws/README.md 4장](../aws/README.md#4-설치기동)과 같고, 하나가 더 있습니다. **VM 안의 iptables에 80·443 허용 줄을 넣고**(Oracle Ubuntu 이미지는 22번 말고는 REJECT로 막는다) 재부팅해도 남게 저장합니다.

**선택 옵션** (스크립트 앞에 붙인다)

| 옵션 | 하는 일 |
|---|---|
| `SIM_LINK=opcua` | 설비 신호를 OPC UA 경로로 (asyncua를 설치하고 `lumitwin-edge` 프로세스를 더 띄운다) |
| `SIM_SPEED=20` | 시뮬레이터 배속 (`1`·`5`·`20`·`60`, 기본 5) |
| `WHISPER=1` | 음성 받아쓰기 서버도 켠다 (메모리 6GB 권장, 처음에 모델 약 460MB를 받는다) |

## 7. 로그인·계정 설정

실행 MES는 설비 조작·시뮬레이터 제어·작업지시·불량 처리 판정 같은 쓰기 요청에 로그인과 역할 권한을 요구합니다. 시연 계정 5개(`op1` 현장 작업자, `lead1` 라인 조장, `qa1` 품질 담당, `mt1` 보전 담당, `admin` 시스템 관리자)는 서버가 뜰 때 DB에 만들어집니다. 역할별로 할 수 있는 일은 [docs/MES.md](../../docs/MES.md)에 있습니다.

설치 스크립트는 `deploy/aws/server.env.example`을 복사하고(`AUTH=on`, `AUTH_COOKIE_SECURE=auto`), `AUTH_SECRET`에 무작위 키를 만들어 넣습니다. 처음에는 아래 값으로 뜹니다.

| 환경 변수 (`server/.env`) | 처음 값 | 공개 서버에서 |
|---|---|---|
| `AUTH` | `on` | 그대로 둔다. `off`면 로그인 없이 모든 요청을 시스템 사용자(관리자 권한)로 받는다 |
| `DEMO_PASSWORD` | 줄이 주석 = 코드에 공개된 기본 비밀번호(`demo1234`). 로그인 화면의 계정 버튼만 눌러도 들어간다 | **직접 정한다.** 정하면 계정 버튼은 아이디만 채우고 비밀번호를 넣어야 한다 |
| `AUTH_SECRET` | 설치 스크립트가 만든 64자 무작위 값 (`openssl rand -hex 32`) | 그대로 둔다. 줄을 지우면 처음 뜰 때 키를 만들어 `server/.auth-secret`에 저장한다 |
| `AUTH_COOKIE_SECURE` | `auto` = HTTPS로 들어온 요청(`X-Forwarded-Proto: https`)에만 쿠키 `Secure` | Caddy가 HTTPS만 받으므로 `on`으로 둔다 |

**설정하기** (VM 안에서)

```bash
nano ~/lumitwin/server/.env
```

맨 아래에 두 줄을 더합니다. 비밀번호는 직접 정하고, 이 문서나 저장소에 적지 않습니다.

```
DEMO_PASSWORD=직접_정한_비밀번호
AUTH_COOKIE_SECURE=on
```

서버만 다시 띄웁니다. 서버는 뜰 때 `server/.env`를 읽고, 시연 계정 비밀번호를 새 값으로 바꿉니다. 시뮬레이터는 그대로 돕니다.

```bash
pm2 restart lumitwin-server
```

```bash
curl -s http://127.0.0.1:8790/api/v1/auth/me
```

`"enabled":true`와 `"demo":false`(계정 버튼만으로는 못 들어감)가 보이면 됩니다.

- `server/.env`와 `server/.auth-secret`은 git에 올라가지 않습니다. `bash deploy/aws/update.sh`(`git pull`)로 새 버전을 받아도 그대로 남아 로그인이 유지됩니다.
- 로그인은 8시간 유지됩니다. 로그인 시도는 IP별 1분 10번까지입니다.

**공개 주소에서 시연자가 조작하는 순서**

이 서버는 `READ_ONLY=all`이라 모든 방문자가 보기 전용입니다. 보기 전용은 로그인보다 먼저 막습니다. 그래서 방문자는 로그인 요청도 보낼 수 없고, 기본 비밀번호를 알아도 들어올 수 없습니다.

1. 화면 위쪽의 `보기 전용`을 누르고 제어 키를 넣는다. `조작 가능`으로 바뀐다. 키는 VM에서 본인만 본다: `grep ^CONTROL_KEY= ~/lumitwin/server/.env`
2. 위쪽 오른쪽의 `로그인`을 누른다. 로그인 화면의 계정 버튼으로 아이디를 채우고, 정한 비밀번호를 넣어 `로그인`.
3. 역할을 바꿀 때는 사용자 메뉴 → `다른 계정으로 로그인`. 끝나면 사용자 메뉴 → `로그아웃`.
4. 누가 무엇을 했는지는 `admin`으로 로그인해 사용자 메뉴 → `감사 기록`(`/audit`)에서 본다.

> Caddy의 `basic_auth`([deploy/aws/README.md 6장](../aws/README.md#6-운영))는 사이트 전체를 아이디·비밀번호로 닫는 것이고, 여기의 로그인은 앱 안에서 역할을 나누는 것입니다. 둘은 따로 동작합니다.

## 8. 띄운 뒤 확인

VM 안에서:

```bash
pm2 status
```

`lumitwin-server`·`lumitwin-client`·`lumitwin-sim`·`lumitwin-edge`가 모두 `online`이어야 합니다.

```bash
curl -s http://127.0.0.1:8790/api/v1/sim/status
```

`connected`가 `true`면 시뮬레이터까지 붙은 것입니다.

```bash
sudo ss -tlnp
```

밖(`0.0.0.0`·`*`)으로 열린 포트가 22·80·443뿐이어야 합니다.

```bash
free -m
```

`used`가 `total`의 20%를 넘는지 봅니다(0장 회수 규칙). 콘솔의 인스턴스 화면 → `Metrics`에서도 CPU·메모리 사용률을 볼 수 있습니다.

PC 브라우저·휴대폰에서:

- [ ] `https://이름.duckdns.org`에서 3D 공장이 뜨고, 위쪽 오른쪽 연결 점이 초록이다.
- [ ] 연결 점을 누르면 데이터 경로가 OPC UA로 나오고, 엣지 게이트웨이가 설비·태그를 찾았다.
- [ ] 생산 현황·6대 로스·설비 보전·SPC 화면에 숫자가 찬다 (몇 분 돌아야 쌓인다).
- [ ] 휴대폰으로 `https://이름.duckdns.org/operator`에 들어가 설비를 고를 수 있다.
- [ ] 제어 키 없이 `/login`에 가면 "공개 링크는 보기 전용이라 로그인할 수 없습니다" 안내가 보이고 계정 버튼이 막혀 있다.
- [ ] 화면의 `보기 전용`을 눌러 제어 키를 넣은 뒤 `lead1`(라인 조장)로 로그인하면 배속·시나리오를 바꿀 수 있다. 키는 VM에서 본인만 봅니다: `grep ^CONTROL_KEY= ~/lumitwin/server/.env`
- [ ] 정한 `DEMO_PASSWORD`로만 로그인되고, 계정 버튼만 눌러서는 들어가지 않는다(7장).
- [ ] `admin`으로 로그인해 사용자 메뉴 → `감사 기록`에 방금 한 로그인·배속 변경이 남아 있다.
- [ ] 밖에서 내부 포트가 막혀 있다. PC PowerShell에서 `Test-NetConnection <공인 IP> -Port 8790`이 `TcpTestSucceeded : False`

## 9. 운영

| 하는 일 | 명령 (VM 안, `~/lumitwin`에서) |
|---|---|
| 새 버전 반영 | `bash deploy/aws/update.sh` (서버·화면만 다시 띄운다. 시뮬레이터는 그대로) |
| 시뮬레이터 다시 시작 | `pm2 restart lumitwin-sim lumitwin-edge` (새 실행이 된다) |
| 로그 | `pm2 logs lumitwin-server --lines 100` · `pm2 logs lumitwin-edge --lines 50` |
| 경로·배속 바꾸기 | `SIM_LINK=mqtt SIM_SPEED=20 bash deploy/aws/setup-ubuntu.sh 이름.duckdns.org` |
| 로그 회전 | `pm2 install pm2-logrotate` |
| 시연 계정 비밀번호 바꾸기 | `server/.env`의 `DEMO_PASSWORD`를 고치고 `pm2 restart lumitwin-server` |
| 모든 로그인 끊기 | `AUTH_SECRET`을 쓰면 값을 바꾸고, 안 쓰면 `rm server/.auth-secret`. 그다음 `pm2 restart lumitwin-server` (서명 키가 바뀌어 발급한 쿠키가 모두 무효가 된다) |
| 제어 키 바꾸기 | `server/.env`의 `CONTROL_KEY`를 고치고 `pm2 restart lumitwin-server` |

- AI 비서를 Claude로 돌리기, 보기 전용, Caddy 아이디·비밀번호 걸기, DB 백업은 [deploy/aws/README.md 6장](../aws/README.md#6-운영)과 같습니다.
- 로그아웃한 쿠키 목록과 로그인 시도 횟수는 서버 메모리에만 있어, 서버를 다시 띄우면 잊습니다. 로그아웃한 쿠키를 누가 따로 가지고 있었다면 재시작 뒤 만료(최대 8시간)까지 다시 쓸 수 있습니다. 걱정되면 위의 "모든 로그인 끊기"를 합니다.
- 감사 기록(`action_log` 표)은 실행을 바꿔도 지우지 않고 쌓입니다. DB 백업에 함께 들어갑니다.
- 공인 IP가 바뀌면(인스턴스를 지우고 다시 만들었을 때 등) DuckDNS의 `current ip`만 새 IP로 고칩니다.
- **회수 대비**: 회수가 어떤 방식(중지·삭제)으로 이루어지는지는 공식 문서에 자세히 나와 있지 않습니다. 인스턴스가 멈춰 있으면 콘솔에서 `Start`를 누릅니다. pm2가 재부팅 때 모두 다시 띄웁니다. 인스턴스가 없어졌으면 2장부터 다시 하면 되고, 데이터는 가상 공장 기록이라 새로 쌓입니다.

### 상시 주소로 시연하기 (직접 할 일)

주소를 만들고 영상을 찍는 일은 계정·판단이 필요해 직접 합니다. 순서만 적습니다.

1. 2~8장을 끝내고 `https://이름.duckdns.org`가 열리는지 확인한다.
2. 7장대로 `DEMO_PASSWORD`를 정하고, 제어 키와 함께 비밀번호 관리자 같은 안전한 곳에 둔다. 면접관에게는 주소만 준다(보기 전용으로 둘러볼 수 있다).
3. README 맨 위 소개나 "공개 링크·배포" 장에 이 주소를 적는다.
4. 시연 전날 `pm2 restart lumitwin-sim lumitwin-edge`로 새 실행을 시작해 숫자를 쌓아 둔다. 배속은 `SIM_SPEED`(기본 5)를 따른다.
5. 시연 영상은 [docs/DEMO.md](../../docs/DEMO.md)의 "시연 영상 녹화" 순서대로 찍는다. 이 주소로 찍을 때는 먼저 `보기 전용` → 제어 키 → 로그인을 한다.
6. 일주일에 한 번쯤 주소가 열리는지, `free -m` 메모리 사용률이 20%를 넘는지 본다(0장 회수 규칙).

## 10. 문제가 생기면

| 증상 | 볼 곳 |
|---|---|
| `Out of capacity` | 2장: 다른 AD, 시간을 두고 다시, 1 OCPU로 먼저 만들기 |
| SSH가 `UNPROTECTED PRIVATE KEY FILE` | 5장 `icacls`로 키 권한을 나만 읽게 |
| SSH가 시간 초과 | 공인 IP가 맞는지, 보안 목록에 22번이 있는지, 인스턴스가 `Running`인지 |
| HTTPS 인증서를 못 받음 | 보안 목록에 80·443이 있는지(3장), `sudo iptables -L INPUT -n --line-numbers`에서 80·443 ACCEPT가 REJECT보다 위에 있는지, DuckDNS의 IP가 맞는지, `sudo journalctl -u caddy -n 50`. sslip.io에서 한도에 걸렸으면 DuckDNS로 바꿔 스크립트를 다시 돌린다 |
| 빌드가 `Killed`로 끝남 | 램 부족. `swapon --show`로 스왑을 보고, 인스턴스 메모리를 6GB로 늘린다 |
| 연결 점이 빨강·데이터 경로가 비었음 | `pm2 logs lumitwin-sim`, `pm2 logs lumitwin-edge`. 엣지는 가상 PLC가 늦게 떠도 1→10초 간격으로 다시 붙는다 |
| 502 Bad Gateway | `pm2 status`에서 `lumitwin-server`·`lumitwin-client`가 `online`인지 |
| 로그인 화면이 "공개 링크는 보기 전용이라 로그인할 수 없습니다" | 정상이다. `보기 전용`을 눌러 제어 키를 먼저 넣는다 |
| 계정 버튼을 눌러도 아이디만 채워짐 | `DEMO_PASSWORD`를 정한 서버다. 비밀번호를 넣고 `로그인` |
| 로그인했는데 버튼이 흐림 ("… 권한이 없습니다") | 역할이 다르다. 사용자 메뉴 → `다른 계정으로 로그인`. 역할별 권한은 [docs/MES.md](../../docs/MES.md) |
| 재시작할 때마다 로그인이 풀림 | `server/.auth-secret`을 쓰지 못하는 것. `pm2 logs lumitwin-server`에서 "서명 키를 저장하지 못했습니다"를 찾고, `server/` 폴더 쓰기 권한을 확인하거나 `AUTH_SECRET`을 `server/.env`에 정한다 |
| HTTP(인증서 받기 전)로 들어오면 로그인이 안 됨 | `AUTH_COOKIE_SECURE=on`이면 쿠키가 HTTPS에서만 실린다. 인증서를 받은 뒤 `https://`로 들어온다 |

**시험 범위**: arm64(aarch64)에서 쓰는 네이티브 패키지(Next의 SWC, Tailwind oxide, lightningcss, sharp 등)의 linux-arm64 판이 `package-lock.json`에 있는 것과 스크립트 문법은 확인했습니다. Oracle VM에서 처음부터 끝까지 돌려 본 결과는 아직 없습니다. 처음 설치 때 나온 문제는 이 문서에 더합니다.
