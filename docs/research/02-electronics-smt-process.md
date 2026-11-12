# 리서치 02 — 자동차 전장 모듈(BMS·SBCM) 생산 공정 (공개 자료)

> 조사일: 2026-11-11
> 표기: **[확인]** 출처에서 직접 확인 · **[약함]** 업체 블로그·2차 자료, 출처 간 값이 다르면 그렇게 적음 · **[추정]** 공개 근거 없음, 일반 공정 지식.
> IPC·JEDEC·AEC·ISO 규격 본문은 유료라 직접 읽지 못했다. 규격 숫자는 대부분 2차 자료다.

## 1. 에스엘 관련 공개 정보

| 항목 | 내용 | 신뢰도 |
|---|---|---|
| BMS 수주 | 2022-04-27 기아와 BMS 공급 계약, 약 2,025억 원 | [확인] 금액 (아시아경제) |
| BMS 매출 | 2023년 현대차 국내 공장 공급 BMS 약 210억 원, 2024년 하반기 기아 수주분 390억 원 추가 전망 | [약함] (뉴스토마토 요약) |
| SBCM 수주 | 현대차·기아, 계약 기간 2024-05 ~ 2035-12 | [확인] (MarkLines) |
| SBCM 기능 | 아웃사이드 미러·충전구 도어 등 **도어 영역의 개별 제어기를 통합 제어**하는 모듈. 13개 차종 공급 예정 보도 | 기능 [확인], 차종 수 [약함] |
| 생산 거점 | BMS·SBCM 생산 공장은 공개 자료에서 못 찾음 → 포트폴리오에서는 "가상 공장"으로 명시 | — |

## 2. 제품 개요

- **12V 보조배터리 BMS**: 셀 전압·전류·온도 측정, SOC/SOH 추정, 보호 차단, 진단. 상위 ECU와 CAN/CAN FD, 납축 배터리 센서(IBS)는 LIN. ASIL B~C 수준으로 홍보됨. [약함, Infineon·NXP 자료]
- **고전압 BMS**: BMU(중앙: 팩 전류, 최대 1,000 V급 고전압 측정, 절연저항, 컨택터 제어, 상위 통신) + CMU(셀 그룹 전압·온도, 패시브 밸런싱. NXP 예: CMU 1장에 AFE 4개로 최대 56셀).
- **주요 부품**: MCU(NXP S32K3), AFE(TI BQ79616-Q1: 셀 전압 정확도 ±1.5 mV [확인], NXP MC33772C), CAN/LIN 트랜시버, 커넥터, 션트, 하우징.
- **FCT/EOL 시험 후보** [추정]: 소비전류·암전류, CAN/LIN 통신·진단 응답, 셀 전압 측정 정확도(판정 ±3~5 mV), NTC 온도, 션트 전류 교정, 밸런싱 FET 동작, 절연저항 측정 기능, 펌웨어 플래싱·DTC 확인.

## 3. 공정 흐름과 택트 감각

```
PCB 투입 → 레이저 마킹(DMC) → 솔더 인쇄 → SPI → 마운터 → 리플로우 → AOI → (AXI)
 → THT 커넥터(선택 웨이브/프레스핏) → 디패널링 → ICT → 컨포멀 코팅 → 경화 → UV 코팅 검사
 → FCT → 하우징 조립(체결·실링) → EOL → 라벨 → 포장
```

- 순서는 일반 관행이고 라인마다 다르다(특히 ICT/FCT와 코팅 순서). [추정]
- **마운터**: Yamaha YSM20R 공칭 95,000 CPH, IPC-9850 기준 66,000 CPH, 장착 정밀도 ±0.035 mm (3σ, Cpk ≥ 1.0). [확인] 실효는 IPC-9850 값의 60~80 %. [추정]
- **시간당 장수 계산 예** [추정]: 보드당 부품 300점, 실효 40,000 CPH → 약 130장/h. 병목은 마운터보다 리플로우 피치와 FCT/EOL인 경우가 많다.

| 공정 | 택트 (초/장) [추정] |
|---|---|
| 인쇄 | 15~30 |
| SPI | 10~20 |
| 마운터 | 30~60 |
| 리플로우 | 인라인, 피치 기준 30~60 |
| AOI | 20~40 |
| ICT | 30~60 |
| FCT | 40~120 |
| 하우징 조립 | 30~60 |
| EOL | 60~180 |

