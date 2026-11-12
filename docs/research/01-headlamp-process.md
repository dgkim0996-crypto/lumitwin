# 리서치 01 — 자동차 헤드램프 제조 공정 (공개 자료)

> 조사일: 2026-11-11 · 목적: 가상 스마트공장 시뮬레이터의 공정·설비·파라미터 기본값 근거
> 표기: **[출처]** 공개 자료에서 확인한 값 · **[추정]** 출처가 약하거나 일반 공정 지식으로 보정한 값.
> 시뮬레이터는 [추정] 값을 "가상 기본값"으로 쓰고 화면에도 그렇게 표시한다.

## 0. 한계

- Covestro 렌즈 가공 가이드 PDF(cov-206/208/210)는 서버가 503을 돌려줘 본문을 직접 읽지 못했다. 이 자료의 수치는 검색 요약에 인용된 것만 썼다.
- 에스엘·현대모비스 램프의 공정을 단계별로 설명한 공개 자료는 없었다. 회사 기사는 개요와 자동화 동향뿐이다.

## 1. 공정 흐름

```
[원료 건조] → ①렌즈 PC 사출 → (어닐링) → ②하드코팅(클린룸: 전처리→프라이머→하드코트→경화) ──┐
            → ③하우징 사출(PP-TD/PBT) ──────────────────────────────────────────────┤
            → ④리플렉터·베젤 사출(BMC/PC-HT/PEI) → (베이스코트) → ⑤Al 진공증착 → ⑥HMDSO 탑코트 ┤
            → ⑦LED PCB 실장(SMT) → 모듈 조립(방열판·커넥터) ──────────────────────────────┤
                                                                                       ↓
             ⑧램프 조립(액추에이터·배선·브래킷·리플렉터) → ⑨렌즈-하우징 접합 → ⑩기밀검사
                                   → ⑪점등·배광·에이밍 검사 → ⑫EOL → ⑬포장·출하
```

- WIPAC(영국 램프사) 공개 설명이 이 순서를 뒷받침한다: 재질별 전용 사출기(최대 1500톤), 인하우스 진공증착, 렌즈 하드코팅은 클린룸에서 어닐링·UV 경화를 사출 공장과 직결, 접합은 레이저·진동·초음파·IR 융착과 5축 로봇 접착 중 형상·물량에 맞춰 선택, 조립은 클린·ESD 환경. [출처: wipac.com/manufacturing]
- 사출·코팅·증착은 배치/셀형, 조립(⑧~⑬)은 팰릿 컨베이어 라인. [추정]
- 버퍼·물류
  - 렌즈 사출 후 코팅 전 어닐링·클린룸 대기 버퍼. 잔류응력이 남은 렌즈는 코팅 용제에 크랙이 난다(Covestro). 대기 시간 2~24h [추정].
  - 증착 전 예열(특허 사례 60 °C × 2 h), 증착 후 즉시 탑코트(같은 챔버). [출처: US6520650]
  - 증착 리플렉터·코팅 렌즈는 랙/트롤리 단위로 조립 전 버퍼에 쌓인다. [추정]
  - 조립 라인 공정 간 버퍼는 1~3 팰릿. [추정]

## 2. 공정별 표

