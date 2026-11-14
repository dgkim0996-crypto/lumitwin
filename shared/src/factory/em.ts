import type { LineDef } from '../types';
import { attr, ct, cy, defect, fix, health, meas, power } from './build';

/**
 * B베이 — 전장 모듈 라인 (SMT)
 * 근거: docs/research/02-electronics-smt-process.md · P9 전력·상태 감시·불량 처리 기준·LED 레인 맞춤: docs/research/04-energy-health-ncr.md
 * LED 레인은 헤드램프용 LED 광원 모듈을 만들어 AMR로 A베이에 보내고, BMS 레인은 12V 보조배터리 BMS 완제품을 만든다.
 * LED 레인 끝의 PCB 라우터는 공개 사례(램프 PCB 라우터 공정의 양팔 이동 협동로봇, 4연 어레이 투입)를 반영했다.
 *
 * LED 레인 수요 맞춤 (P9): 헤드램프 1개에 LED 모듈 2개, 택트 75초 → 모듈 1개/37.5초 → 4연 패널 1장/150초.
 * 병목은 라우터 셀(패널 1장 100초 = 모듈당 25초, 협동로봇 작업 속도가 사람의 20~30 %)로 소요의 약 67 %를 쓴다.
 * 인쇄~AOI의 SMT 설비는 패널당 20~30초라 능력이 소요보다 훨씬 커서, 버퍼(간판)가 차면 막힘(BLOCKED)으로 기다린다.
 * 실제 공장이라면 이 SMT 레인을 다른 램프 모듈(DRL·턴 시그널)과 나눠 쓴다 (가정).
 */

/** BMS FCT 측정. #1·#2는 같은 시험기라 한 곳에서 만든다 (같은 불량 코드는 처리 기준도 하나여야 한다) */
function fctBmsMeasures() {
  return [
    meas('cell_v_err', '셀 전압 측정 오차', 'mV', 1.2, 0.4, [['attr:joint_q', -0.7]], 'FUNC', 'assumed', {
      usl: 5, digits: 2, ...fix('REPAIR', 15, 0.8),
      note: 'AFE ±1.5 mV(TI BQ79616-Q1) → 판정 ±5 mV 가정. 처리: AFE·션트 주변 납땜을 확인·재납땜하고 재시험 (가정)',
    }),
    meas('sleep_ua', '암전류', 'µA', 85, 5, [], 'CURRENT', 'assumed', {
      usl: 120, digits: 1, ...fix('REPAIR', 20, 0.7), note: '처리: 누설 경로(부품·잔류 플럭스)를 찾아 교체·세척하고 재시험 (가정)',
    }),
    meas('bal_dt', '밸런싱 FET 온도 상승', 'K', 18, 1.2, [['attr:bms_void', 0.8]], 'THERMAL', 'weak', {
      usl: 26, digits: 1, ...fix('REPAIR', 15, 0.8),
      note: '밸런싱 전류를 흘리고 FET 온도 상승을 잰다. 방열 패드 보이드↑ → 열저항↑ → 온도↑. 보이드 영향은 25 %를 넘어야 뚜렷하다는 보고(ISOM 2013)가 있어 계수를 작게: 평소 불합격은 거의 없고 추세로만 보인다 (값·계수 가정). 처리: FET 재납땜 뒤 재시험',
    }),
  ];
}

