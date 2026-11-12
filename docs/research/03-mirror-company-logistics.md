# 리서치 03 — 사이드미러 공정 · 에스엘 공개 정보 · 물류 자동화 수치

> 조사일: 2026-11-11
> 사이드미러 세부 수치(폴딩 시간, 모터 전류, 소음, 도장 조건)는 OEM·Tier-1 비공개 사양이라 공개 자료가 거의 없다. **[확인]**과 **[추정]**을 나눠 적었다.

## A. 아웃사이드 미러 제조 공정

| 공정 | 설비 | 파라미터 (정상 범위) | 주요 불량 ← 원인 | 근거 |
|---|---|---|---|---|
| 1. 커버·하우징 사출 (ASA/ABS) | 사출기, 제습 호퍼, 금형 온조기 | ABS 건조 70~80 °C × 2~4 h, 용융 200~280 °C, 금형 25~80 °C (고광택 60~90 °C), 잔류 수분 ≤ 0.1 % [확인, 일반 가이드] | 은줄 ← 건조 부족 · 웰드라인·광택 저하 ← 금형온도↓ | Fictiv, Chase Plastics |
| 1-b. 브래킷·액추에이터 하우징 (PA6-GF30) | 사출기, 제습 건조기 | 건조 80 °C × 4 h → 수분 0.03~0.06 %, 용융 250~290 °C (최적 270), 금형 80~90 °C [확인, BASF] | 휨 ← 금형온도↓(결정화 부족) · 은줄·강도↓ ← 수분 | BASF Ultramid |
| 2. 커버 도장 | 전처리 부스, 정전 스프레이 로봇, 플래시오프, 열풍 건조로 | 베이스/클리어 웨트온웨트 후 일괄 건조 [확인] · 건조 115~135 °C (GMW18630 인용) · 20~30 min [추정] · 막두께 베이스 15~20 µm, 클리어 35~45 µm [추정] | 이물, 오렌지필, 흐름, 핀홀(플래시오프 부족), 부착 불량(전처리), 색차 | pcimag |
| 3. 미러 글래스 (크롬) | 스퍼터/증착기, 세정기, 곡면 벤딩로 | 벤딩 400~500 °C [확인, 특허] · 코팅 두께 비공개 | 핀홀, 얼룩, 반사율 미달 | US8891153 |
| 3-b. 전기변색(ECM) | 셀 접합, 진공 충진, UV 경화 | ITO + 크롬 테두리 띠(3~5 mm), 도전성 에폭시 버스바, UV 경화 밀봉 [확인, 특허] | 충진 기포, 누액, 변색 얼룩 | US10538202 |
| 3-c. 히팅 패드 | 라미네이팅, 접착 프레스 | 스퍼터 히터 면저항 0.2~20 Ω/□ [확인, 특허] · 12 V 수십 W [추정] | 핫스팟, 박리, 저항 편차, 단선 | US7391563 |
| 4. 폴딩 액추에이터 조립 | 반자동 셀, 토크 체결기, 그리스 도포기 | Magna 글래스 액추에이터: 토크 > 0.4 N·m, 수명 40,000~75,000 사이클, **소음 < 47 dB(A) @20 cm** [확인, 제조사] | 기어 소음, 클러치 슬립, 토크 편차, **그리스 부족**, 디텐트 풀림 | Magna |
| 5. 턴시그널·BSD·카메라 | SMT, 광학 정렬, 실링 | 미러 통합 턴시그널 채택 증가 [확인] | 광도 편차, 누수, 카메라 초점 어긋남 | MarkLines |
| 6. 배선·커넥터 | 압착, 커넥터 검사 | 폴딩 모터 드라이버 입력 8~38 V, H브리지 2.8~3.6 A급 [확인, TI] · 기동 피크 약 5 A [약함] | 단선, 접촉 불량, 단락 | TI TIDA-00145 |
| 7. 최종 조립 | 조립 라인, 체결 | 비공개 | 단차, 유격, 토크 불량 | — |
| 8. 최종 검사 | 폴딩 시험기, 소음 부스, 진동 시험 | 아래 표 | 아래 표 | — |

### 검사 항목

| 항목 | 값 | 근거 |
|---|---|---|
| 액추에이터 소음 | < 47 dB(A) @20 cm | [확인, Magna] |
| 내구 | 40,000 / 75,000 회 | [확인, Magna] |
| 폴딩 시간 | 접기·펴기 각 3~6 s | [추정] |
| 폴딩 각도 | 90~100° | [추정] |
| 모터 전류 | 정상 0.3~1 A, 기동 피크 3~5 A | [추정 / 피크는 약함] |
| 미러 진동 | 고속에서 유리 회전 진동으로 상 흐림. 약 20 Hz 이상은 공력 지배 | [확인, SAE 2004-01-1309] |
| 반사율 | UNECE R46, FMVSS 111에 최소값 | 값 미검증 |

### SL미러텍

- 2022-05 에스엘이 지분 51 %(491억 원) 확보, 종속회사 편입. [확인]
- 매출 2022년 3,176억 원, 2024년 약 3,120억 원. 현대차·기아 비중 61.8 %(2022). [확인]
- 경기 시흥 본사·공장 보도 [약함], MarkLines는 생산국 한국·폴란드. 제품: 외장·실내 미러, 카메라 모니터 시스템(CMS).

## B. 에스엘 회사·공장 공개 정보

- 본사 대구 북구 검단공단로 32. 1954년 설립, 1969년부터 현대차에 헤드램프 공급. [확인]
- 2025년 매출 5조 2,399억 원: 램프 4조 1,003억(78.2 %), 전동화 6,376억(12.2 %), 기타(미러·금형·전자) 5,020억(9.6 %). [확인, MarkLines·매일경제]
- 헤드램프 점유율(회사 주장) 2025년 64.3 %.