| 공정 | 설비 | 파라미터 (정상 범위) | 주요 불량 ← 원인 파라미터 | 근거 |
|---|---|---|---|---|
| ① 렌즈 PC 사출 | 사출기, 로봇 취출기, 제습 건조기, 핫런너 | 건조 120 °C × 2~3 h, 수분 ≤ 0.02 % [출처: Covestro AL2447] · 용융 280~320 °C, 표준 300 °C [출처: Covestro] · 금형 80~120 °C [출처: Covestro AL2447] · 형체력 500~1500 t (WIPAC 최대 1500 t [출처], 개별 렌즈 [추정]) · 사이클 60~120 s [추정] · 스크랩 < 2 % (업체 주장 [출처: Haitian]) | 은줄 ← 건조 부족·수분 · 흑점 ← 용융 > 330 °C, 체류시간 · 웰드라인·플로우마크 ← 용융·금형온도↓, 사출속도↓ [추정] · **잔류응력 ← 금형·용융온도↓, 보압↑ → 코팅 크랙** [출처: Covestro] | Covestro, Haitian |
| ③ 하우징 사출 | 300~1000 t 사출기 [추정] | PP-TD 용융 200~240 °C, 금형 30~60 °C, 사이클 40~70 s [추정] · PP는 PC와 극성 차이로 접합이 어렵다 [출처: US7153010] | 휨 ← 냉각 불균일·보압 [추정] · 접합면 불량 → 기밀 불량 | US7153010 |
| ④ 리플렉터·베젤 사출 | BMC 전용(열경화) 사출기 | BMC 금형 약 150 °C, 성형압 35~65 bar [출처: LyondellBasell BMC 304] · 경화 30~40 s (140 °C) [출처: Wah Hong BMC] · 130~200 °C, 0.5~4 min [출처: EP0790115] | 증착 얼룩·표면 거칠기 ← 금형 표면, 이형제, 미경화 [추정] | LyondellBasell, 특허 |
| ⑤ Al 진공증착 | 배치식 증발 증착기 (Bühler AluMet급) | Al 막두께 45~90 nm (최적 약 60 nm) [출처: US6520650] · 공정압 약 0.002 mbar (0.2 Pa) · 펌프다운 38~42 min (전통식) [출처: 특허] · 현대 설비 Al+탑코트 20~25 min/배치 [출처: Bühler] · 예열 60 °C × 2 h [출처: US6520650] | 백화(haze) ← 수분·가스 방출, 배기 부족 · 무지개 ← 막두께 불균일 · 박리 ← 표면 오염, 예열 부족 [추정] | Bühler, 특허 |
| ⑥ HMDSO 탑코트 | 같은 챔버, 플라즈마 중합 | 약 50 nm 실록산층 [출처: 특허] · 내부 배리어 30~40 s 최적, **1 min 초과 시 백화** [출처: US6520650] · RF 2000~2500 W | 김서림(포깅) ← HMDSO 저표면에너지 + 습도 [출처: 특허] | US6520650 |
| ② 렌즈 하드코팅 | 플로우/딥/스프레이 코터, 클린룸, 열경화 오븐 또는 UV | 열경화 실록산: 프라이머 0.3~1.2 µm, 하드코트 4.5~12 µm, **경화 130 °C × 30~60 min** [출처: Momentive AS4000] · UV 조사량 1000~3000 mJ/cm² [추정] · 클린룸 ISO 6~7 [추정] | **크랙·밀착 불량 ← 렌즈 잔류응력 + 용제** [출처: Covestro] · 이물·오렌지필 ← 클린룸 오염 [추정] | Momentive, Covestro |
| ⑦ LED PCB 실장 | SMT(프린터·마운터·리플로우), AOI | SAC 리플로우 피크 235~245 °C, 피크 근처 20~40 s [출처: Cree] · 소크 150~200 °C 약 115 s, TAL 67 s 예시 [출처: Alpha] · MCPCB 보이드↑ → 열저항↑ | 보이드, 쇼트, 틀어짐, LED 열화 ← 피크 초과 | AMS-OSRAM, Cree |
| ⑧ 램프 조립 | 협동로봇·수작업 셀, 나사 체결기, 팰릿 컨베이어 | 클린 + ESD 환경 [출처: WIPAC] · 토크·TIM 수치 근거 없음 | 커넥터 접촉 불량, 액추에이터 틀어짐 [추정] | WIPAC |
| ⑨ 렌즈-하우징 접합 | 핫멜트 도포 로봇, 레이저/진동/열판/IR 융착기 | 진동융착 약 2~10 s [출처: Telsonic 요약] · 곡면 램프는 진동융착이 어렵다 | **수분 침투 ← 핫멜트 접착부 박리·열팽창 보이드** [출처: 한양대 논문] · 융착 시간·압력 부족 → 접합 강도↓ [추정] | koreascience, Branson |
| ⑩ 기밀(리크) 검사 | 압력 감쇠식 리크 테스터 | 서비스 절차: 30 mbar 가압, **30 s 동안 강하 > 10 mbar면 누설** [출처: NHTSA TSB(벤츠)] · 볼보: 40 mbar 가압 후 30 s 뒤 ≥ 20 mbar 유지면 합격 [출처: Volvo TSB] · 양산 라인 값은 [추정] | 실런트 도포 불량, 융착 불량, 벤트 막힘 | NHTSA, Volvo |
| ⑪ 점등·배광·에이밍 | 카메라식 배광 스테이션, 에이머 | 카메라가 빔을 찍어 컷오프 위치·각도·선명도를 측정 [출처: Averna] · 램프 테스터 ≤ 30 s/세트(2개) [출처: Applus+] · 에이밍 정밀도 < ±0.2 cm [출처: FORI] · 스테이션 사이클 20~60 s [추정] | 광축·컷오프 불량 ← 리플렉터·LED 위치 편차, 조립 편차 [추정] | Averna, Applus+ |
| ⑫ EOL·포장 | 점등·통신 기능시험, 라벨 | 근거 없음 | — | — |

