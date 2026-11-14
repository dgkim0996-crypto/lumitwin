# LumiTwin — 가상 램프·전장 스마트공장

[![CI](https://github.com/dgkim0996-crypto/lumitwin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dgkim0996-crypto/lumitwin/actions/workflows/ci.yml)

자동차 램프와 전장(BMS·사이드미러)을 만드는 가상 공장의 3D 디지털 트윈과 MES입니다.
Python 가상 PLC가 설비 데이터를 MQTT로(또는 OPC UA → 엣지 게이트웨이를 거쳐) 보내면, MES 서버가 받아서 OEE·SPC·알람을 실시간으로 계산하고 시리얼 단위 공정 이력을 PostgreSQL에 쌓습니다. 화면에서는 3D 공장 위에서 그 결과를 봅니다.

> 공개 자료([docs/research](docs/research))를 바탕으로 만든 **가상 공장**입니다. 특정 회사의 실제 라인·수치와 무관하며 대외비 데이터를 쓰지 않습니다. 모든 공정 파라미터에는 근거 등급(확인 / 약함 / 가정)을 달았습니다.

![3D 공장 화면: 세 라인 38대 설비의 상태(빨간 경광등은 고장), 왼쪽은 라인별 실적·OEE·FPY 카드와 알람](docs/images/factory.png)

## 무엇을 보여 주나

| 항목 | 내용 |
|---|---|
| 공장 | 3개 라인, 38대 설비. 헤드램프(사출 → 하드코팅·증착 → 조립 → 기밀·배광·EOL), 전장(SMT → AOI·ICT → 코팅 → FCT → EOL), 사이드미러(사출·도장 → 액추에이터 조립 → 기능 검사). AMR 3대가 라인 간 이송 |
| 데이터 흐름 | SimPy 이산사건 시뮬레이터 → MQTT(`lt/v1/{line}/{station}/…`) → NestJS 내장 브로커(aedes) → 실시간 집계 → Socket.io → 3D 화면 |
| OPC UA 경로 | 현장처럼 **가상 PLC(OPC UA 서버) → 엣지 게이트웨이 → MQTT**로도 돌릴 수 있다(`npm run dev:opcua`). 태그는 엔지니어링 단위가 붙은 변수로 구독(값이 바뀔 때만), 상태 변경·생산 실적은 사용자 정의 OPC UA 이벤트로 받는다. 엣지는 주소 공간을 탐색해 태그 목록을 스스로 찾고, MQTT가 끊기면 실적을 버퍼에 쌓았다가 다시 보내며, 실적 순번으로 빠진 기록을 센다. MQTT 직행과 같은 기록이 나오는지 테스트로 확인한다([설계 5.7](docs/DESIGN.md#57-opc-ua-경로-가상-plc--엣지-게이트웨이)) |
| 품질·테스트 | 공장 정의·OEE·6대 로스·설비 보전·SPC·보기 전용·AI 비서 도구·시뮬레이터·OPC UA 경로 자동 테스트(`npm test`)와 GitHub Actions CI(타입 검사·테스트·빌드) |
| 품질 인과 | 원인 공정과 증상 공정이 다르다. 예: 전장 라인 LED 마운터 노즐 마모 → 헤드램프 라인 배광 불량. 이상 시나리오 10가지(설비 이상 9 + 불량 자재 LOT 입고 1)를 화면에서 켜고 끌 수 있다 |
| MES | 설비·라인 OEE, FPY, X̄-R 관리도와 Cpk, 알람(고장·규격 이탈·품질·SPC), 완제품 → 부품 → 자재 LOT 계보 조회, 원격 명령(정지·재가동·고장·수리). 서버를 다시 띄워도 실시간 집계는 DB 기록에서 되살아난다([설계 5.6](docs/DESIGN.md#56-서버-재시작과-실시간-집계-복원)) |
| MES 화면 | 생산 현황(시간대별 실적·설비별 OEE·병목 후보), 6대 로스(계획 시간이 고장·셋업·대기·속도·불량·초기 수율로 새는 구성과 개선 우선순위), 설비 보전(고장 이력·MTBF·MTTR 실적과 설계·계획 보전 일정, [설계 5.8](docs/DESIGN.md#58-설비-보전-maintenance-화면-maintenance)), SPC(관리도·Cpk·히스토그램·규칙 위반), 불량 분석(파레토·불량품과 양품의 공정값 비교·출하 유출), 추적(시리얼 계보·자재 LOT 불량률 비교·회수 범위) |
| AI 현장 비서 | 공장 데이터 도구 13개(현황·설비·알람·SPC·6대 로스·설비 보전·파레토·요인 비교·LOT·계보·작업표준서 검색)를 불러 답하는 챗봇. API 키가 없으면 같은 도구를 규칙으로 부르는 모의 모드로 돈다. 가상 작업표준서 15건을 검색해 `[WS-OSM-02 §7]`처럼 인용하고, 음성으로도 묻는다(로컬 Whisper 또는 브라우저 음성 인식). 답 속 설비·LOT·인용을 누르면 그 화면으로 간다([설계 6장](docs/DESIGN.md#6-ai-현장-비서)) |
| 작업자 태블릿 | 설비 앞에서 쓰는 큰 버튼 화면. 사유를 골라 계획 정지·셋업·고장 등록(사유는 MES 상태 이력과 OEE 손실 구분에 들어감), 작업 전 점검 기록(항목은 작업표준서에서 읽고, 이상이면 MES 알람), 재가동·수리 전 안전 확인, 표준서 조치 절 바로 열기, 말로 묻기([설계 7장](docs/DESIGN.md#7-작업자-태블릿과-배포)) |
| 공개 링크·배포 | 무료: 이 PC를 Cloudflare Tunnel로 HTTPS 공개, 공개 링크 방문자는 보기 전용(제어 키로 풀 수 있음)([deploy/cloudflare](deploy/cloudflare/README.md)). 상시 서버: Caddy(HTTPS) + pm2 설치 스크립트([deploy/aws](deploy/aws/README.md)), Oracle Cloud 상시 무료 ARM VM에 올리는 순서([deploy/oracle](deploy/oracle/README.md)) |

### 화면

| 경로 | 화면 | 볼 수 있는 것 |
|---|---|---|
| `/` | 3D 공장 | 설비 상태(경광등), 라인 카드, 알람, 설비 상세 패널, AMR 이송 |
| `/production` | 생산 현황 | 숫자 타일(완성·최근 1시간/목표·OEE·FPY·설비 상태), 시간대별 생산 막대(목표선), 설비별 상태 시간 구성과 OEE, 병목 후보(가동률×성능 최대) |
| `/losses` | 6대 로스 | 공장·라인별 계획 시간 구성(가치 시간 = OEE + 고장·셋업·조정·순간 정지·공회전·속도 저하·공정 불량·초기 수율), 개선 우선순위(설비 × 로스, 기본은 대기 제외), 설비별 로스 구성 |
| `/maintenance` | 설비 보전 | 고장·MTBF·MTTR·가용도·계획 보전 타일, 고장 타임라인(설비별 고장·계획 보전 구간), 설비별 MTBF·MTTR 실적과 설계(고장 잦음·수리 오래 걸림 표시), 계획 보전 경과와 할 일, 작업 전 점검, 고장 사유 합계, 최근 고장 |
| `/spc` | SPC | 관리 항목 목록(Cpk 등급·최근 이탈), X̄·R 관리도(Western Electric 규칙 위반 표시), 개별값 히스토그램과 규격선, Cp·Cpk·Ppk |
| `/quality` | 불량 분석 | 라인 불량 파레토, 불량 요인 비교(불량품과 같은 시기 양품의 공정값을 하위 부품까지 따라가 효과 크기 순으로), 자재 LOT 편중, 출하 유출 |
| `/trace` | 추적 | 시리얼 검색과 계보(정·역추적), 자재 LOT별 불량률(같은 자재의 다른 LOT 대비 편중 의심, 같은 시기 더 강한 편중 LOT가 있으면 그 영향 가능으로 표시), LOT의 영향 제품(회수·격리 범위, CSV). `/trace?lot=…`·`?serial=…`로 바로 열 수 있다 |
| `/operator` | 작업자 태블릿: 설비 고르기 | 라인별 설비와 지금 상태, 마지막에 쓴 설비로 `이어서` |
| `/operator/{설비 코드}` | 작업자 태블릿: 설비 화면 | 상태·사유, 설비 조작(계획 정지·셋업·고장 등록·재가동·수리 완료), AI 비서에게 묻기(말로 묻기), 이 설비 알람, 공정 조건, 작업 전 점검, 작업표준서, 최근 가공. 가로 태블릿은 두 열, 세로·휴대폰은 한 열 |
| 모든 화면 오른쪽 | AI 현장 비서 | 위쪽 `AI 비서` 버튼 또는 Ctrl+/. 조회한 도구와 결과 요약, 답(표·목록), 작업표준서 창, 음성 입력, 멈춤·새 대화. 열면 화면 내용이 패널 왼쪽으로 비켜 서고 좁으면 한 단으로 접힌다 |

### 화면 모습

가상 60배속으로 몇 시간 돌리고 이상 시나리오 3개(렌즈 금형 온조기 이상·LED 마운터 노즐 마모·웜기어 세트 불량 LOT 입고)를 켜고 증착기 한 대에 고장을 넣은 상태에서, OPC UA 경로(`npm run dev:opcua`)로 찍었습니다. AI 비서는 API 키 없이 도는 모의 모드입니다.

| 생산 현황 | 6대 로스 |
|---|---|
| ![생산 현황: 라인 실적·OEE·FPY 타일, 시간대별 생산 막대와 목표선, 설비별 상태 시간 구성](docs/images/production.png) | ![6대 로스: 라인별 계획 시간 구성 막대와 개선 우선순위](docs/images/losses.png) |
| **설비 보전** | **SPC** |
| ![설비 보전: 고장·정지 시간·MTBF·MTTR 타일, 설비별 고장·계획 보전 타임라인, 설비별 MTBF·MTTR 실적과 설계 비교 표](docs/images/maintenance.png) | ![SPC: 규격 이탈로 Cpk가 떨어진 배광 검사 항목의 X̄·R 관리도와 히스토그램](docs/images/spc.png) |
| **불량 분석** | **추적** |
| ![불량 분석: 불량 파레토와 불량품·양품 요인 비교, 자재 LOT 편중](docs/images/quality.png) | ![추적: 최근 불량 제품 목록과 시리얼 계보(거친 공정의 조건·판정과 투입 자재 LOT)](docs/images/trace.png) |
| **AI 현장 비서** | **작업자 태블릿** |
| ![AI 현장 비서: 'OEE가 왜 낮아? 6대 로스로 보여 줘'에 6대 로스 도구를 불러 표와 개선 순위로 답한 화면](docs/images/assistant.png) | ![작업자 태블릿: 고장 난 증착기의 상태·사유, 수리 완료 버튼, 공정 조건, 이 설비 알람](docs/images/operator.png) |
| **데이터 경로 (OPC UA)** | |
| ![데이터 경로 팝오버: 가상 PLC → OPC UA → 엣지 게이트웨이 → MQTT → MES와 게이트웨이 상태](docs/images/data-path.png) | |

화면을 바꾼 뒤에는 앱을 띄워 둔 채 `npm run screenshots`로 다시 찍습니다(설치된 Edge·Chrome을 헤드리스로 씀, `npm run screenshots -- losses spc`처럼 골라 찍기).

## 실행

필요한 것: Node.js 22.19 이상, Python 3(3.14.7에서 확인). PostgreSQL은 `embedded-postgres`로 자동으로 띄우므로 따로 설치하지 않아도 됩니다.

```bash
npm install
```

```bash
npm run sim:setup
```

```bash
npm run dev
```

`npm run dev` 하나로 DB → 공유 패키지 빌드 → MES 서버(마이그레이션 포함) → 화면 → 시뮬레이터가 순서대로 뜹니다. 브라우저에서 http://localhost:5180 을 엽니다.

| 포트 | 용도 |
|---|---|
| 5180 | 화면 (Next.js) |
| 8790 | MES API `/api/v1`, Socket.io |
| 1884 | MQTT 브로커 |
| 54332 | PostgreSQL (DB 이름 `lumitwin`, 데이터는 `.local-db/`) |

같은 와이파이의 태블릿·휴대폰에서는 `http://<이 PC의 IP>:5180/operator`로 들어옵니다. 다만 브라우저는 HTTPS나 localhost에서만 마이크를 허락하므로, 태블릿에서 음성 질문까지 하려면 [공개 링크](deploy/cloudflare/README.md)(HTTPS)로 엽니다.

시뮬레이터만 따로 돌릴 때(배속·난수 시드 지정):

```bash
npm run sim -- --speed 60 --seed 7
```

브로커 없이 최대 속도로 돌려 통계만 볼 때(시나리오 보정용):

```bash
npm run sim -- --offline --hours 8 --scenario EM-NOZZLE-WEAR --at 1
```

### OPC UA 경로로 돌리기 (선택)

설비 신호가 가상 PLC(OPC UA 서버, `opc.tcp://127.0.0.1:4840/lumitwin/`) → 엣지 게이트웨이 → MQTT로 들어옵니다. OPC UA 라이브러리(`asyncua`)를 한 번 설치합니다.

```bash
npm run sim:setup:opcua
```

```bash
npm run dev:opcua
```

화면 위쪽 맨 오른쪽의 두 번째 연결 점(1536px 이상 넓은 화면에서는 `OPC UA` 글자가 붙는다)을 누르면 데이터 경로와 엣지 게이트웨이 상태(탐색한 설비·태그 수, 받은 이벤트, 버퍼, 빠진 실적, 재연결)가 보입니다. UaExpert 같은 OPC UA 클라이언트로 4840에 붙어 주소 공간(`Objects/LumiTwin/라인/설비/Tags`)과 이벤트를 직접 볼 수도 있습니다. 엣지만 따로 띄울 때는 `npm run edge -- --opcua opc.tcp://주소:4840/ --host 브로커 --port 1883`.

### 테스트

```bash
npm test
```

공장 정의(shared), MES 계산(server: OEE·6대 로스·SPC·보기 전용), 시뮬레이터(sim: 결정성·시나리오·재가동 초품·시계, OPC UA 경로)를 돕니다. `asyncua`가 없으면 OPC UA 서버를 띄우는 테스트만 건너뜁니다. 같은 검사가 GitHub Actions에서 올릴 때마다 돕니다.

### AI 현장 비서 설정 (선택)

아무것도 하지 않으면 **모의 모드**로 돕니다(키 없이 실제 데이터를 조회해 정해진 틀로 답함). `server/.env`([예시](server/.env.example))에 키를 넣고 서버를 다시 띄우면 Claude가 같은 도구로 자유로운 질문에 답합니다.

```
ANTHROPIC_API_KEY=...
```

음성 질의는 기본으로 브라우저 음성 인식(Chrome·Edge)을 씁니다. 로컬 Whisper로 받아쓰려면 한 번 설치하고 띄운 뒤, `server/.env`에 `STT_BASE_URL=http://localhost:8792`를 넣습니다. 처음 실행할 때 small 모델(약 460MB)을 `tools/whisper/.models`에 받습니다. Whisper 서버가 꺼져 있으면 저절로 브라우저 음성 인식으로 돌아갑니다.

```bash
npm run whisper:setup
```

```bash
npm run whisper
```

## 공개 링크·배포

**무료 공개 링크 (Cloudflare Tunnel)**: 이 PC에서 운영 빌드를 띄우고 Cloudflare Tunnel로 `https://…trycloudflare.com` 주소를 받습니다. 서버 비용은 없고, 이 PC가 켜져 있는 동안만 열립니다. cloudflared 실행 파일은 `tools/cloudflared/`에 둡니다.

```bash
npm run build
```

```bash
npm run share
```

공개 링크로 들어온 방문자는 보기 전용입니다. 화면·실시간 값·AI 비서는 쓰지만 배속·시나리오·초기화·설비 조작·점검 기록은 막힙니다. 시연자는 화면의 `보기 전용`을 눌러 `server/.env`의 `CONTROL_KEY`를 넣으면 조작할 수 있습니다. 고정 주소(이름 붙인 터널), 특정 메일만 들어오게 막기, 설정은 [deploy/cloudflare/README.md](deploy/cloudflare/README.md)에 있습니다.

| 명령 | 하는 일 |
|---|---|
| `npm run start` | 운영 모드로 DB·MES·화면·시뮬레이터 띄우기 (`npm run build` 뒤) |
| `npm run tunnel` | 떠 있는 화면(5180)에 터널만 붙이기 |
| `npm run share` | 위 둘을 한 번에 |

**상시 서버**: PC를 꺼도 열려 있는 링크가 필요하면 Linux 서버 한 대(Ubuntu 24.04, 램 4GB)에 Caddy(HTTPS 자동 인증서)와 pm2로 전부 올립니다. 설치 스크립트 하나가 서버 준비부터 기동·재부팅 자동 시작까지 합니다.

- **무료**: Oracle Cloud 상시 무료 ARM 서버(A1, 2 OCPU · 4GB)와 무료 주소(DuckDNS). 가입, VM 만들기, 방화벽, 주소, 회수 규칙은 [deploy/oracle/README.md](deploy/oracle/README.md)에 있습니다.
- **유료**: AWS EC2·Lightsail 같은 다른 Ubuntu 서버. [deploy/aws/README.md](deploy/aws/README.md)

```bash
SIM_LINK=opcua bash deploy/aws/setup-ubuntu.sh 이름.duckdns.org
```

도메인 자리에 `auto`를 넣으면 공인 IP로 `a-b-c-d.sslip.io` 주소를 만듭니다. `SIM_LINK=opcua`는 설비 신호를 OPC UA 경로(가상 PLC → 엣지 게이트웨이 → MQTT)로 보냅니다.

## 시연 순서

면접용 대본(5분·2분)과 예상 질문은 [docs/DEMO.md](docs/DEMO.md)에 있습니다. 아래는 기능을 하나씩 둘러보는 순서입니다.

1. **공장 전체**: 왼쪽 라인 카드에서 완성 수, 최근 1시간/목표, OEE와 가동률·성능·양품률, FPY를 본다. 배속을 60×로 올린다.
2. **이상 시나리오**: 위쪽 `이상 시나리오`에서 `LED 마운터 노즐 마모`를 켠다. 원인은 전장 라인에 있지만 헤드램프 라인의 배광 검사에서 불량이 늘어난다.
3. **알람 → 설비**: 왼쪽 아래 알람을 누르면 카메라가 그 설비로 날아가고 상세 패널이 열린다. 상태 시간, 공정 조건, 불량 인과(원인 태그 ← 표시), SPC 관리도와 Cpk를 본다.
4. **SPC → 불량 분석**: `SPC` 탭에서 배광 검사기의 광축 관리도가 위로 흘러가는 것을 보고, `불량 분석` 탭의 요인 비교에서 불량 램프에만 큰 값이 다른 라인 LED 마운터의 장착 편차임을 확인한다.
5. **자재 LOT**: `웜기어 세트 불량 LOT 입고`를 켜면 사이드미러 기능 검사의 소음 불량이 는다. 설비 조건은 정상이다. `불량 분석`에서 소음 불량품 전부가 한 웜기어 LOT를 썼다는 `자재 LOT 편중`이 뜨고, 그 LOT를 누르면 `추적` 탭으로 넘어가 LOT별 불량률 비교와 회수(완성)·격리(공정 중) 대상 제품 CSV를 본다. 같은 시기에 쓴 도료·글래스 LOT도 불량률이 오르지만 "그 영향일 수 있음"으로 구분된다.
6. **원격 명령**: `고장 주입` → 라인 카드에 고장 설비가 뜨고 3D 경광등이 빨갛게 바뀐다 → `수리 완료`. `생산 현황` 탭의 시간대별 막대가 목표선 아래로 내려간다.
7. **AI 현장 비서**: `AI 비서`를 열고 "사이드미러 기능 검사 소음 불량 원인이 뭐야?"라고 묻는다(마이크로 말해도 된다). 비서가 파레토 → 요인 비교 → LOT 비교 → 작업표준서 검색을 차례로 부르는 것이 보이고, "웜기어 LOT가 원인일 가능성이 크다"와 함께 `[WS-OSM-02 §7]` 이상 조치를 인용한다. 인용을 누르면 표준서가 그 절로 열리고, LOT를 누르면 `추적` 탭의 회수 범위로 간다. "고장 난 설비 있어? 조치 방법도 알려 줘"는 고장 설비와 표준서의 LOTO·재가동 절차로 답한다.
8. **작업자 태블릿**: 태블릿(또는 브라우저 폭을 줄인 창)에서 `작업자` 탭 → `HL-VM-01 진공증착기`. `증착 챔버 미세 누설`을 켜 두면 공정 조건에 펌프다운 시간 이탈이 뜬다. 작업 전 점검에서 첫 항목을 `이상`으로 기록하면 MES 알람이 오르고, `고장 등록` → `누설`을 고르면 3D 경광등과 알람에 "누설 (작업자 등록)"이 보인다. `조치 방법`은 표준서 이상 조치 절을 열고, `수리 완료`는 안전 항목을 확인해야 눌린다.

## 폴더

| 폴더 | 기술 | 역할 |
|---|---|---|
| [`shared/`](shared) | TypeScript, tsup | 공장 정의(라인·설비·태그·불량 인과·시나리오)의 단일 원본. 빌드할 때 `factory.json`도 내보내 Python이 같은 정의를 읽는다 |
| [`sim/`](sim) | Python, SimPy, paho-mqtt, asyncua(선택) | 가상 공장·PLC. 설비 상태 기계, 버퍼, 배치·터널 설비, MTBF/MTTR 고장, 품질 인과, 재가동 초품, AMR. 선택: OPC UA 서버(`opcua_plc.py`)와 엣지 게이트웨이(`edge.py`) |
| [`server/`](server) | NestJS 12, Prisma 7, PostgreSQL, aedes, Socket.io | MQTT 수집, 실시간 OEE·SPC·알람, 일괄 기록, 추적 API, 시뮬레이터 제어 |
| [`client/`](client) | Next.js 16, React 19, React Three Fiber, Tailwind 4, TanStack Query, zustand | 3D 공장(설비 24종을 공정군별 파일로 절차적 모델링, 부위 이름표, 개발용 미리보기 `/dev/machines`), HUD, 상세 패널(설비마다 하는 일·앞뒤 공정 안내), 계보 창, MES 화면 5개(차트는 라이브러리 없이 SVG로 직접 그림), AI 비서 패널 |
| [`tools/whisper/`](tools/whisper) | Python, faster-whisper | 선택: OpenAI 호환 로컬 음성 받아쓰기 서버 |
| [`deploy/cloudflare/`](deploy/cloudflare) | cloudflared | 무료 공개 링크: 이 PC를 Cloudflare Tunnel로 공개하는 방법(`scripts/tunnel.mjs`)과 보기 전용 설정 |
| [`deploy/aws/`](deploy/aws) | bash, pm2, Caddy | 상시 서버 한 대 배포: 설치·갱신 스크립트, pm2 프로세스 정의, Caddyfile, 운영용 `.env` 예시 |
| [`deploy/oracle/`](deploy/oracle) | — | 무료 상시 서버: Oracle Cloud 상시 무료 ARM VM을 만들어 위 스크립트로 올리는 순서 |
| [`docs/`](docs) | — | [설계 문서](docs/DESIGN.md), [시연 대본](docs/DEMO.md), 공정 리서치 3편, [가상 작업표준서 15건](docs/standards) |

## 주요 API (`/api/v1`)

| 경로 | 내용 |
|---|---|
| `GET factory` | 공장 정의 + 불량 이름 |
| `GET live/snapshot` | 설비·라인·AMR 실시간 상태 |
| `GET live/spc/:station` | 설비의 X̄-R 관리도, Cpk |
| `GET live/losses` | 6대 로스: 설비별 시간 구성(가상 초)과 라인·공장 합계, 재가동 직후 불량 수 |
| `GET live/alarms`, `POST live/alarms/:id/ack` | 알람 목록·확인 |
| `GET maintenance?run=` | 설비 보전: 설비별 고장 수·고장 시간·MTBF·MTTR 실적과 설계·가용도, 계획 보전 경과와 상태, 마지막 작업 전 점검, 최근 고장·계획 보전 구간(300건), 고장 사유 합계 (DB 기준) |
| `GET production/trace/:serial` | 시리얼 계보(하위 부품까지 재귀) |
| `GET production/ancestors/:serial` | 이 부품이 들어간 상위 제품 |
| `GET production/lots/:lot` | 자재 LOT → 쓴 부품(설비별) → 조립돼 들어간 맨 위 제품(회수 범위) |
| `GET production/lot-quality?material=` | 자재 LOT별 부품 수·불량·완성 (상위 제품까지 따라가 판정) |
| `GET production/units?line=&status=` | 제품 현재 상태 목록 |
| `GET production/factors/:station?defect=` | 불량 요인 비교: 불량품과 같은 시기 양품의 공정값·부품 속성 차이(효과 크기) + 불량품 쪽에 몰린 자재 LOT |
| `GET production/defects?line=` | 설비·불량 코드별 누계 (DB 기준, 파레토와 요인 분석 대상 목록) |
| `GET production/hourly/:line` | 시간대별 생산·불량 |
| `GET production/escapes` | 검사를 빠져나간 잠재 불량 |
| `GET sim/status` | 시뮬레이터 상태, 데이터 경로(`link`: mqtt·opcua), OPC UA 경로면 엣지 게이트웨이 상태 |
| `POST sim/speed` · `pause` · `resume` · `reset` · `scenario` · `station` | 시뮬레이터 원격 제어. `station`은 `{code, op: stop·setup·start·repair·fail, reason?}` (사유 40자) |
| `GET access` | 이 접속이 보기 전용인지(`{readOnly, unlockable}`). 공개 링크(Cloudflare를 거친 요청)는 쓰기 요청이 403, 제어 키는 `x-lumitwin-key` 머리글 |
| `GET operator/checks?station=&limit=`, `POST operator/checks` | 작업 전 점검 기록 조회(이번 실행, 최근 순)·저장(`{station, doc, items: [{text, ok}], by}`, 이상이 있으면 알람) |
| `GET assistant/info` | 비서 모드(Claude·모의), 음성 받아쓰기 가능 여부, 추천 질문 |
| `POST assistant/chat` | 질문 → NDJSON 이벤트 흐름(도구 호출·결과·답 조각·완료) |
| `GET assistant/standards`, `GET assistant/standards/:id` | 작업표준서 목록·본문(조건표를 공장 정의로 채움) |
| `POST assistant/transcribe` | 음성(multipart `audio`) → 받아쓴 글 |

## 다음 단계

- 고정 주소 공개 링크: Cloudflare 계정·도메인으로 이름 붙인 터널 쓰기 (스크립트는 토큰만 넣으면 됨)
- 늘 켜 둘 링크: Oracle 상시 무료 VM에 실제로 올려 보기 (스크립트·안내서는 준비됨, Linux·ARM에서 아직 돌려 보지 않음)
- OPC UA 경로에 보안 정책(Basic256Sha256 서명·암호화, 인증서) 켜기. 지금은 로컬 시연용으로 SecurityPolicy None·익명 접속
- 작업자 명령(정지·셋업·재가동)도 OPC UA 메서드로 PLC에 내리기. 지금은 MQTT로 시뮬레이터에 바로 간다
