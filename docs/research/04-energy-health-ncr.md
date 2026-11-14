# 리서치 04 — 설비 전력 · 상태 감시 · 불량 처리 기준 · LED 레인 맞춤

> 조사일: 2026-11-13 ~ 14 (P9 공장 데이터)
> 설비별 전력·진동·처리 시간은 제조사 사양서에 일부만 나오고, 공장마다 크게 다르다. 값마다 근거 등급을 달았다.
> - **confirmed**: 1차 자료(제조사 사양서·표준)에 그 값이 있다.
> - **weak**: 같은 급 설비의 공개 값, 판매처·매물 표기, 2차 자료에서 끌어왔다.
> - **assumed**: 공개 근거가 없어 구성품을 더하거나 공정 상식으로 잡았다.
>
> 값은 `shared/src/factory/{hl,em,osm}.ts`의 `power()`·`health()`·`fix()`와 각 `note`에 있다. 이 노트는 그 근거를 모은 것이다.

## A. 전력 (`power`: run · idle · off, kW)

### 정의

| 상태 | 뜻 |
|---|---|
| run | 가동 중 평균 전력 (피크가 아니다) |
| idle | 대기·막힘·굶음. 히터·공조·진공은 계속 돈다 |
| off | 고장·보전·계획 정지. 온도 유지 히터나 공조처럼 끌 수 없는 부하만 남는다 |

- 압축공기·냉각수·조명 같은 **공용 유틸리티는 넣지 않았다**. 설비 자신의 전기 부하만 센다.
- 보조 설비(`aux: true`, 제습 건조기 HL-DR-01)는 늘 가동으로 센다.

### 설비별 값