## 4. 공정별 표

| 공정 | 설비 | 파라미터 (범위) | 주요 불량 ← 원인 | 출처 |
|---|---|---|---|---|
| PCB 투입·레이저 마킹 | 로더, 레이저 마커 | DMC 2D 코드, 마킹 후 판독 확인 | 판독 불량·코드 중복 → 추적성 단절 | 일반 지식 |
| 솔더 인쇄 | 스텐실 프린터 | 스퀴지 속도 20~80 mm/s (미세 피치 20~40), 압력 0.3~0.5 N/mm, 분리 속도 1~3 mm/s (출처 간 편차 큼) [약함] | 브리지 ← 과압·가스켓 불량 · 미납 ← 속도 과다, 압력 부적절 · 번짐 ← 느린 분리 | S12 |
| SPI | 3D SPI | **부피 70~130 %** 가 가장 흔한 판정 (표준 80~120 % 사례), 높이 ±15~20 % [약함] | 페이스트 부족 → 미납·냉납 위험 | S13 |
| 마운터 | YSM20R급 | 95,000 CPH(공칭), ±0.035 mm [확인] | 누락·틀어짐 ← 노즐 오염, 피더, 인식 실패 [추정] | S11 |
| 리플로우 | 대류 리플로우 | SAC305 액상선 217~219 °C, 예열 램프 ≤ 3 °C/s, 소크 150→180 °C 약 120 s, **피크 245 °C (245~255)**, **TAL 40~80 s**, 냉각 약 4 °C/s [약함]. 질소 O2 목표는 1,000/500/50 ppm로 출처 불일치 | **냉납 ← 피크↓·TAL↓** · IMC 과성장 ← 피크·시간 과다 · 보이드 ← 예열·소크 부적절 · 툼스톤 ← 패드 가열 비대칭 | S14~S16 |
| AOI | 인라인 AOI | 유무·극성·위치·납땜 판정 | 누락·틀어짐·브리지·미납 검출 | — |
| AXI | X-ray | BGA 보이드 한계 20~30 % (대표 25 %) [약함] | 보이드, HiP | S16, S17 |
| 선택 웨이브 | 선택 솔더링 | 포트 260~280 °C, 접촉 1.5~5 s [약함] | 충전 부족 ← 온도·시간·예열 부족 | S18 |
| 디패널링 | 라우터 | 근거 없음 | 가장자리 부품 균열(응력) [추정] | — |
| 컨포멀 코팅 | 선택 코팅기 | 건조 막두께 25~127 µm (1~5 mil), 아크릴 30~130 µm 인용 [약함] | 기포 ← 스프레이 압력 과다·과도포 · 디웨팅 ← 플럭스 잔류 · UV 검사는 유무만 보고 두께는 못 잰다 | S19, S20 |
| ICT/FCT | 핀 시험기, 기능 시험기 | 2절 항목, 한계값 [추정] | 통신 불량 ← 트랜시버 납땜·클럭·펌웨어 · 측정 오차 ← 션트·AFE 납땜, 교정 | S10 |
| 하우징 조립 | 자동 드라이버, 실링 | M3 금속 나사 약 1.0~1.1 N·m, 플라스틱 직접 체결 0.4~1.5 N·m [약함] | 토크 과다 → 파손, 과소 → 풀림 · 실링 ← 가스켓 압축 부족 | S21 |
| EOL | EOL 시험기 | CAN, 절연저항, 전압 정확도, 밸런싱. 합격 기준 공개 근거 없음 [추정] | 절연 불량 ← 코팅 오염·이물·조립 손상 | — |

## 5. 불량-원인 인과 (모델링 후보)

| 불량 | 증가 원인 | 신뢰도 |
|---|---|---|
| 브리지 | 인쇄 압력 과다, 가스켓 불량, 페이스트 과다 | [약함] |
| 미납·부족 | 스퀴지 속도 과다, 압력 부적절, **개구부 막힘** | [약함] |
| 냉납 | **피크 온도↓, TAL↓** | [약함] |
| IMC 과성장 | 피크·TAL 과다 | [약함] |
| 툼스톤 | 패드 가열 비대칭, 질소 분위기 | [약함, 상충 보고] |
| 보이드 | 예열·소크 부적절 | [약함] |
| 코팅 기포 | 스프레이 압력·건조 속도 과다, 과도포 | [약함] |
| 선택 웨이브 충전 부족 | 접촉 시간↓, 포트 온도↓ | [약함] |
| 통신·절연 불량 | 위 납땜 불량의 하류 결과 | [추정] |

