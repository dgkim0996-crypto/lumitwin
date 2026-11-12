import type { LineDef } from '../types';
import { attr, ct, cy, defect, meas, warmup } from './build';

/**
 * C베이 — 전동 폴딩 사이드미러 라인
 * 근거: docs/research/03-mirror-company-logistics.md
 * 커버 사출·도장, 브래킷 사출·액추에이터 조립이 최종 조립에 합류하고 기능 검사(폴딩 시간·전류·소음·히팅)를 거친다.
 */
export const OSM: LineDef = {
  code: 'OSM',
  name: '사이드미러 라인',
  short: '미러',
  color: '#7ee0a1',
  desc: '커버 사출·도장, 브래킷 사출·폴딩 액추에이터 조립이 최종 조립에 합류한다. 기능 검사에서 폴딩 시간·모터 전류·작동 소음·히터를 본다.',
  product: { code: 'OSM-VX1', name: '전동 폴딩 사이드미러 (가상 차종 VX1)' },
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
      tags: [
        cy('grease_mg', '그리스 도포량', 'mg', 120, 4, 'assumed', { lsl: 100, usl: 140, digits: 1 }),
        cy('screw_torque', '체결 토크', 'N·m', 0.8, 0.025, 'assumed', { lsl: 0.7, usl: 0.9, digits: 3 }),
      ],
      attrs: [attr('gear_friction', '기어 마찰 지수', '', 1.0, 0.04, [['tag:grease_mg', -0.03], ['attr:bracket_flat', 0.015]], 'weak', { digits: 3 })],
    },
    {
      code: 'OSM-AS-01', name: '미러 최종 조립 셀', kind: 'assembly-cell', step: 'FINAL_ASSY', pos: [5, 27], cycle: 58, cycleCv: 0.03, mtbf: 480, mttr: 15, grade: 'assumed',
      desc: '액추에이터에 도장 커버, 히팅 미러 글래스, 턴시그널 LED, 하네스를 조립한다.',
      tags: [
        cy('screw_torque', '체결 토크', 'N·m', 1.5, 0.04, 'assumed', { lsl: 1.3, usl: 1.7, digits: 3 }),
        cy('glass_force', '글래스 압입력', 'N', 120, 5, 'assumed', { lsl: 100, usl: 145, digits: 1 }),
      ],
      defects: [
        defect('CONN', '커넥터 미체결', 0.002, [], 'assumed', { latent: true }),
        defect('GAP', '조립 단차', 0.002, [['tag:screw_torque', 0, 0.8]], 'assumed'),
      ],
    },
    {
      code: 'OSM-FT-01', name: '기능 검사기 (폴딩·소음·히팅)', kind: 'function-tester', step: 'FUNC_TEST', pos: [15, 27], cycle: 50, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'weak',
      desc: '접기·펴기를 돌리며 시간·모터 전류·작동 소음을 재고, 히터 전류와 턴시그널 점등을 확인한다.',
      tags: [ct('bg_noise', '부스 배경 소음', 'dB(A)', 30, 0.5, 'assumed', { usl: 35, tau: 60, digits: 1 })],
      measures: [
        meas('fold_time', '폴딩 시간', 's', 4.2, 0.1, [['attr:gear_friction', 0.18]], 'FOLD_TIME', 'assumed', { usl: 6.0, digits: 2, note: '공개 근거 없음: 3~6 s 가정' }),
        meas('fold_current', '모터 전류', 'A', 0.62, 0.025, [['attr:gear_friction', 0.05]], 'MOTOR_CURRENT', 'assumed', { usl: 1.0, digits: 3, note: '정상 0.3~1 A 가정' }),
        meas('noise', '작동 소음', 'dB(A)', 41, 0.8, [['attr:gear_friction', 1.0]], 'NOISE', 'confirmed', { usl: 47, digits: 1, note: 'Magna 액추에이터: < 47 dB(A) @20 cm' }),
        meas('heater_a', '히터 전류', 'A', 2.8, 0.06, [], 'HEATER', 'assumed', { lsl: 2.4, usl: 3.2, digits: 2 }),
      ],
      detects: [{ defect: 'CONN', prob: 0.98 }],
    },
    {
      code: 'OSM-PK-01', name: '미러 포장', kind: 'packer', step: 'PACK', pos: [24, 27], cycle: 25, cycleCv: 0.03, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: '좌·우 짝을 맞춰 포장하고 라벨을 붙인다.',
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