| 설비 | 종류 | run / idle / off | 등급 | 근거 요지 |
|---|---|---|---|---|
| HL-DR-01 | 제습 건조기 | 6 / 4.5 / 1 | weak | 설치 용량 약 11 kW(PPE FX-100 표기) × 부하율 약 55 % (가정) |
| HL-IM-L1 | 렌즈 사출 650 t | 38 / 19 / 14 | weak | 매물 표기 펌프 65 kW·히터 48 kW (Haitian JU6500). 렌즈 약 45 kg/h × 약 0.8 kWh/kg |
| HL-HC-01 | 하드코팅 터널 | 60 / 55 / 30 | assumed | 클린 부스 FFU + 플로 코터 + 130 °C 경화로 16 m. 공조·경화로가 늘 돈다 |
| HL-IM-R1 | BMC 사출 300 t | 22 / 13 / 10 | assumed | 금형 약 150 °C 전기 가열이 멈춰도 남는다 |
| HL-VM-01 | 증착기 | 34 / 22 / 10 | weak | 리플렉터 증착기 평균 최대 36 kW·피크 50 kW (Ferrivatt VATT-1600) |
| HL-IM-H1 | 하우징 사출 850 t | 44 / 20 / 15 | weak | 약 90 kg/h × 약 0.5 kWh/kg (두꺼운 PP) |
| HL-AS-01 | 조립 셀 | 2.2 / 1.2 / 0.4 | weak | 협동로봇 2대 (UR10e 평균 약 350 W, 제조사 표기) + 체결기·컨베이어 |
| HL-SL-01 | 실러 | 5 / 4 / 3 | assumed | 핫멜트 탱크·호스·건 약 190 °C 유지 |
| HL-LT-01 | 누설 시험기 | 0.6 / 0.4 / 0.15 | assumed | 압력 감쇠식 계측·지그 |
| HL-PH-01 | 배광 시험 | 1.4 / 0.8 / 0.25 | assumed | 암실 카메라·서보·램프 점등 |
| HL-EOL-01 | EOL 시험 | 0.9 / 0.6 / 0.15 | assumed | 시험 전원·LIN·PC |
| HL-PK-01 | 포장 | 1 / 0.5 / 0.15 | weak | 협동로봇 1대 (UR10e 약 350 W) + 라벨 |
| EM-PR-L · EM-PR-B | 인쇄기 | 1.5 / 0.9 / 0.3 | assumed | 서보·하부 세척 진공·비전 |
| EM-SPI-L · EM-SPI-B | SPI | 0.9 / 0.7 / 0.2 | assumed | 3D 측정 헤드·스테이지·PC |
| EM-MT-L · B1 · B2 | 마운터 | 1.8 / 1 / 0.3 | weak | YSM20R급 소비 전력 약 1.8 kW (판매처 표기, 2차) |
| EM-RF-L | 리플로우 (MCPCB) | 12 / 10 / 5 | weak | 대류 리플로우 가동 약 7~16 kW (Heller MK5·1809 계열). 열용량이 커 위쪽 |
| EM-RF-B | 리플로우 (FR-4) | 11 / 9 / 4.5 | weak | 같은 근거 |
| EM-AOI-L · EM-AOI-B | AOI | 0.8 / 0.6 / 0.2 | assumed | 카메라·조명·PC |
| EM-RT-L | 라우터 + 협동로봇 | 3.6 / 2.4 / 0.5 | weak | 스핀들 약 1 kW + 집진기 약 2 kW + 협동로봇 약 0.5 kW |
| EM-FCT-L | LED 모듈 시험 | 1 / 0.7 / 0.2 | assumed | LED 구동 전원·분광기·적분구·TEC |
| EM-LM-B | 레이저 마킹 | 0.9 / 0.5 / 0.15 | assumed | 20 W 파이버 레이저·흄 집진 |
| EM-ICT-B | ICT | 1.5 / 1 / 0.3 | assumed | 계측·진공 지그 |
| EM-CC-B | 선택 코팅 + 경화 | 7.5 / 6.5 / 2.5 | assumed | 코팅기 약 1.5 kW + 80 °C 경화로 약 6 kW |
| EM-FCT-B1 · B2 | BMS FCT | 1.2 / 0.8 / 0.2 | assumed | 시험 전원·셀 시뮬레이터 |
| EM-HA-B | 하우징 체결 | 1.2 / 0.6 / 0.2 | assumed | 자동 드라이버·XYZ 축 |
| EM-EOL-B | 절연·통신 시험 | 1 / 0.7 / 0.2 | assumed | 500 V 절연 시험기·CAN |
| EM-PK-B · OSM-PK-01 | 포장 | 0.6 / 0.35 / 0.1 | assumed | 라벨·판독기·컨베이어 |
| OSM-IM-C1 | 커버 사출 450 t | 24 / 12 / 9 | weak | 약 28 kg/h × 약 0.8 kWh/kg |
| OSM-PT-01 | 도장 터널 | 140 / 120 / 45 | weak | 공조·건조로·로봇 모두 전기로 봄. 공장에서 가장 크게 |
| OSM-IM-B1 | 브래킷 사출 180 t 전동 | 10 / 6 / 5 | weak | 전동식 비에너지 약 0.2~0.4 kWh/kg |
| OSM-AC-01 | 액추에이터 셀 | 1.8 / 0.9 / 0.25 | assumed | 서보 프레스·드라이버·그리스 디스펜서 |
| OSM-AS-01 | 미러 조립 셀 | 2 / 1.1 / 0.3 | weak | 협동로봇 (UR10e 약 350 W) + 드라이버·압입 프레스 |
| OSM-FT-01 | 기능 시험 | 1.1 / 0.7 / 0.2 | assumed | 시험 전원(히터 약 40 W 포함)·소음 계측 |

**등급 분포 (40대)**: confirmed 0 · weak 16 · assumed 24.

### 사출기 비에너지 규칙

