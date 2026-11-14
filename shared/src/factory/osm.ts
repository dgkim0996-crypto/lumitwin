import type { LineDef } from '../types';
import { attr, ct, cy, defect, fix, health, meas, power, warmup } from './build';

/**
 * C베이 — 전동 폴딩 사이드미러 라인
 * 근거: docs/research/03-mirror-company-logistics.md · P9 전력·상태 감시·불량 처리 기준: docs/research/04-energy-health-ncr.md
 * 커버 사출·도장, 브래킷 사출·액추에이터 조립이 최종 조립에 합류하고 기능 검사(폴딩 시간·전류·소음·히팅)를 거친다.
 */
export const OSM: LineDef = {
  code: 'OSM',
  name: '사이드미러 라인',
  short: '미러',
  color: '#7ee0a1',
  desc: '커버 사출·도장, 브래킷 사출·폴딩 액추에이터 조립이 최종 조립에 합류한다. 기능 검사에서 폴딩 시간·모터 전류·작동 소음·히터를 본다.',
  product: { code: 'OSM-VX1', name: '전동 폴딩 사이드미러 (가상 차종 VX1)' },
  variants: [
    { code: 'OSM-VX1-L', name: '좌측 (LH)', desc: '운전석 쪽 사이드미러', grade: 'assumed' },
    { code: 'OSM-VX1-R', name: '우측 (RH)', desc: '조수석 쪽 사이드미러 (광각 글래스)', grade: 'assumed' },
  ],
  release: 'FINAL_ASSY',
  // 커버는 좌·우 2캐비티 금형에서 함께 나오므로 사출·도장은 기종 변경이 없다
  changeover: [
    { station: 'OSM-AS-01', minutes: 5, what: '조립 지그·글래스 랙 교체 (좌↔우)', grade: 'assumed' },
    { station: 'OSM-FT-01', minutes: 2, what: '기능 시험 프로그램·지그 교체', grade: 'assumed' },
    { station: 'OSM-PK-01', minutes: 1, what: '라벨·박스 변경', grade: 'assumed' },
  ],
  taktSec: 60,
  bay: { x0: -58, x1: 58, z0: 14, z1: 38 },
  finalStep: 'PACK',
  steps: [
    { code: 'COVER_MOLD', name: '커버 사출', inputs: [{ material: 'ASA', qty: 1 }], buffer: 40, item: 'COVER', itemName: '미러 커버', serial: 'new', prefix: 'CV' },
    { code: 'COVER_PAINT', name: '커버 도장', inputs: [{ step: 'COVER_MOLD', qty: 1 }, { material: 'PAINT', qty: 1 }], buffer: 40, item: 'COVER_PT', itemName: '도장 커버', serial: 'keep' },
    { code: 'BRKT_MOLD', name: '브래킷 사출', inputs: [{ material: 'PA6GF', qty: 1 }], buffer: 30, item: 'BRACKET', itemName: '브래킷', serial: 'new', prefix: 'BK' },
    {
      code: 'ACT_ASSY', name: '폴딩 액추에이터 조립',
      inputs: [{ step: 'BRKT_MOLD', qty: 1 }, { material: 'MOTOR', qty: 1 }, { material: 'GEARSET', qty: 1 }, { material: 'GREASE', qty: 1 }],
      buffer: 20, item: 'ACTUATOR', itemName: '폴딩 액추에이터', serial: 'keep',
    },
    {
      code: 'FINAL_ASSY', name: '미러 최종 조립',
      inputs: [{ step: 'ACT_ASSY', qty: 1 }, { step: 'COVER_PAINT', qty: 1 }, { material: 'GLASS', qty: 1 }, { material: 'TURN_LED', qty: 1 }, { material: 'HARNESS', qty: 1 }],
      buffer: 3, item: 'OSM', itemName: '사이드미러', serial: 'new', prefix: 'OM',
    },
    { code: 'FUNC_TEST', name: '기능 검사', inputs: [{ step: 'FINAL_ASSY', qty: 1 }], buffer: 3, item: 'OSM', itemName: '사이드미러', serial: 'keep' },
    { code: 'PACK', name: '포장', inputs: [{ step: 'FUNC_TEST', qty: 1 }], buffer: 32, item: 'OSM_PK', itemName: '포장 사이드미러', serial: 'keep' },
  ],
  stations: [
    {
      code: 'OSM-IM-C1', name: '커버 사출기 (ASA, 좌/우 2캐비티)', kind: 'injection', step: 'COVER_MOLD', pos: [-47, 32], cycle: 90, cycleCv: 0.01, batch: 2, mtbf: 600, mttr: 25, grade: 'confirmed',
      warmup: warmup('GLOSS'),
      desc: '좌·우 커버를 한 금형에서 함께 뽑는다. 고광택 외관이라 금형온도를 60~90 °C로 높게 쓴다.',
      power: power(24, 12, 9, 'weak', '약 450 t 서보 유압 가정. 커버 2개(약 0.7 kg)/90초 ≈ 28 kg/h × 약 0.8 kWh/kg(서보 유압 비에너지 범위) + 금형 온조기'),
      health: health(1.05, 48, 47, 300, '서보 유압 펌프·구동 모터 베어링', 'II', 'assumed', '구동 모터 약 37~45 kW → II등급. 실제 수명 약 3만 시간(가정)을 1/100로'),
      tags: [
        ct('dryer_dew', '건조기 이슬점', '°C', -40, 1.2, 'assumed', { usl: -25, tau: 240, digits: 1 }),
        ct('melt_temp', '용융 온도', '°C', 250, 1.2, 'confirmed', { lsl: 200, usl: 280, idle: 250, tau: 120, digits: 1, note: 'ABS/ASA 200~280 °C' }),
        ct('mold_temp', '금형 온도', '°C', 70, 0.8, 'confirmed', { lsl: 60, usl: 90, idle: 68, tau: 180, digits: 1, note: '고광택 60~90 °C' }),
        cy('inj_pressure', '사출 압력', 'bar', 900, 18, 'assumed', { digits: 0 }),
      ],
      defects: [
        defect('SILVER', '은줄', 0.003, [['tag:dryer_dew', 1, 0.6]], 'confirmed', { note: '건조 부족' }),
        defect('WELD', '웰드라인', 0.003, [['tag:mold_temp', -1, 0.8]], 'confirmed'),
        defect('GLOSS', '광택 저하', 0.002, [['tag:mold_temp', -1, 0.7]], 'confirmed'),
      ],
    },
    {
      code: 'OSM-PT-01', name: '커버 도장 라인', kind: 'tunnel-paint', step: 'COVER_PAINT', pos: [-24, 32], cycle: 1800, cycleCv: 0.005, slots: 36, mtbf: 900, mttr: 40, grade: 'weak',
      desc: '전처리 → 베이스·클리어 웨트온웨트 정전 도장 → 플래시오프 → 125 °C 건조로. 부스 습도가 높으면 핀홀·흐름이 는다.',
      power: power(140, 120, 45, 'weak', '도장 부스 급기 공조(온습도 조절)·건조로(125 °C)·도장 로봇·컨베이어를 모두 전기로 본 값 (가정, 실제 공장은 가스도 많이 쓴다). 자동차 공장 에너지의 40~70 %를 도장이 쓴다는 공개 자료와 같은 결로 공장에서 가장 크게 잡았다. 공조·건조로는 멈춰도 거의 그대로 돈다'),
      tags: [
        ct('booth_temp', '부스 온도', '°C', 23, 0.3, 'assumed', { lsl: 20, usl: 27, tau: 300, digits: 1 }),
        ct('booth_humidity', '부스 습도', '%RH', 55, 1.2, 'assumed', { lsl: 45, usl: 70, tau: 300, digits: 1 }),
        ct('oven_temp', '건조로 온도', '°C', 125, 0.8, 'weak', { lsl: 115, usl: 135, tau: 300, digits: 1, note: 'GMW18630 인용: 115~135 °C' }),
        cy('base_film', '베이스 막두께', 'µm', 18, 1.0, 'assumed', { lsl: 15, usl: 22, digits: 1 }),
        cy('clear_film', '클리어 막두께', 'µm', 40, 1.8, 'assumed', { lsl: 35, usl: 48, digits: 1 }),
      ],
      defects: [
        defect('DUST', '이물', 0.004, [], 'assumed'),
        defect('ORANGE', '오렌지필', 0.003, [['tag:clear_film', 0, 0.7]], 'weak'),
        defect('PINHOLE', '핀홀', 0.002, [['tag:booth_humidity', 1, 0.75]], 'weak', { note: '플래시오프 부족·습도' }),
        defect('RUN', '도료 흐름', 0.002, [['tag:clear_film', 1, 0.9]], 'weak'),
      ],
    },
    {
      code: 'OSM-IM-B1', name: '브래킷 사출기 (PA6-GF30)', kind: 'injection', step: 'BRKT_MOLD', pos: [-47, 20], cycle: 50, cycleCv: 0.01, mtbf: 600, mttr: 25, grade: 'confirmed',
      warmup: warmup('WARP'),
      desc: '유리섬유 강화 나일론으로 미러 브래킷·액추에이터 하우징을 사출한다. 금형온도가 낮으면 결정화가 덜 돼 휜다.',
      power: power(10, 6, 5, 'weak', '약 180 t 전동식 가정. 전동식은 유압식보다 비에너지가 낮다(약 0.2~0.4 kWh/kg, 공개 비교 자료). 대부분이 배럴 히터(270 °C)·금형 온조기(85 °C)'),
      health: health(0.68, 24, 44, 200, '사출 볼스크루·서보 모터 베어링', 'I', 'assumed', '사출 서보 모터 약 15 kW → I등급. 볼스크루 실제 수명 약 2만 시간(가정)을 1/100로'),
      tags: [
        ct('melt_temp', '용융 온도', '°C', 270, 1.2, 'confirmed', { lsl: 250, usl: 290, idle: 270, tau: 120, digits: 1, note: 'BASF Ultramid B3U30G6: 250~290 °C' }),
        ct('mold_temp', '금형 온도', '°C', 85, 0.8, 'confirmed', { lsl: 80, usl: 90, idle: 82, tau: 180, digits: 1, note: 'BASF: 80~90 °C' }),
        cy('hold_pressure', '보압', 'bar', 700, 12, 'assumed', { digits: 0 }),
      ],
      attrs: [attr('bracket_flat', '브래킷 평탄도', 'mm', 0.1, 0.015, [['tag:mold_temp', -0.012]], 'confirmed', { digits: 3, note: '금형온도↓ → 결정화 부족 → 휨' })],
      defects: [defect('WARP', '휨', 0.003, [['tag:mold_temp', -1, 0.9]], 'confirmed')],
    },
    {
      code: 'OSM-AC-01', name: '폴딩 액추에이터 조립 셀', kind: 'actuator-cell', step: 'ACT_ASSY', pos: [-31, 20], cycle: 50, cycleCv: 0.03, mtbf: 480, mttr: 15, grade: 'weak',
      desc: '브래킷에 모터·웜기어·클러치를 넣고 그리스를 정량 도포한 뒤 체결한다. 그리스가 모자라면 기어 마찰이 커져 소음·전류가 오른다.',
      power: power(1.8, 0.9, 0.25, 'assumed', '서보 프레스·자동 드라이버·그리스 정량 디스펜서·지그'),
      health: health(0.68, 2.6, 41, 180, '서보 프레스 볼스크루·체결 스핀들', 'I', 'assumed', '왕복 구동부라 ISO 10816-1 적용 대상은 아니지만 소형기 I등급 구역을 빌려 쓴다. 실제 수명 약 1.8만 시간(가정)을 1/100로'),
      tags: [
        cy('grease_mg', '그리스 도포량', 'mg', 120, 4, 'assumed', { lsl: 100, usl: 140, digits: 1 }),
        cy('screw_torque', '체결 토크', 'N·m', 0.8, 0.025, 'assumed', { lsl: 0.7, usl: 0.9, digits: 3 }),
      ],
      attrs: [attr('gear_friction', '기어 마찰 지수', '', 1.0, 0.04, [['tag:grease_mg', -0.03], ['attr:bracket_flat', 0.015]], 'weak', { digits: 3 })],
    },
    {
      code: 'OSM-AS-01', name: '미러 최종 조립 셀', kind: 'assembly-cell', step: 'FINAL_ASSY', gate: true, pos: [5, 27], cycle: 58, cycleCv: 0.03, mtbf: 480, mttr: 15, grade: 'assumed',
      desc: '액추에이터에 도장 커버, 히팅 미러 글래스, 턴시그널 LED, 하네스를 조립한다.',
      power: power(2, 1.1, 0.3, 'weak', '협동로봇(UR10e급 평균 약 350 W, 제조사 표기) + 자동 드라이버·글래스 압입 프레스·지그 (가정)'),
      health: health(0.66, 2.2, 40, 220, '협동로봇 관절 감속기·글래스 압입 프레스', 'I', 'assumed', '왕복 구동부라 ISO 10816-1 적용 대상은 아니지만 소형기 I등급 구역을 빌려 쓴다. 실제 수명 약 2.2만 시간(가정)을 1/100로'),
      tags: [
        cy('screw_torque', '체결 토크', 'N·m', 1.5, 0.04, 'assumed', { lsl: 1.3, usl: 1.7, digits: 3 }),
        cy('glass_force', '글래스 압입력', 'N', 120, 5, 'assumed', { lsl: 100, usl: 145, digits: 1 }),
      ],
      defects: [
        defect('CONN', '커넥터 미체결', 0.002, [], 'assumed', {
          latent: true, ...fix('REWORK', 12, 0.9),
          note: '기능 검사에서 걸린다. 처리: 글래스를 떼고 하네스 커넥터를 다시 꽂는다 (가정). 헤드램프 조립(HL-AS-01)과 같은 코드·기준',
        }),
        defect('GAP', '조립 단차', 0.002, [['tag:screw_torque', 0, 0.8]], 'assumed', {
          ...fix('REWORK', 6, 0.9), note: '처리: 커버를 풀어 다시 맞춰 체결하고 재확인 (가정)',
        }),
      ],
    },
    {
      code: 'OSM-FT-01', name: '기능 검사기 (폴딩·소음·히팅)', kind: 'function-tester', step: 'FUNC_TEST', gate: true, pos: [15, 27], cycle: 50, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'weak',
      desc: '접기·펴기를 돌리며 시간·모터 전류·작동 소음을 재고, 히터 전류와 턴시그널 점등을 확인한다.',
      power: power(1.1, 0.7, 0.2, 'assumed', '시험 전원(미러 히터 약 40 W 포함)·소음 계측·지그 구동·PC'),
      tags: [ct('bg_noise', '부스 배경 소음', 'dB(A)', 30, 0.5, 'assumed', { usl: 35, tau: 60, digits: 1 })],
      measures: [
        meas('fold_time', '폴딩 시간', 's', 4.2, 0.1, [['attr:gear_friction', 0.18]], 'FOLD_TIME', 'assumed', {
          usl: 6.0, digits: 2, ...fix('REPAIR', 20, 0.85), note: '공개 근거 없음: 3~6 s 가정. 처리: 액추에이터를 새것으로 바꾸고 재시험 (가정)',
        }),
        meas('fold_current', '모터 전류', 'A', 0.62, 0.025, [['attr:gear_friction', 0.05]], 'MOTOR_CURRENT', 'assumed', {
          usl: 1.0, digits: 3, ...fix('REPAIR', 20, 0.85), note: '정상 0.3~1 A 가정. 처리: 액추에이터를 새것으로 바꾸고 재시험 (가정)',
        }),
        meas('noise', '작동 소음', 'dB(A)', 41, 0.8, [['attr:gear_friction', 1.0]], 'NOISE', 'confirmed', {
          usl: 47, digits: 1, ...fix('MRB', 20, 0.85),
          note: 'Magna 액추에이터: < 47 dB(A) @20 cm. 처리: 품질 판정(MRB). 규격 근처 소음은 배경 소음·청감 재평가가 필요해 자동으로 정하지 않는다. 수리를 고르면 액추에이터 교체 20분 (가정)',
        }),
        meas('heater_a', '히터 전류', 'A', 2.8, 0.06, [], 'HEATER', 'assumed', {
          lsl: 2.4, usl: 3.2, digits: 2, ...fix('REPAIR', 10, 0.9), note: '처리: 히팅 글래스나 커넥터를 바꾸고 재시험 (가정)',
        }),
      ],
      detects: [{ defect: 'CONN', prob: 0.98 }],
    },
    {
      code: 'OSM-PK-01', name: '미러 포장', kind: 'packer', step: 'PACK', gate: true, pos: [24, 27], cycle: 25, cycleCv: 0.03, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: '좌·우 짝을 맞춰 포장하고 라벨을 붙인다.',
      power: power(0.6, 0.35, 0.1, 'assumed', '라벨 프린터·판독기·컨베이어'),
      tags: [cy('label_ok', '라벨 판독', '', 1, 0, 'assumed', { digits: 0 })],
    },
  ],
  conveyors: [
    [[-43, 32], [-33, 32]],
    [[-15, 32], [2, 32], [2, 30]],
    [[-43, 20], [-34, 20]],
    [[-28, 20], [2, 20], [2, 24]],
    [[8, 27], [27, 27]],
  ],
};