| 사업부 | 제품 | 생산 국가 |
|---|---|---|
| 램프 | 헤드램프(ADB·프로젝션·MFR), 리어램프, HMSL, 안개등 | 한국, 미국, 인도, 중국, 브라질, 폴란드 |
| 전동화 | E-shift, 시프트 레버, **BMS, SBCM**, SBW 액추에이터, 인버터, 지능형 배터리 센서 | 한국, 미국, 폴란드 |
| 기타 | 미러, 금형, 전자 | 한국, 폴란드 |

### 국내 거점 (알려진 범위)

- **대구 성서 자동화 공장**: LED 램프 완제품을 AGV가 창고로 이송, 이동식 협동로봇 규제자유특구 실증지. [확인, 한국경제 2025-09]
- **대구 성서 전자공장**: 램프 PCB **라우터 공정에 양팔 이동 협동로봇** 투입(2026-04 실증 시작). PCB 4연 어레이 투입, 폐기물 제거, 케이스 적재, 양품/불량 분류, 약 80 cm 안전 영역 표시. [확인, 매일신문 2026-04]
- **경산 진량공장**: 현대차 로봇 모베드 위탁생산 기지(라이다·배터리팩 조립, 최종 조립·검사). [확인, 딜사이트]
- 2019 IR: 대구 성서에 전장품 사업장, 경산에 샤시류 사업장. [약함]

### 스마트팩토리·자동화

- 이동식 협동로봇 규제자유특구(2020 지정). 성서 공장 7대 운영, 대당 개발비 1억 3,000만 원. 제품 인수·이송, 정보 등록, 라벨 부착. 특례로 주행 중 작업. 국내 첫 이동식 협동로봇 KS 표준 제정에 기여. [확인]
- 효과: 물류 작업자 6명 신규 라인 전환, 1인당 시간당 생산량 약 10 % 증가, 연 약 250억 원 효과(회사 주장). [확인]
- 자체 로봇 '쓸모로봇'(뉴로메카 양팔 로봇 + 자체 AMR), 작업 속도 사람의 20~30 %(목표 50 %). [확인]
- 로봇 부품 위탁: 모베드 최종 조립, 보스턴다이내믹스 스팟 다리 어셈블리. [확인]
- MES 도입 기사는 못 찾음.

### 신입 채용

- **2026 하반기 신입 공채(2026-10-19 ~ 11-02)에 "SW개발(스마트제조)", "SW개발(비전/로봇)" 직무 포함.** [확인, 자소설닷컴]
- 공식 직무 설명·우대 기술 원문은 확보 못 함.

## C. 물류 자동화 수치

| 모델 | 적재 | 속도 | 배터리·충전 | 위치 정밀도 |
|---|---|---|---|---|
| MiR250 | 250 kg | 최대 2.0 m/s | 10→90 % 약 52~70 min | 도킹 ±3 mm / ±0.5° |
| Omron LD-250 | 250 kg | 최대 1.2 m/s | 무부하 13 h / 전부하 10 h, 20→80 % 2 h 10 min | ±75 mm, 타깃 ±25 mm |

| 협동로봇 | 가반 | 도달 | 반복 정밀도 | TCP 속도 |
|---|---|---|---|---|
| UR10e | 12.5 kg | 1,300 mm | ±0.05 mm | 1 m/s |
| 두산 M1013 | 10 kg | 1,300 mm | ±0.05 mm | 1 m/s |
| 뉴로메카 Indy12 | 12 kg | 1,200 mm | ±0.05 mm | — |

- ISO/TS 15066: 협동 운전 4방식(안전 정지 감시, 핸드 가이딩, 속도·거리 감시, 힘·출력 제한). [확인]
- **시뮬레이터 기본값** [추정]: AMR 주행 1.0 m/s, 적재 250 kg, 배터리 10 h, 충전 1.5 h, 도킹 ±10 mm.

## 출처

- https://www.marklines.com/en/top500/sl
- https://dealsite.co.kr/articles/164147
- https://dealsite.co.kr/articles/158076
- https://www.hankyung.com/article/2025092173151
- https://v.daum.net/v/20260624180618064
- https://www.imaeil.com/page/view/2026042414061156542
- https://jasoseol.com/recruit/106764
- https://jasoseol.com/recruit/100241
- https://file.alphasquare.co.kr/media/pdfs/company-ir/20190926에스엘-에스엘-주요-경영현황-설명국내.pdf
- https://magna-eu.magna.com/products/exterior-interior/mirrors/actuators
- https://www.ti.com/tool/TIDA-00145
- https://saemobilus.sae.org/content/2004-01-1309
- https://www.nhtsa.gov/document/laboratory-test-procedure-fmvss-111v-00-rearview-mirrors-other-school-buses
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10538202
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8891153
- https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/7391563
- https://www.fictiv.com/articles/abs-injection-molding-material-properties-and-processing-considerations
- https://chaseplastics.com/wp-content/uploads/2019/05/Common-Processing-Guide.pdf
- https://download.basf.com/p1/8a8081c57fd4b609017fd6610ac13999/en/ULTRAMID%25C2%25AE_B3U30G6
- https://www.pcimag.com/articles/83238-high-solids-radiation-curable-basecoat-and-clearcoat-for-flexible-plastic-automotive-components
- https://mobile-industrial-robots.com/it/prodotti/robot/mir250/specifiche
- https://www.ia.omron.com/products/family/3950/specification.html
- https://www.universal-robots.com/manuals/latest/en/datasheets/ur10e/
- https://manual.doosanrobotics.com/en/user/2.9/1.-M-H-Series/m1013
- https://www.automate.org/tech-papers/iso-ts-15066-explained