- 서보 유압식은 약 0.5~0.8 kWh/kg, 전동식은 약 0.2~0.4 kWh/kg로 잡았다 [약함, 업계 비교 자료 범위].
- 가동 평균 = 처리량(kg/h) × 비에너지 + 금형 온조기.
- 정지·대기 전력은 배럴 히터와 온조기가 온도를 지키는 몫이라 가동의 약 35~50 %다 [가정].
- 매물 표기 설치 용량(펌프 65 kW·히터 48 kW)은 **최대값**이라 평균으로 쓰지 않고 상한 확인에만 썼다.

### 도장 터널을 가장 크게 둔 이유

- 자동차 공장 에너지의 큰 몫(공개 자료 범위 약 40~70 %)을 도장 공정이 쓴다 [약함, 2차 자료].
- 실제 공장은 건조로에 가스를 많이 쓰지만, 이 모델은 kW 하나로만 세므로 모두 전기로 바꿔 넣었다 [가정].
- 공조·건조로는 멈춰도 거의 그대로 돌아 idle이 run의 약 85 %다.

## B. 상태 감시 (`health`)

### 모델 (시뮬레이터 B1 구현 기준)

- 진동 ≈ 신품값 × (1 + 6·마모²) → 마모 1에서 **최대 7배** (`sim/lumisim/engine.py`의 `VIB_WEAR_GAIN`).
- 온도 ≈ 신품값 + 18 °C × 마모. 전류도 마모에 따라 오른다.
- 마모 0.8을 넘으면 고장률이 오르고, 마모 1에서 기본의 10배가 된다. 고장 사유는 '이음·진동'이다.
- 계획 보전 뒤 마모는 0.05, 고장 수리 뒤에는 0.1로 돌아간다. 시작 마모는 0~0.3 사이에서 무작위로 정한다.
- `wearHours`는 **가상 시간**이다. 실제 베어링·감속기 수명(수만 시간)을 **1/100로 압축**해, 60배속 시연에서 몇 시간 안에 추세가 보이게 했다.

### ISO 10816-1 진동 구역 (mm/s RMS, `mes.ts`의 `VIB_ZONES`)

| 등급 | 대상 (구동 출력) | A/B | B/C | C/D |
|---|---|---|---|---|
| I | 소형 (약 15 kW 이하) | 0.71 | 1.8 | 4.5 |
| II | 중형 (약 15~75 kW) | 1.12 | 2.8 | 7.1 |
| III | 대형 (강성 기초) | 1.8 | 4.5 | 11.2 |

### 신품값 규칙

- 신품 진동은 **A/B 경계 바로 아래**로 잡았다 (I급 0.64~0.69, II급 1.05~1.08).
- 그러면 마모 약 0.72~0.78에서 B/C 경고가 뜨고, 고장률이 오르는 0.8 직전이라 "경고 → 보전하면 고장을 막는다"는 흐름이 보인다.
- **한계**: 최대 4배라 C/D(약 6.3배)에는 닿지 않는다. 계약 변경 요청으로 계수 1+6·마모²를 제안했다.
- 협동로봇 관절·서보 프레스·자동 드라이버 같은 **왕복 구동부는 원래 ISO 10816-1 적용 대상이 아니다**. 화면 일관성을 위해 소형기 I등급 구역을 빌려 쓰고 note에 적었다.

### 설비별 값 (17대)