## 6. 품질 요구사항 (개념)

| 규격 | 의미 |
|---|---|
| IPC-A-610 Class 3 | 고신뢰 전자제품 육안 합격 기준. 자동차 안전 모듈은 Class 3 또는 고객 지정 동급 [약함] |
| IPC J-STD-001 | 납땜 조립 요구사항 |
| IATF 16949 | 자동차 품질경영. 고정 수율 목표가 아니라 공정 규율·예방 체계. PPM 목표는 고객 요구(PPAP·관리계획) [약함] |
| AEC-Q100/Q200 | IC·수동소자 자동차 신뢰성 인증 |
| ISO 26262 Part 7 | 생산·운용·서비스·폐기. 안전 관련 특성의 생산 관리 계획과 변경 관리 [구조 확인] |
| 추적성 | 완제품 DMC → PCB 로트·페이스트 로트·리플로우 프로파일·검사 결과까지 연결 [약함] |
| FPY | SMT 직행률 98~99.5 % 일반, 99.8 % 양호, 99.95 % 세계 수준(벤더 표). 재작업 후 출하도 직행 실패로 계산 [약함] |

## 7. 설계 제안 (반영함)

- 모든 파라미터에 근거 등급(`confirmed | weak | assumed`)을 두고 화면에 표시한다 → 정직성이 포트폴리오의 장점이 된다.
- 에스엘 제품과 가상 공장은 "공개 정보 기반 가상 모델"이며 실제 라인과 무관하다고 명시한다.

## 출처

- S1 https://view.asiae.co.kr/en/article/2022042716272550084
- S2 https://newstomato.com/ReadNews.aspx?no=1191888
- S3 https://www.marklines.com/en/news/278562
- S4 https://www.hankyung.com/article/2025092173151
- S6 https://infineon.com/cms/jp/applications/automotive/electric-drive-train/automotive-bms/12v-24v-battery-management-system-bms
- S7 https://mx.dasenic.com/blog/details/nxp-s32k312
- S8 https://www.bisinfotech.com/infineon-high-voltage-bms-reference-design-brings-advanced-battery-modeling-and-system-integration-to-the-edge/
- S9 https://www.nxp.com/docs/en/fact-sheet/HVBMSFS.pdf
- S10 https://www.ti.com/product/BQ79616-Q1
- S11 https://global.yamaha-motor.com/business/smt/mounter/ysm20r/spec/
- S12 https://aimsolder.com/sites/default/files/documents/smt_ts.pdf , https://jlcpcb.com/blog/solder-paste-printing-defects-causes-prevention-guide
- S13 https://www.smtnet.com/library/files/upload/New-Opportunities-for-3D-SPI.pdf , https://pcbsync.com/ipc-7527/
- S14 https://compuphase.com/electronics/reflowsolderprofiles.htm
- S15 https://dev.smtnet.com/library/files/upload/Best-Practices-Reflow-Profiling.pdf
- S16 https://www.ipc.org/system/files/technical_resource/E2%26S19_03.pdf , https://rehm-group.com/en/news/blog/details/soldering-defects-and-soldering-atmosphere.html
- S17 https://www.pcbcart.com/article/content/bga-void-rate-acceptance
- S18 https://www.ipc.org/system/files/technical_resource/E30%26S02-5.pdf , https://jlcpcb.com/blog/selective-soldering
- S19 https://mgchemicals.com/knowledgebase/white-papers/conformal-coating-guidelines/
- S20 https://adamscorp.com/our-blog/how-to-measure-conformal-coating-thickness-without-destructive-testing
- S21 https://accu-components.com/p/390-recommended-tightening-torques-for-machine-screws
- S22 https://www.symestic.com/en-us/what-is/production-quality , https://www.pcbcart.com/article/content/pcb-assembly-supplier-benchmark-guide.html
- S23 https://www.iso.org/standard/68389.html
- S24 https://iconnect007.com/article/44038/placement-quality-affects-costs/44041/smt