## 3. 불량-파라미터 인과 (시뮬레이터 모델링용)

- **근거 있음** (Covestro, 특허, 논문)
  - 렌즈 잔류응력↑ ← 금형·용융온도↓, 보압↑ → **하드코팅 크랙·밀착 불량↑** (공정을 건너뛰는 지연 불량)
  - HMDSO 층 → 습도에서 김서림. 탑코트 1 min 초과 → 백화
  - 핫멜트 접착부 박리 → 수분 침투(기밀 불량)
- **일반론** [추정]
  - 은줄 ← 수분(건조 부족)
  - 흑점 ← 용융 > 330 °C, 체류시간
  - 웰드라인·플로우마크 ← 금형·용융온도↓, 사출속도↓
- 모델 형태: 불량 확률 = `sigmoid(logit(기본값) + Σ 계수 × 정규화 편차)`. 근거 있는 항목은 계수를 크게, 일반론은 작게 두고 등급을 표시한다.

## 4. 규격·인증 (개념)

- **UN R148/R149/R150**: 기존 램프별 규정을 통합한 규정. R148 = 신호등, R149 = 도로 조명(전조등·안개등), R150 = 반사기. 설치 요건은 R48. [출처: globalautoregs, MarkLines]
- **R112 (전조등, 구 규정)**: 약 25 m 거리 스크린의 여러 점에서 측정. 컷오프 수평부는 hh선 아래 25 cm, 엘보는 vv선. 컷오프의 선명도·직선성·에이밍을 본다. 열에 의한 컷오프 수직 이동 시험, 렌즈 내후성·내화학·마모 시험이 목차에 있다. [출처: lexaris, Konica Minolta]
- **배광 시험의 의미**: 스크린 각 점의 광도(cd)·조도(lux)가 최소값 이상이고, 눈부심 영역은 최대값 이하이며, 컷오프가 분명해야 한다. "충분히 비추되 맞은편 운전자는 눈부시지 않게".
- **FMVSS 108**: 미국 판매 필수. 광도, 진동, 먼지, 염수 부식, 습도, 밀봉 시험. [출처: Intertek, TSD 108]
- **국내(KMVSS)**: 「자동차 및 자동차부품의 성능과 기준에 관한 규칙」 제38조(전조등). 2026년 개정으로 주위 조도 1,000 lux 미만이면 변환빔 전조등이 켜지도록 하는 규정 신설. [출처: newsis 2026-06, law.go.kr]