| 설비 | 감시 부위 | vib (mm/s) | cur (A) | temp (°C) | wearHours | 등급 | 근거 |
|---|---|---|---|---|---|---|---|
| HL-IM-L1 | 서보 유압 펌프·모터 베어링 | 1.05 | 62 | 48 | 300 | II | assumed |
| HL-IM-R1 | 유압 펌프·모터 베어링 | 1.05 | 34 | 46 | 280 | II | assumed |
| HL-VM-01 | 루츠 진공 펌프 베어링·기어 | 0.68 | 16 | 62 | 300 | I | assumed |
| HL-IM-H1 | 서보 유압 펌프·모터 베어링 | 1.08 | 74 | 50 | 300 | II | assumed |
| HL-AS-01 | 협동로봇 감속기·체결 스핀들 | 0.66 | 2.4 | 40 | 220 | I | assumed |
| HL-PK-01 | 협동로봇 감속기·컨베이어 감속기 | 0.64 | 1.6 | 37 | 350 | I | assumed |
| EM-MT-L | 헤드 Z축·노즐 샤프트 | 0.68 | 3.2 | 38 | 150 | I | assumed |
| EM-MT-B1 | 헤드 구동 베어링·볼스크루 | 0.69 | 3.6 | 39 | 100 | I | assumed |
| EM-MT-B2 | 헤드 Z·θ축 | 0.67 | 3.0 | 38 | 160 | I | assumed |
| EM-RF-L | 대류 송풍기 모터 | 0.66 | 1.4 | 58 | 300 | I | assumed |
| EM-RF-B | 대류 송풍기 모터 | 0.66 | 1.3 | 57 | 300 | I | assumed |
| EM-RT-L | 라우터 스핀들 (40,000 rpm) | 0.68 | 3.8 | 42 | 60 | I | **weak** |
| EM-HA-B | 드라이버 스핀들·Z축 볼스크루 | 0.67 | 1.8 | 39 | 200 | I | assumed |
| OSM-IM-C1 | 서보 유압 펌프·모터 | 1.05 | 48 | 47 | 300 | II | assumed |
| OSM-IM-B1 | 사출 볼스크루·서보 모터 | 0.68 | 24 | 44 | 200 | I | assumed |
| OSM-AC-01 | 서보 프레스 볼스크루·스핀들 | 0.68 | 2.6 | 41 | 180 | I | assumed |
| OSM-AS-01 | 협동로봇 감속기·압입 프레스 | 0.66 | 2.2 | 40 | 220 | I | assumed |

- 라우터 스핀들만 weak다. 그리스 윤활 고속 스핀들 베어링 정격 약 6,000~7,000시간이 가공기 정비 자료(2차)에 나온다. 공장에서 가장 빨리 닳는 회전부라 60 가상시간으로 가장 짧다.
- 나머지는 "실제 수명 약 1만~3.5만 시간(가정) ÷ 100"이다. 칩 마운터 헤드는 왕복이 가장 잦아 가장 짧게(100), 포장 로봇은 하중이 가벼워 가장 길게(350) 잡았다.
- 감시하지 않는 설비: 시험기·검사기·인쇄기·레이저 마커·실러·도장 터널·하드코팅 터널·보조 건조기. 회전·왕복 구동부가 상태 감시의 주인공이 아니거나 사이클이 0이다.

### 시연 시나리오 `EM-MT-BEARING` (칩 마운터 헤드 베어링 마모)

- 효과: `{ station: 'EM-MT-B1', target: 'wear', mode: 'step', amount: 19 }` → 마모 속도 20배.
  - 처음에는 10배로 잡았지만, 진동 식을 vib0·(1+6·wear²)로 바꾼 뒤 다시 재 보니 60배속에서 경고까지 10분 넘게 걸려 시연에 길었다. 20배로 올렸다.
- 오프라인 확인 (씨앗 1·2·3, 처음부터 켬, 15가상분 간격 추적):
  - 2~3.5가상시간 뒤 마모가 약 0.52를 넘어 진동이 B/C(1.8 mm/s)를 넘는다.
  - 마모 0.8을 넘는 약 4~6가상시간부터 '이음·진동' 고장 위험이 커진다 (씨앗 2는 5.5가상시간에 고장).
  - 60배속에서 실제 약 2~4분·5~6분이다.
- 불량률·사이클은 바뀌지 않는다. 품질 문제가 아니라 설비 수명 문제라는 점을 보여 주는 시나리오다.

## C. 불량 처리 기준 (`disposition`, `repairMin`, `repairProb`)

### 용어