export const EM: LineDef = {
  code: 'EM',
  name: '전장 모듈 라인 (LED·BMS)',
  short: '전장',
  color: '#4fb3ff',
  desc: 'LED 레인은 헤드램프 LED 모듈을(인쇄 → SPI → 마운터 → 리플로우 → AOI → 라우팅 4분할 → 모듈 시험), BMS 레인은 12V 보조배터리 BMS를 만든다(인쇄 → SPI → 마운터 → 리플로우 → AOI → ICT → 코팅 → FCT → EOL).',
  product: { code: 'BMS-12V', name: '12V 보조배터리 BMS' },
  variants: [
    { code: 'BMS-12V-S', name: '표준형', desc: '12V 보조배터리 BMS 표준 사양', grade: 'assumed' },
    { code: 'BMS-12V-H', name: '고용량형', desc: '셀 밸런싱 시험 항목이 많아 FCT·EOL 시간이 길다', cycle: { 'EM-FCT-B1': 1.15, 'EM-FCT-B2': 1.15, 'EM-EOL-B': 1.1 }, grade: 'assumed' },
  ],
  release: 'BMS_MARK',
  // LED 레인은 기종과 무관하게 헤드램프 라인 소요만큼 채우는 간판 보충으로 본다
  changeover: [
    { station: 'EM-LM-B', minutes: 0.5, what: 'DMC 마킹 내용 변경', grade: 'assumed' },
    { station: 'EM-FCT-B1', minutes: 2, what: 'FCT 시험 프로그램 변경', grade: 'assumed' },
    { station: 'EM-FCT-B2', minutes: 2, what: 'FCT 시험 프로그램 변경', grade: 'assumed' },
    { station: 'EM-EOL-B', minutes: 1, what: 'EOL 시험 프로그램 변경', grade: 'assumed' },
    { station: 'EM-PK-B', minutes: 1, what: '라벨 양식 변경', grade: 'assumed' },
  ],
  taktSec: 45,
  bay: { x0: -58, x1: 58, z0: -8, z1: 10 },
  finalStep: 'BMS_PACK',
  steps: [
    // LED 레인: 기판(LED_PCB)은 4연 어레이 패널 1장, 라우팅부터는 낱개 모듈(LED_MOD)이다
    { code: 'LED_PRINT', name: 'LED 솔더 인쇄', inputs: [{ material: 'MCPCB', qty: 1 }, { material: 'PASTE', qty: 1 }], buffer: 4, item: 'LED_PCB', itemName: 'LED 기판 (4연 패널)', serial: 'new', prefix: 'LM' },
    { code: 'LED_SPI', name: 'LED SPI', inputs: [{ step: 'LED_PRINT', qty: 1 }], buffer: 4, item: 'LED_PCB', itemName: 'LED 기판 (4연 패널)', serial: 'keep' },
    // LED 패키지: 모듈 1개에 2칩(직렬) × 4연 = 패널당 8개 (가정)
    { code: 'LED_MOUNT', name: 'LED 마운트', inputs: [{ step: 'LED_SPI', qty: 1 }, { material: 'LED_PKG', qty: 8 }], buffer: 4, item: 'LED_PCB', itemName: 'LED 기판 (4연 패널)', serial: 'keep' },
    { code: 'LED_REFLOW', name: 'LED 리플로우', inputs: [{ step: 'LED_MOUNT', qty: 1 }], buffer: 6, item: 'LED_PCB', itemName: 'LED 기판 (4연 패널)', serial: 'keep' },
    { code: 'LED_AOI', name: 'LED AOI', inputs: [{ step: 'LED_REFLOW', qty: 1 }], buffer: 6, item: 'LED_PCB', itemName: 'LED 기판 (4연 패널)', serial: 'keep' },
    // 패널 1장 → 모듈 4개 (시리얼 LM…-1 ~ -4). 버퍼는 모듈 개수로 센다: 모듈 시험 앞 패널 2장분
    { code: 'LED_ROUTE', name: 'PCB 라우팅·분리', inputs: [{ step: 'LED_AOI', qty: 1 }], buffer: 8, item: 'LED_MOD', itemName: 'LED 광원 모듈', serial: 'keep', split: 4 },
    // 시험을 마친 모듈만 AMR(T-LED, 20개 = 패널 5장 = 램프 10대분)로 헤드램프 조립에 간다. 버퍼 80 = AMR 4번분
    { code: 'LED_TEST', name: 'LED 모듈 시험', inputs: [{ step: 'LED_ROUTE', qty: 1 }], buffer: 80, item: 'LED_MOD', itemName: 'LED 광원 모듈', serial: 'keep' },

    { code: 'BMS_MARK', name: 'DMC 레이저 마킹', inputs: [{ material: 'PCB_BMS', qty: 1 }], buffer: 4, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'new', prefix: 'BM' },
    { code: 'BMS_PRINT', name: '솔더 인쇄', inputs: [{ step: 'BMS_MARK', qty: 1 }, { material: 'PASTE', qty: 1 }], buffer: 3, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_SPI', name: 'SPI', inputs: [{ step: 'BMS_PRINT', qty: 1 }], buffer: 3, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_MOUNT1', name: '칩 마운트', inputs: [{ step: 'BMS_SPI', qty: 1 }], buffer: 3, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_MOUNT2', name: 'IC 마운트', inputs: [{ step: 'BMS_MOUNT1', qty: 1 }, { material: 'AFE_IC', qty: 1 }], buffer: 3, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_REFLOW', name: '리플로우', inputs: [{ step: 'BMS_MOUNT2', qty: 1 }], buffer: 4, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_AOI', name: 'AOI', inputs: [{ step: 'BMS_REFLOW', qty: 1 }], buffer: 4, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_ICT', name: 'ICT', inputs: [{ step: 'BMS_AOI', qty: 1 }], buffer: 4, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_COAT', name: '컨포멀 코팅', inputs: [{ step: 'BMS_ICT', qty: 1 }, { material: 'COATING', qty: 1 }], buffer: 6, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_FCT', name: 'FCT 기능 시험', inputs: [{ step: 'BMS_COAT', qty: 1 }], buffer: 6, item: 'BMS_PCB', itemName: 'BMS 기판', serial: 'keep' },
    { code: 'BMS_HOUSING', name: '하우징 체결', inputs: [{ step: 'BMS_FCT', qty: 1 }, { material: 'BMS_CASE', qty: 1 }], buffer: 4, item: 'BMS', itemName: '12V BMS', serial: 'keep' },
    { code: 'BMS_EOL', name: 'EOL 시험', inputs: [{ step: 'BMS_HOUSING', qty: 1 }], buffer: 4, item: 'BMS', itemName: '12V BMS', serial: 'keep' },
    { code: 'BMS_PACK', name: '포장', inputs: [{ step: 'BMS_EOL', qty: 1 }], buffer: 48, item: 'BMS_PK', itemName: '포장 BMS', serial: 'keep' },
  ],
  stations: [
    // ── LED 레인 (z = -4) ──
    {
      code: 'EM-PR-L', name: 'LED 솔더 인쇄기', kind: 'printer', step: 'LED_PRINT', pos: [-49, -4], cycle: 28, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: 'MCPCB 4연 어레이(모듈 4개가 붙은 패널)에 스텐실로 SAC305 솔더 페이스트를 인쇄한다.',
      power: power(1.5, 0.9, 0.3, 'assumed', '인쇄 헤드 서보·스텐실 하부 세척 진공·비전·컨베이어'),
      tags: [
        ct('squeegee_speed', '스퀴지 속도', 'mm/s', 40, 0.4, 'weak', { lsl: 20, usl: 80, tau: 60, digits: 1, note: '20~80 mm/s (미세 피치 20~40)' }),
        ct('print_pressure', '인쇄 압력', 'N/mm', 0.4, 0.008, 'weak', { lsl: 0.3, usl: 0.5, tau: 60, digits: 3 }),
      ],
      attrs: [attr('paste_vol', '페이스트 체적', '%', 100, 4, [['tag:print_pressure', 1.5], ['tag:squeegee_speed', -1.2]], 'weak', { digits: 1 })],
    },
    {
      code: 'EM-SPI-L', name: 'LED 3D SPI', kind: 'spi', step: 'LED_SPI', pos: [-46.5, -4], cycle: 20, cycleCv: 0.01, mtbf: 2880, mttr: 10, grade: 'weak',
      desc: 'MCPCB에 인쇄된 페이스트의 높이·체적을 3D로 잰다. LED 방열 패드는 면적이 넓어 페이스트가 모자라면 들뜸·보이드가 생기므로 올리기 전에 거른다. 체적 70~130 %를 벗어나면 불량.',
      note: 'P9에서 추가: 인쇄 직후 검사가 없던 공백을 메운다. 사이클은 SPI 일반 범위(10~20초/장)의 위쪽 (2차 자료)',
      power: power(0.9, 0.7, 0.2, 'assumed', '3D 측정 헤드(모아레·레이저)·조명·XY 스테이지·PC'),
      tags: [ct('cal_offset', '높이 보정값', 'µm', 0, 0.5, 'assumed', { tau: 600, digits: 2 })],
      measures: [
        meas('paste_volume', '페이스트 체적', '%', 100, 1.0, [['attr:paste_vol', 4]], 'PASTE', 'weak', {
          lsl: 70, usl: 130, digits: 1, ...fix('REWORK', 6, 0.95),
          note: '가장 흔한 판정 기준 70~130 %. 제품 경로 밖이라 실제로는 폐기되지만 처리 기준은 BMS SPI(EM-SPI-B)와 같게 둔다 (같은 코드)',
        }),
      ],
    },
    {
      code: 'EM-MT-L', name: 'LED 마운터', kind: 'mounter', step: 'LED_MOUNT', pos: [-43, -4], cycle: 30, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: 'LED 패키지를 장착한다 (4연 패널 1장에 모듈 4개분). 장착 정밀도 ±35 µm(3σ)급. 노즐이 닳으면 장착 편차가 커져 헤드램프 광축이 틀어진다.',
      power: power(1.8, 1, 0.3, 'weak', 'YSM20R급 모듈 마운터 소비 전력 약 1.8 kW (판매처 표기, 2차 자료). 대기·정지는 가정'),
      health: health(0.68, 3.2, 38, 150, '헤드 Z축·노즐 샤프트 베어링', 'I', 'assumed', 'LED는 고정밀 모드라 헤드 왕복이 칩 마운터보다 적다. 실제 정비 주기 약 1.5만 시간(가정)을 1/100로'),
      tags: [
        ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 }),
        cy('feeder_err', '피더 경고', '회', 0, 0, 'assumed', { digits: 0 }),
      ],
      attrs: [attr('led_offset', 'LED 장착 편차', 'µm', 12, 4, [['tag:nozzle_vacuum', 1.5]], 'confirmed', { digits: 1, note: 'Yamaha YSM20R: ±0.035 mm (3σ)' })],
      defects: [
        defect('MISSING', '부품 누락', 0.001, [['tag:nozzle_vacuum', 1, 1.0]], 'assumed', {
          latent: true, ...fix('REPAIR', 8, 0.9), note: '처리: 빠진 부품을 손으로 붙이고 재납땜한 뒤 재검사 (가정). BMS 칩 마운터와 같은 코드·기준',
        }),
      ],
    },
    {
      code: 'EM-RF-L', name: 'LED 리플로우 오븐', kind: 'reflow', step: 'LED_REFLOW', pos: [-35, -4], cycle: 300, cycleCv: 0.005, slots: 10, mtbf: 1440, mttr: 30, grade: 'confirmed',
      desc: 'MCPCB용 리플로우. 피크 235~245 °C, 피크 근처 20~40초 (LED 제조사 권장).',
      power: power(12, 10, 5, 'weak', '대류 리플로우 가동 약 7~16 kW (Heller MK5·1809 계열 공개 값). MCPCB는 열용량이 커 위쪽으로 잡았다. 멈추면 대기 모드로 히터를 낮춘다 (가정)'),
      health: health(0.66, 1.4, 58, 300, '대류 송풍기 모터 베어링', 'I', 'assumed', '존마다 송풍기(수백 W)가 열풍을 돌린다. 오븐 열 때문에 베어링 온도가 높다. 실제 수명 약 3만 시간(가정)을 1/100로'),
      tags: [
        ct('peak_temp', '피크 온도', '°C', 240, 1.0, 'confirmed', { lsl: 235, usl: 250, tau: 180, digits: 1, note: 'Cree: SAC 피크 235~245 °C' }),
        ct('tal', 'TAL(액상선 이상 시간)', 's', 62, 2.0, 'weak', { lsl: 40, usl: 80, tau: 180, digits: 1 }),
        ct('o2_ppm', '질소 O₂ 농도', 'ppm', 900, 60, 'weak', { usl: 1500, tau: 120, digits: 0 }),
      ],
      attrs: [
        attr('void_pct', '솔더 보이드율', '%', 8, 1.5, [['tag:peak_temp', -0.6], ['tag:tal', -0.5]], 'weak', {
          digits: 1, note: 'MCPCB 보이드↑ → 열저항↑. 뒤 LED 모듈 시험(EM-FCT-L)의 열저항·순방향 전압에 이어진다',
        }),
      ],
      defects: [
        defect('COLD', '냉납', 0.0015, [['tag:peak_temp', -1, 1.0], ['tag:tal', -1, 0.8]], 'weak', {
          latent: true, ...fix('REPAIR', 15, 0.85),
          note: '처리: 재납땜(BMS) 또는 LED 모듈 교체(헤드램프, 렌즈 개봉). BMS 냉납(EM-RF-B)과 같은 코드라 처리 기준 하나로 중간값 (가정)',
        }),
      ],
    },
    {
      code: 'EM-AOI-L', name: 'LED AOI', kind: 'aoi', step: 'LED_AOI', pos: [-29, -4], cycle: 25, cycleCv: 0.01, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '부품 유무·극성·위치·납땜 외관을 카메라로 판정한다. 냉납은 외관으로 일부만 보인다.',
      power: power(0.8, 0.6, 0.2, 'assumed', '카메라·조명·XY 스테이지·PC'),
      tags: [ct('light_level', '조명 밝기', '%', 100, 0.5, 'assumed', { tau: 60, digits: 1 })],
      detects: [{ defect: 'MISSING', prob: 0.99 }, { defect: 'COLD', prob: 0.45 }],
    },
    {
      code: 'EM-RT-L', name: 'PCB 라우터 + 양팔 이동 협동로봇', kind: 'router-cobot', step: 'LED_ROUTE', pos: [-22.5, -4], cycle: 100, cycleCv: 0.05, mtbf: 900, mttr: 15, grade: 'confirmed',
      desc: 'LED 기판 4연 어레이 1장을 라우터로 잘라 모듈 4개로 나눈다(연배 분할, 시리얼 뒤에 -1~-4). 양팔 이동 협동로봇이 투입·분리·적재·양품/불량 분류를 맡는다 (공개 사례 반영).',
      note: '사이클 100초/패널 = 모듈당 25초 (가정). 협동로봇 작업 속도가 사람의 20~30 %(회사 공개 자료)라 투입·분리·적재·분류가 라우팅 자체보다 오래 걸린다. 헤드램프 소요(모듈당 37.5초)의 약 67 %',
      power: power(3.6, 2.4, 0.5, 'weak', '라우터 스핀들 약 1 kW + 집진기 약 2 kW + 양팔 협동로봇 약 0.5 kW(UR10e급 350 W 참고) + 비전·PC (가정). 집진기는 대기 중에도 돈다'),
      health: health(0.68, 3.8, 42, 60, '라우터 스핀들 베어링 (40,000 rpm)', 'I', 'weak', '그리스 윤활 고속 스핀들 베어링 정격 약 6,000~7,000시간(가공기 정비 자료, 2차)을 1/100로. 공장에서 가장 빨리 닳는 회전부라 예지 보전 효과가 잘 보인다'),
      tags: [
        ct('spindle_rpm', '스핀들 회전수', 'rpm', 40000, 250, 'assumed', { lsl: 35000, tau: 60, digits: 0 }),
        ct('dust_dp', '집진 차압', 'kPa', 1.2, 0.05, 'assumed', { usl: 2.0, tau: 120, digits: 2 }),
      ],
      defects: [defect('EDGE', '가장자리 균열', 0.001, [['tag:spindle_rpm', -1, 0.6]], 'assumed')],
    },
    {
      code: 'EM-FCT-L', name: 'LED 모듈 시험기 (광·전기·열)', kind: 'fct', step: 'LED_TEST', pos: [-17.5, -4], cycle: 24, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'weak',
      desc: '잘라 낸 LED 모듈을 하나씩 25 °C 지그에 물려 정격 전류를 흘리고 순방향 전압, 광속·색좌표(적분구·분광기), 열저항(순방향 전압 변화법)을 잰다. 냉납·누락은 전기로 잡는다. 합격 모듈만 헤드램프 라인으로 간다.',
      note: 'P9에서 추가. 모듈당 24초 = 소요(37.5초)의 약 64 % (가정). 열저항은 JESD51 계열의 순방향 전압 변화법(2차 자료)',
      power: power(1, 0.7, 0.2, 'assumed', 'LED 구동 전원·분광기·적분구·지그 온도 조절(TEC)·PC'),
      tags: [
        ct('test_current', '시험 전류', 'mA', 1000, 1.5, 'assumed', { lsl: 990, usl: 1010, tau: 60, digits: 1 }),
        ct('stage_temp', '지그 온도', '°C', 25, 0.3, 'assumed', { lsl: 23, usl: 27, tau: 300, digits: 1, note: 'LED 광특성은 온도에 따라 변해 기준 온도 지그에서 잰다' }),
      ],
      measures: [
        meas('vf', '순방향 전압 (1 A, 2칩 직렬)', 'V', 6.2, 0.05, [['attr:void_pct', -0.01]], 'VF', 'assumed', {
          lsl: 5.6, usl: 6.8, digits: 3,
          note: '백색 LED 칩당 약 3 V (일반 사양 범위, 가정). 보이드↑ → 접합 온도↑ → 순방향 전압↓ (약 -2 mV/K/칩, 계수는 작게 가정)',
        }),
        meas('flux', '광속', 'lm', 560, 6, [['attr:void_pct', -2]], 'FLUX', 'assumed', { lsl: 520, digits: 0, note: '보이드↑ → 접합 온도↑ → 광속 조금↓ (계수 가정)' }),
        meas('cie_x', '색좌표 x', '', 0.33, 0.002, [], 'COLOR', 'assumed', { lsl: 0.32, usl: 0.34, digits: 4, note: '백색 빈(bin) 중심 ±0.01 가정' }),
        meas('rth', '열저항 (순방향 전압 변화법)', 'K/W', 4.5, 0.15, [['attr:void_pct', 0.12]], 'RTH', 'weak', {
          usl: 5.5, digits: 2,
          note: '보이드가 열 경로를 막아 열저항이 오른다. 다만 보이드 25 % 미만에서는 영향이 작다는 보고(ISOM 2013)가 있어 계수를 작게 두었다: 평소 불합격은 거의 없고, 리플로우 피크·TAL이 크게 떨어질 때만 조금 는다 (계수 가정)',
        }),
      ],
      detects: [{ defect: 'COLD', prob: 0.8 }, { defect: 'MISSING', prob: 0.99 }],
    },

    // ── BMS 레인 (z = 4) ──
    {
      code: 'EM-LM-B', name: 'DMC 레이저 마커', kind: 'laser-marker', step: 'BMS_MARK', gate: true, pos: [-51, 4], cycle: 18, cycleCv: 0.01, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: 'PCB에 2D 데이터매트릭스 코드를 새겨 시리얼을 붙인다. 이후 모든 공정 이력이 이 코드로 이어진다.',
      power: power(0.9, 0.5, 0.15, 'assumed', '20 W 파이버 레이저·제어기·흄 집진기'),
      tags: [ct('laser_power', '레이저 출력', 'W', 20, 0.15, 'assumed', { tau: 60, digits: 2 })],
      defects: [
        defect('UNREAD', '코드 판독 불가', 0.0005, [['tag:laser_power', -1, 0.8]], 'assumed', {
          ...fix('SCRAP'), note: '처리: 폐기. 아직 부품이 없는 맨 기판이라 값이 싸고, 다시 새기면 추적 코드가 둘이 된다 (가정)',
        }),
      ],
    },
    {
      code: 'EM-PR-B', name: '솔더 인쇄기', kind: 'printer', step: 'BMS_PRINT', pos: [-47, 4], cycle: 30, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: '스텐실로 솔더 페이스트를 인쇄한다. 개구부가 막히면 페이스트가 덜 나와 미납·냉납으로 이어진다.',
      power: power(1.5, 0.9, 0.3, 'assumed', '인쇄 헤드 서보·스텐실 하부 세척 진공·비전·컨베이어'),
      tags: [
        ct('squeegee_speed', '스퀴지 속도', 'mm/s', 40, 0.4, 'weak', { lsl: 20, usl: 80, tau: 60, digits: 1 }),
        ct('print_pressure', '인쇄 압력', 'N/mm', 0.4, 0.008, 'weak', { lsl: 0.3, usl: 0.5, tau: 60, digits: 3 }),
        ct('snap_off', '판 분리 속도', 'mm/s', 2.0, 0.05, 'weak', { lsl: 1, usl: 3, tau: 60, digits: 2 }),
      ],
      attrs: [attr('paste_vol', '페이스트 체적', '%', 100, 4, [['tag:print_pressure', 1.5], ['tag:squeegee_speed', -1.2]], 'weak', { digits: 1 })],
      defects: [
        defect('BRIDGE', '솔더 브리지', 0.0015, [['tag:print_pressure', 1, 0.9], ['attr:paste_vol', 1, 0.8]], 'weak', {
          latent: true, ...fix('REPAIR', 8, 0.95), note: 'SPI·AOI·ICT에서 걸린다. 처리: 인두·솔더윅으로 브리지를 떼고 재검사 (가정)',
        }),
      ],
    },
    {
      code: 'EM-SPI-B', name: '3D SPI', kind: 'spi', step: 'BMS_SPI', pos: [-43.5, 4], cycle: 25, cycleCv: 0.01, mtbf: 2880, mttr: 10, grade: 'weak',
      desc: '인쇄된 페이스트의 높이·체적을 3D로 잰다. 체적 70~130 %를 벗어나면 불량.',
      power: power(0.9, 0.7, 0.2, 'assumed', '3D 측정 헤드(모아레·레이저)·조명·XY 스테이지·PC'),
      tags: [ct('cal_offset', '높이 보정값', 'µm', 0, 0.5, 'assumed', { tau: 600, digits: 2 })],
      measures: [
        meas('paste_volume', '페이스트 체적', '%', 100, 1.0, [['attr:paste_vol', 4]], 'PASTE', 'weak', {
          lsl: 70, usl: 130, digits: 1, ...fix('REWORK', 6, 0.95),
          note: '가장 흔한 판정 기준 70~130 %. 처리: 부품을 올리기 전이라 페이스트를 닦아 내고 다시 인쇄한 뒤 재검사 (인쇄 불량 기판 세척·재인쇄, 시간·성공률 가정)',
        }),
      ],
      detects: [{ defect: 'BRIDGE', prob: 0.3 }],
    },
    {
      code: 'EM-MT-B1', name: '칩 마운터', kind: 'mounter', step: 'BMS_MOUNT1', pos: [-40, 4], cycle: 36, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: '저항·커패시터 같은 칩 부품을 고속 장착한다 (보드당 약 250점 가정).',
      power: power(1.8, 1, 0.3, 'weak', 'YSM20R급 모듈 마운터 소비 전력 약 1.8 kW (판매처 표기, 2차 자료). 대기·정지는 가정'),
      health: health(0.69, 3.6, 39, 100, '헤드 구동 베어링·볼스크루 (고속 칩 헤드)', 'I', 'assumed', 'XY·Z축 왕복이 공장에서 가장 잦은 고속 헤드라 빨리 닳는다. 실제 헤드 정비 주기 약 1만 시간(가정)을 1/100로. 시나리오 EM-MT-BEARING'),
      tags: [ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 })],
      defects: [
        defect('MISSING', '부품 누락', 0.0008, [['tag:nozzle_vacuum', 1, 1.0]], 'assumed', {
          latent: true, ...fix('REPAIR', 8, 0.9), note: '처리: 빠진 칩을 손으로 붙이고 재납땜한 뒤 재검사 (가정)',
        }),
        defect('SHIFT', '부품 틀어짐', 0.001, [['tag:nozzle_vacuum', 1, 0.7]], 'assumed', {
          latent: true, ...fix('REPAIR', 8, 0.9), note: '처리: 인두로 녹여 바로잡고 재검사 (가정). IC 마운터와 같은 기준',
        }),
      ],
    },
    {
      code: 'EM-MT-B2', name: 'IC 마운터', kind: 'mounter', step: 'BMS_MOUNT2', pos: [-36.5, 4], cycle: 38, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: 'MCU·셀 모니터링 AFE·CAN 트랜시버 같은 IC를 장착한다.',
      power: power(1.8, 1, 0.3, 'weak', 'YSM20R급 모듈 마운터 소비 전력 약 1.8 kW (판매처 표기, 2차 자료). 대기·정지는 가정'),
      health: health(0.67, 3, 38, 160, '헤드 Z·θ축 베어링', 'I', 'assumed', 'IC는 점수가 적어 헤드 왕복이 적다. 실제 정비 주기 약 1.6만 시간(가정)을 1/100로'),
      tags: [ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 })],
      defects: [
        defect('SHIFT', '부품 틀어짐', 0.0008, [['tag:nozzle_vacuum', 1, 0.7]], 'assumed', {
          latent: true, ...fix('REPAIR', 8, 0.9), note: '처리: 인두로 녹여 바로잡고 재검사 (가정). 칩 마운터와 같은 기준',
        }),
      ],
    },
    {
      code: 'EM-RF-B', name: '질소 리플로우 오븐', kind: 'reflow', step: 'BMS_REFLOW', pos: [-29, 4], cycle: 320, cycleCv: 0.005, slots: 8, mtbf: 1440, mttr: 30, grade: 'weak',
      desc: 'SAC305 프로파일: 소크 150→180 °C 약 120초, 피크 245 °C, TAL 40~80초. 피크·TAL이 낮으면 냉납이 생기는데 외관(AOI)으로는 절반 정도만 보인다.',
      power: power(11, 9, 4.5, 'weak', '대류 리플로우 가동 약 7~16 kW (Heller MK5·1809 계열 공개 값). 멈추면 대기 모드로 히터를 낮춘다 (가정)'),
      health: health(0.66, 1.3, 57, 300, '대류 송풍기 모터 베어링', 'I', 'assumed', '존마다 송풍기(수백 W)가 열풍을 돌린다. 실제 수명 약 3만 시간(가정)을 1/100로'),
      tags: [
        ct('soak_temp', '소크 온도', '°C', 175, 1.0, 'weak', { lsl: 150, usl: 190, tau: 180, digits: 1 }),
        ct('peak_temp', '피크 온도', '°C', 245, 1.0, 'weak', { lsl: 240, usl: 255, tau: 180, digits: 1, note: 'SAC305 피크 245~255 °C' }),
        ct('tal', 'TAL(액상선 이상 시간)', 's', 60, 2.0, 'weak', { lsl: 40, usl: 80, tau: 180, digits: 1 }),
        ct('o2_ppm', '질소 O₂ 농도', 'ppm', 800, 50, 'weak', { usl: 1000, tau: 120, digits: 0 }),
      ],
      attrs: [
        attr('joint_q', '솔더 접합 품질', '점', 100, 1.5, [['tag:peak_temp', 0.35], ['tag:tal', 0.25]], 'weak', { digits: 1 }),
        attr('bms_void', '방열 패드 보이드율', '%', 12, 2.5, [['tag:soak_temp', -0.8], ['tag:tal', -0.4]], 'weak', {
          digits: 1,
          note: '밸런싱 FET·션트처럼 넓은 방열 패드 밑 납 속 기포. 예열·소크가 모자라면 플럭스 가스가 덜 빠져 보이드↑, TAL이 길면 가스가 빠질 시간이 생겨 보이드↓ (2차 자료, 계수 가정). 뒤 FCT 밸런싱 발열(bal_dt)에 이어진다',
        }),
      ],
      defects: [
        defect('COLD', '냉납', 0.0015, [['tag:peak_temp', -1, 0.5], ['tag:tal', -1, 0.35]], 'weak', {
          latent: true, ...fix('REPAIR', 15, 0.85), note: 'ICT·FCT·EOL에서 걸린다. 처리: 재납땜 뒤 재검사. LED 냉납(EM-RF-L)과 같은 코드·기준 (가정)',
        }),
        defect('TOMB', '툼스톤', 0.0008, [['tag:o2_ppm', -1, 0.3]], 'weak', {
          latent: true, ...fix('REPAIR', 8, 0.95), note: '처리: 들린 칩을 인두로 눕혀 다시 납땜하고 재검사 (가정)',
        }),
      ],
    },
    {
      code: 'EM-AOI-B', name: 'AOI', kind: 'aoi', step: 'BMS_AOI', gate: true, pos: [-22, 4], cycle: 30, cycleCv: 0.01, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '부품 누락·틀어짐·브리지·툼스톤을 외관으로 찾는다. 냉납 검출률은 약 35 %로 가정.',
      power: power(0.8, 0.6, 0.2, 'assumed', '카메라·조명·XY 스테이지·PC'),
      tags: [ct('light_level', '조명 밝기', '%', 100, 0.5, 'assumed', { tau: 60, digits: 1 })],
      detects: [{ defect: 'MISSING', prob: 0.99 }, { defect: 'SHIFT', prob: 0.95 }, { defect: 'BRIDGE', prob: 0.9 }, { defect: 'TOMB', prob: 0.95 }, { defect: 'COLD', prob: 0.35 }],
    },
    {
      code: 'EM-ICT-B', name: 'ICT 인서킷 테스터', kind: 'ict', step: 'BMS_ICT', gate: true, pos: [-17.5, 4], cycle: 42, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '핀으로 회로를 짚어 단락·개방·부품값을 확인한다.',
      power: power(1.5, 1, 0.3, 'assumed', '측정 시스템·진공 지그 펌프·PC'),
      tags: [ct('fixture_count', '지그 접촉 횟수', '천회', 12, 0.01, 'assumed', { tau: 3600, digits: 1 })],
      detects: [{ defect: 'BRIDGE', prob: 0.99 }, { defect: 'MISSING', prob: 0.99 }, { defect: 'COLD', prob: 0.6 }, { defect: 'SHIFT', prob: 0.7 }],
    },
    {
      code: 'EM-CC-B', name: '선택 컨포멀 코팅기 + UV 검사', kind: 'coater', step: 'BMS_COAT', pos: [-11, 4], cycle: 40, cycleCv: 0.02, mtbf: 900, mttr: 20, grade: 'weak',
      desc: '아크릴 코팅을 선택 도포하고 경화한 뒤 UV 조명으로 도포 유무를 본다. UV 검사는 두께를 재지 못한다.',
      power: power(7.5, 6.5, 2.5, 'assumed', '선택 코팅기 약 1.5 kW + 인라인 경화로(80 °C) 약 6 kW + UV 검사등. 경화로는 멈춰도 온도를 지킨다'),
      tags: [
        ct('spray_pressure', '스프레이 압력', 'MPa', 0.25, 0.006, 'assumed', { lsl: 0.2, usl: 0.32, tau: 60, digits: 3 }),
        ct('cure_temp', '경화 온도', '°C', 80, 0.8, 'assumed', { lsl: 70, usl: 90, tau: 180, digits: 1 }),
        cy('coat_thick', '코팅 두께', 'µm', 50, 4, 'weak', { lsl: 25, usl: 127, digits: 1, note: '25~127 µm (1~5 mil)' }),
      ],
      attrs: [attr('coat_q', '코팅 품질', '점', 100, 1.5, [['tag:coat_thick', 0.6], ['tag:spray_pressure', -0.6], ['tag:cure_temp', 0.5]], 'weak', { digits: 1 })],
      defects: [
        defect('BUBBLE', '코팅 기포', 0.002, [['tag:spray_pressure', 1, 0.9]], 'weak', {
          ...fix('MRB', 10, 0.9),
          note: '처리: 품질 판정(MRB). IPC-A-610은 도체 사이를 잇지 않는 기포를 받아 줄 수 있어 크기·위치를 사람이 본다 (2차 자료). 재작업을 고르면 국부 제거·재도포 10분 (가정)',
        }),
        defect('NOCOAT', '코팅 미도포', 0.001, [['tag:coat_thick', -1, 1.0]], 'weak', {
          ...fix('REWORK', 5, 0.95), note: '처리: 빠진 곳을 다시 도포·경화하고 UV로 재확인 (가정)',
        }),
      ],
    },
    {
      code: 'EM-FCT-B1', name: 'FCT 기능 시험기 #1', kind: 'fct', step: 'BMS_FCT', gate: true, pos: [-4, 2.2], cycle: 85, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '전원을 넣고 셀 전압 측정 정확도, 전류, 온도, 밸런싱, CAN 통신을 시험한다. 밸런싱 전류를 흘릴 때 FET 온도 상승도 잰다.',
      power: power(1.2, 0.8, 0.2, 'assumed', '시험 전원·셀 시뮬레이터·계측 랙·PC (시험 중 기판 소비 포함)'),
      tags: [ct('ref_v', '기준 전압원', 'V', 3.7, 0.0005, 'assumed', { tau: 600, digits: 4 })],
      measures: fctBmsMeasures(),
      detects: [{ defect: 'COLD', prob: 0.9 }, { defect: 'SHIFT', prob: 0.8 }],
    },
    {
      code: 'EM-FCT-B2', name: 'FCT 기능 시험기 #2', kind: 'fct', step: 'BMS_FCT', gate: true, pos: [-4, 5.8], cycle: 85, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: 'FCT #1과 같은 시험기. 택트를 맞추려고 두 대를 병렬로 둔다.',
      power: power(1.2, 0.8, 0.2, 'assumed', '시험 전원·셀 시뮬레이터·계측 랙·PC (시험 중 기판 소비 포함)'),
      tags: [ct('ref_v', '기준 전압원', 'V', 3.7, 0.0005, 'assumed', { tau: 600, digits: 4 })],
      measures: fctBmsMeasures(),
      detects: [{ defect: 'COLD', prob: 0.9 }, { defect: 'SHIFT', prob: 0.8 }],
    },
    {
      code: 'EM-HA-B', name: '하우징 체결 셀', kind: 'screw-cell', step: 'BMS_HOUSING', gate: true, pos: [3, 4], cycle: 40, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: '코팅된 기판을 하우징에 넣고 M3 나사 4개를 자동 드라이버로 체결한다.',
      power: power(1.2, 0.6, 0.2, 'assumed', '자동 드라이버·나사 공급기·XYZ 축·지그'),
      health: health(0.67, 1.8, 39, 200, '자동 드라이버 스핀들·Z축 볼스크루', 'I', 'assumed', '왕복 구동부라 ISO 10816-1 적용 대상은 아니지만 소형기 I등급 구역을 빌려 쓴다. 실제 수명 약 2만 시간(가정)을 1/100로'),
      tags: [cy('screw_torque', '체결 토크', 'N·m', 1.05, 0.03, 'weak', { lsl: 0.9, usl: 1.2, digits: 3, note: 'M3 금속 나사 약 1.0~1.1 N·m' })],
      defects: [
        defect('SCREW', '체결 불량', 0.0015, [['tag:screw_torque', 0, 1.0]], 'weak', {
          ...fix('REWORK', 4, 0.95), note: '처리: 나사를 풀고 새 나사로 다시 체결한 뒤 재확인 (가정). 헤드램프 조립(HL-AS-01)과 같은 코드·기준',
        }),
      ],
    },
    {
      code: 'EM-EOL-B', name: 'EOL 시험기', kind: 'eol-tester', step: 'BMS_EOL', gate: true, pos: [10, 4], cycle: 42, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '완제품 상태에서 절연저항, CAN 진단 응답, 펌웨어·DTC를 확인한다.',
      power: power(1, 0.7, 0.2, 'assumed', '절연 시험기(500 V)·CAN 인터페이스·PC'),
      tags: [ct('test_v', '절연 시험 전압', 'V', 500, 1.5, 'assumed', { tau: 60, digits: 0 })],
      measures: [
        meas('insulation', '절연저항', 'MΩ', 800, 50, [['attr:coat_q', 70]], 'INSUL', 'assumed', {
          lsl: 100, digits: 0, ...fix('REPAIR', 25, 0.7),
          note: '처리: 하우징을 열어 오염 세척·건조 뒤 재시험 (가정). 보이드는 절연과 무관해 여기에 잇지 않았다',
        }),
      ],
      detects: [{ defect: 'COLD', prob: 0.95 }],
    },
    {
      code: 'EM-PK-B', name: 'BMS 포장', kind: 'packer', step: 'BMS_PACK', gate: true, pos: [17, 4], cycle: 20, cycleCv: 0.03, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: 'ESD 트레이에 담아 라벨을 붙인다.',
      power: power(0.6, 0.35, 0.1, 'assumed', '라벨 프린터·판독기·컨베이어'),
      tags: [cy('label_ok', '라벨 판독', '', 1, 0, 'assumed', { digits: 0 })],
    },
  ],
  conveyors: [
    // LED 레인: 인쇄 → SPI → 마운터 → 리플로우 → AOI → 라우터 → 모듈 시험 → AMR 적재 자리(-14)
    [[-51, -4], [-14, -4]],
    [[-53, 4], [-7, 4]],
    [[-7, 4], [-6, 2.2], [-2, 2.2], [-1, 4]],
    [[-7, 4], [-6, 5.8], [-2, 5.8], [-1, 4]],
    [[-1, 4], [20, 4]],
  ],
};