## 5. 사이클타임·설비 대수 감각

- 확인된 값: 증착 사이클 20~25 min [Bühler] · 전통 증발 펌프다운 38~42 min [특허] · 하드코트 열경화 30~60 min [Momentive] · BMC 경화 30~40 s · 램프 테스터 ≤ 30 s/세트.
- [추정] 렌즈 사출 60~120 s, 하우징 40~70 s, 베젤 30~60 s. 조립 택트 60~120 s/대이면 렌즈 사출기 1~2대, 하우징 1대, 리플렉터 1대가 조립 라인 하나를 받친다(사출 90 s ≈ 시간당 40개 ≈ 택트 90 s). 증착기 1대는 배치당 리플렉터 수십 개. EOL은 병렬 2대가 흔하다.

## 6. 업계 사례

- Haitian: PC 렌즈 열경화 실리콘 하드코팅을 클린룸에서 인하우스 수행, 큰 기계에 작은 사출 유닛을 써 체류시간 단축. [newsroom.haitian.com/?p=79772]
- Emerson/Branson: 헤드램프 레이저 융착, 융착 부품 분리·재사용 기술. [Branson 자동차 전조등 조립 자료]
- 현대차그룹: 헤드램프는 배광 시험 등 품질 테스트 후 양산. [hyundaimotorgroup.com 스토리]

## 출처

- https://www.wipac.com/manufacturing
- https://solutions.covestro.com/-/media/covestro/solution-center/brochures/pdf/cov-206_processing-information-for-automotive-lens.pdf (본문 미열람)
- https://solutions.covestro.com/-/media/covestro/solution-center/brochures/pdf/cov-208_minimizing-molded-in-stresses-in-automotive-lenses.pdf (미열람)
- https://solutions.covestro.com/-/media/covestro/solution-center/brochures/pdf/cov-210_common-defects-that-may-occur-during-automotive-lens-molding.pdf (미열람)
- https://solutions.covestro.com/en/products/makrolon/makrolon-al2447_000000000057534978
- https://patents.google.com/patent/US6520650
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6803079
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6000814
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/5916496
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/7153010
- https://patentimages.storage.googleapis.com/ce/ad/f6/3bd98e7c9ea269/EP0790115A2.pdf
- https://www.lyondellbasell.com/globalassets/lyb/our-solutions/products/adv-polymers/engineered-composites/bmc-304-21872-tds-2020-lyb.pdf
- https://sushengpolymer.com/media/pdf/oLMfGE_Wah-Hong-BMC-WH-272F.pdf
- https://www.momentive.com/content/dam/momentive/en-us/products/tds/silfort/TDS SilFORT AS4000.pdf
- https://www.buhlergroup.com/global/en/products/alumet_vacuum_evaporationmetalizer.html
- https://static.nhtsa.gov/odi/tsbs/2024/MC-11007974-0001.pdf
- https://koreascience.kr/article/CFKO200810335359670.pdf
- https://insight.averna.com/en/resources/blog/shining-a-light-on-headlamp-testing
- https://appluslaboratories.com/global/en/what-we-do/service-sheet/production-test-equipment-for-automotive-lamps
- https://look.ams-osram.com/m/14fc71e0158d1831/original/Details-on-lead-free-reflow-soldering-of-LEDs.pdf
- https://lexaris.de/library/tableofcontents/2049432
- https://sensing.konicaminolta.asia/learning-centre/white-papers/photometric-specification-of-automotive-headlamp/download
- https://www.marklines.com/statics/unece/pdf_202004/R148e.pdf
- https://www.intertek.com/automotive/lighting-and-photometric-testing
- https://koreascience.kr/article/JAKO202029062617890.pdf
- https://newsroom.haitian.com/?p=79772
- https://www.hyundaimotorgroup.com/ko/story/CONT0000000000001174