| 처리 | 뜻 | 이 모델에서 |
|---|---|---|
| REWORK (재작업) | 원래 공정 절차로 다시 해서 **규격에 완전히 맞게** 만든다 (IPC-7711 개념) | 재체결, 재인쇄, 재도포, 광축 재조정 |
| REPAIR (수리) | 부품 교체·재납땜으로 **기능을 되살린다**. 원래 상태와 같지 않을 수 있다 (IPC-7721 개념) | 재납땜, 모듈·액추에이터 교체, 재실링 |
| SCRAP (폐기) | 고치지 않고 버린다 | 판독 불가 마킹 (아직 부품이 없는 맨 기판) |
| MRB | 자동으로 정하지 않고 품질 판정 위원회가 정한다 | 규격 근처라 재측정이 필요하거나, 고치려면 큰 부품을 바꿔야 하는 경우 |

- REWORK와 REPAIR의 정의는 IPC-7711/7721의 일반적 구분이다 [약함, 2차 설명 자료].
- 분·성공률은 공개 근거가 없어 **모두 가정**이다. 손이 덜 가는 작업일수록 짧고 성공률이 높게 잡았다.
  - 재체결 4분·0.95
  - 재납땜 8~15분·0.85~0.95
  - 렌즈 개봉이 필요한 작업 12~20분·0.75~0.9
  - MRB 판정 10~30분

### 같은 코드는 처리 기준이 하나

`mes.ts`의 `defectDefOf(code)`는 코드로 **첫 정의**를 찾는다. 그래서 같은 코드는 모든 설비에서 처리 기준을 같게 두었고, 테스트로 지킨다.

| 공유 코드 | 설비 |
|---|---|
| COLD | EM-RF-L · EM-RF-B |
| CONN | HL-AS-01 · OSM-AS-01 |
| SCREW | HL-AS-01 · EM-HA-B |
| MISSING | EM-MT-L · EM-MT-B1 |
| SHIFT | EM-MT-B1 · EM-MT-B2 |
| PASTE | EM-SPI-L · EM-SPI-B |

### 표

| 라인 | 코드 | 걸리는 곳 → 처리 | 분 | 성공률 |
|---|---|---|---|---|
| HL | SCREW | 조립 → REWORK (재체결) | 4 | 0.95 |
| HL | CONN | EOL → REWORK (렌즈 열고 재체결) | 12 | 0.9 |
| HL | LEAK | 누설 → REPAIR (재실링) | 20 | 0.75 |
| HL | AIM | 배광 → REWORK (광축 재조정) | 5 | 0.95 |
| HL | LUX | 배광 → **MRB** | 30 | 0.6 |
| HL | ELEC | EOL → REPAIR (모듈·배선 교체) | 20 | 0.75 |
| EM | UNREAD | 마킹 → **SCRAP** | — | — |
| EM | BRIDGE | SPI·AOI·ICT → REPAIR | 8 | 0.95 |
| EM | PASTE | SPI → REWORK (세척·재인쇄) | 6 | 0.95 |
| EM | MISSING · SHIFT | AOI → REPAIR | 8 | 0.9 |
| EM | COLD | ICT·FCT·EOL → REPAIR (재납땜) | 15 | 0.85 |
| EM | TOMB | AOI → REPAIR | 8 | 0.95 |
| EM | BUBBLE | 코팅 검사 → **MRB** | 10 | 0.9 |
| EM | NOCOAT | 코팅 검사 → REWORK (재도포) | 5 | 0.95 |
| EM | SCREW | 체결 → REWORK | 4 | 0.95 |
| EM | FUNC (cell_v_err) | FCT → REPAIR | 15 | 0.8 |
| EM | CURRENT (sleep_ua) | FCT → REPAIR | 20 | 0.7 |
| EM | THERMAL (bal_dt, 새 항목) | FCT → REPAIR | 15 | 0.8 |
| EM | INSUL | EOL → REPAIR (세척·건조) | 25 | 0.7 |
| OSM | CONN | 기능 검사 → REWORK | 12 | 0.9 |
| OSM | GAP | 조립 → REWORK | 6 | 0.9 |
| OSM | FOLD_TIME · MOTOR_CURRENT | 기능 검사 → REPAIR (액추에이터 교체) | 20 | 0.85 |
| OSM | NOISE | 기능 검사 → **MRB** | 20 | 0.85 |
| OSM | HEATER | 기능 검사 → REPAIR | 10 | 0.9 |

- MRB 세 가지(LUX·BUBBLE·NOISE)는 모두 "규격 근처는 재측정 편차일 수 있다"는 공통점이 있다.
  - BUBBLE: IPC-A-610은 도체 사이를 잇지 않는 기포를 받아 줄 수 있어, 사람이 크기·위치를 본다 [약함].
  - NOISE: 소음은 배경 소음 영향을 받아 다시 들어 봐야 한다.
  - LUX: 진짜 미달이면 리플렉터나 LED 모듈을 바꿔야 해 비용이 크다.

## D. LED 레인 수요 맞춤 (EM 라인)

### 수요

- 헤드램프 1대에 LED 모듈 2개, 택트 75초 → 모듈 1개/37.5초.
- 4연 패널이면 **패널 1장/150초**.

### 능력

| 공정 | 설비 | 능력 | 비고 |
|---|---|---|---|
| 인쇄 → SPI(새) → 마운트 → 리플로우 → AOI | EM-PR-L … EM-AOI-L | 패널 1장/약 30초 | 리플로우 300초 · 10장 |
| 분할 (`split: 4`) | EM-RT-L | 패널 1장/100초 = 모듈 1개/25초 | 수요의 약 67 % → 레인 병목 |
| 모듈 시험 (새) | EM-FCT-L | 모듈 1개/24초 | |

- SMT 상류는 능력이 수요의 약 5배다. 간판(버퍼 막힘)으로 BLOCKED 상태로 기다린다.
- 실제로는 이 SMT 라인을 다른 모듈과 함께 쓸 것이다. 그 내용은 note에 적었다.

### 라우터 100초의 근거

- 협동로봇은 ISO/TS 15066 협동 속도 제한 때문에 사람 작업 속도의 약 20~30 %로 움직인다 [약함].
- 패널 1장마다 집기 → 절단 → 모듈 4개 내려놓기를 한다 [가정].

### 오프라인 확인 (씨앗 7, 8가상시간)

| 설비 | 처리량 | 상태 |
|---|---|---|
| 라우터 | 모듈 768개 | RUN 67 % |
| 모듈 시험 | 761개 | |
| HL-AS-01 | 헤드램프 348대 (모듈 696개 필요) | RUN 85 % |
| 포장 완료 | 헤드램프 336대 | |

- LED 공급이 수요보다 약 9 % 많다.
- SMT 상류는 BLOCKED 78~84 %다.

### 배치·이송

- 레인을 z = -4 한 줄에 두었다: 인쇄 -49 → SPI -46.5 → 마운터 -43 → 리플로우 -35 → AOI -29 → 라우터 -22.5 → 모듈 시험 -17.5.
- T-LED는 LED_TEST에서 출발하고, AMR-01은 [-14, -4]에서 기다린다.
- 겹침·베이 밖 설치는 테스트로 막는다.

## E. 리플로우 보이드 → 뒤 검사 연결

| 보이드 | 연결된 측정 | 계수 | 판정선 |
|---|---|---|---|
| LED `void_pct` (EM-RF-L) | EM-FCT-L 열저항 `rth` | +0.12 K/W per z | usl 5.5 |
| | 순방향 전압 `vf` | -0.01 V per z | |
| | 광속 `flux` | -2 lm per z | |
| BMS `bms_void` (EM-RF-B, 새 속성) | EM-FCT-B1·B2 밸런싱 FET 온도 상승 `bal_dt` | +0.8 K per z | usl 26 K |

- 보이드가 커지면 열저항이 오르고, 그 결과 온도가 오르고 광속·Vf가 떨어진다 [확인, 정성적].
- 보이드 영향은 약 25 %를 넘어야 뚜렷하다는 보고가 있다 (ISOM 2013) [약함].
- 그래서 계수를 작게 잡았다. 평소에는 불합격이 거의 0이고, 리플로우 프로파일이 크게 틀어질 때만 뒤 검사에서 드러난다.
- EOL 절연은 보이드와 무관해 잇지 않았다.

## 출처

전력

- Haitian Jupiter III JU6500 매물 (설치 용량 표기): https://www.machineseeker-india.com/haitian-jupiter+3+ju+6500/i-21983108
- Haitian Jupiter 사양서: https://haitianinter.com/wp-content/uploads/sites/4/2018/04/JUII_20160804.pdf
- Heller MK5 브로슈어: https://hellerindustries.com.cn/wp-content/uploads/2022/05/Heller-MK5-brochure.pdf · https://pdf.directindustry.com/pdf/heller-industries/mk5/22061-453657.html
- Heller 1809EXL 매물: https://www.exapro.com/heller-1809exl-p2407053305 · https://www.kitmondo.com/listing/heller-1809exl-p90116009/
- Universal Robots UR10e 데이터시트 (평균 소비 전력): https://www.universal-robots.com/manuals/latest/en/datasheets/ur10e/
- Yamaha YSM20R 사양: https://global.yamaha-motor.com/business/smt/mounter/ysm20r/spec/
- YSM20R 판매처 표기 (소비 전력): https://m.smtlinemachine.com/sale-13356580-three-phase-0-45mpa-290000cph-smd-chip-shooter-yamaha-ysm20.html
- Ferrivatt VATT-1600 증착기: https://allproducts.com/manufacture97/ferrivatt/product3.html
- PPE FX 제습 건조기 설명서: https://manualmachine.com/ppe/fx50/22450623-installation · https://www.scribd.com/document/726402633/FX-Desiccant-Dryer-Manual
- 사출기 에너지 (ACEEE 2005): https://www.aceee.org/files/proceedings/2005/data/papers/SS05_Panel01_Paper15.pdf
- 사출기 효율 비교 지표 (PE 2011-07): https://res.cloudinary.com/sternwald-systems/raw/upload/v1/hugoprd/ARTIKEL_ATTACH/00243B41_5A8E7E531649/ff15e44ebaf93260880847b04098eef7c2fa7020/PE_2011_07_Indices-for-an-Objective-Efficiency-Comparison.pdf
- 서보·유압·전동 비교: https://www.yizumi.com/en/news/product/industry-trend/servo-vs-hydraulic-vs-electric-injection-molding-machine
- Wittmann 건조기: https://www.directindustry.com/prod/wittmann/product-13893-567533.html
- 도장 공정 에너지 비중: https://dergipark.org.tr/en/download/article-file/435158 · https://durr-group.com/en/duerrmore/stay-curious/greenabler

상태 감시

- 스핀들 베어링 수명 (2차): https://woodweb.com/knowledge_base/Life_Expectancy_of_Bearings_in_Spindles.html · https://excellon.com/spindle-repair-101
- 협동 속도 제한 (ISO/TS 15066 설명): https://www.automate.org/tech-papers/iso-ts-15066-explained

불량 처리·보이드

- 보이드와 열 특성 (ISOM 2013): https://www.sciencegate.app/document/10.4071/isom-2013-thp46
- LED MCPCB 보이드: https://www.besterpcba.com/led-mcpcb-thermal-voids
- 솔더 보이드의 기계·열 특성: https://pure.seoultech.ac.kr/en/publications/effect-of-solder-void-on-mechanical-and-thermal-properties-of-fli/
- 누설 판정 (NHTSA TSB): https://static.nhtsa.gov/odi/tsbs/2024/MC-11007974-0001.pdf
- 미러 액추에이터 소음 (Magna): https://magna-eu.magna.com/products/exterior-interior/mirrors/actuators
