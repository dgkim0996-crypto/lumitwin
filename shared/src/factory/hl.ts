import type { LineDef } from '../types';
import { attr, ct, cy, defect, meas } from './build';

/**
 * A베이 — LED 헤드램프 라인
 * 근거: docs/research/01-headlamp-process.md
 * 부품 공정(렌즈·리플렉터·하우징) 3줄이 조립 라인에 합류한다. LED 모듈은 B베이(전장) LED 레인에서 AMR로 들어온다.
 */
export const HL: LineDef = {
  code: 'HL',
  name: 'LED 헤드램프 라인',
  short: '헤드램프',
  color: '#f5b544',
  desc: '렌즈 사출·하드코팅, 리플렉터 사출·진공증착, 하우징 사출이 조립 라인에 합류해 실링·기밀·배광 검사를 거친다.',
  product: { code: 'HL-VX1', name: 'LED 헤드램프 (가상 차종 VX1)' },
  taktSec: 75,
  bay: { x0: -58, x1: 58, z0: -38, z1: -12 },
  finalStep: 'PACK',
  steps: [
    { code: 'LENS_MOLD', name: '렌즈 사출', inputs: [{ material: 'PC_RESIN', qty: 1 }], buffer: 30, item: 'LENS', itemName: '렌즈(사출품)', serial: 'new', prefix: 'LN' },
    { code: 'LENS_COAT', name: '렌즈 하드코팅', inputs: [{ step: 'LENS_MOLD', qty: 1 }], buffer: 60, item: 'LENS_HC', itemName: '코팅 렌즈', serial: 'keep' },
    { code: 'REFL_MOLD', name: '리플렉터 사출', inputs: [{ material: 'BMC', qty: 1 }], buffer: 60, item: 'REFL', itemName: '리플렉터(사출품)', serial: 'new', prefix: 'RF' },
    { code: 'REFL_MET', name: '알루미늄 증착', inputs: [{ step: 'REFL_MOLD', qty: 1 }], buffer: 60, item: 'REFL_MET', itemName: '증착 리플렉터', serial: 'keep' },
    { code: 'HOUS_MOLD', name: '하우징 사출', inputs: [{ material: 'PP_TD', qty: 1 }], buffer: 30, item: 'HOUSING', itemName: '하우징', serial: 'new', prefix: 'HS' },
    {
      code: 'ASSY', name: '램프 조립',
      inputs: [{ step: 'HOUS_MOLD', qty: 1 }, { step: 'REFL_MET', qty: 1 }, { transfer: 'T-LED', qty: 2 }, { material: 'LEVELER', qty: 1 }],
      buffer: 3, item: 'LAMP_SA', itemName: '램프 반제품', serial: 'new', prefix: 'HL',
    },
    { code: 'SEAL', name: '렌즈 실링', inputs: [{ step: 'ASSY', qty: 1 }, { step: 'LENS_COAT', qty: 1 }, { material: 'HOTMELT', qty: 1 }], buffer: 3, item: 'LAMP', itemName: '헤드램프', serial: 'keep' },
    { code: 'LEAK', name: '기밀 검사', inputs: [{ step: 'SEAL', qty: 1 }], buffer: 3, item: 'LAMP', itemName: '헤드램프', serial: 'keep' },
    { code: 'PHOTO', name: '배광·에이밍 검사', inputs: [{ step: 'LEAK', qty: 1 }], buffer: 3, item: 'LAMP', itemName: '헤드램프', serial: 'keep' },
    { code: 'EOL', name: 'EOL 점등·통신 검사', inputs: [{ step: 'PHOTO', qty: 1 }], buffer: 3, item: 'LAMP', itemName: '헤드램프', serial: 'keep' },
    { code: 'PACK', name: '포장·라벨', inputs: [{ step: 'EOL', qty: 1 }], buffer: 36, item: 'LAMP_PK', itemName: '포장 헤드램프', serial: 'keep' },
  ],
  stations: [
    {
      code: 'HL-DR-01', name: 'PC 레진 제습 건조기', kind: 'dryer', step: 'LENS_MOLD', pos: [-55.5, -36], cycle: 0, mtbf: 2400, mttr: 30, grade: 'confirmed',
      desc: '렌즈용 PC 레진을 120 °C에서 2~3시간 건조해 수분을 0.02 % 이하로 맞춘다. 사출기 호퍼에 붙어 있는 보조 설비다.',
      tags: [
        ct('dry_temp', '건조 온도', '°C', 120, 0.6, 'confirmed', { lsl: 115, usl: 125, tau: 300, digits: 1, note: 'Covestro AL2447: 120 °C × 2~3 h' }),
        ct('dew_point', '이슬점', '°C', -40, 1.2, 'assumed', { usl: -25, tau: 240, digits: 1, note: '제습 건조기 일반 운전값' }),
        ct('moisture', '레진 수분', '%', 0.012, 0.0015, 'confirmed', { usl: 0.02, tau: 600, digits: 4, terms: [['tag:dew_point', 0.0015], ['tag:dry_temp', -0.0006]], note: 'Covestro: 수분 ≤ 0.02 %' }),
      ],
    },
    {
      code: 'HL-IM-L1', name: '렌즈 사출기 650t', kind: 'injection', step: 'LENS_MOLD', pos: [-47, -33], cycle: 62, cycleCv: 0.01, mtbf: 600, mttr: 25, grade: 'assumed',
      desc: '외부 렌즈(PC)를 사출한다. 금형온도가 낮거나 보압이 높으면 잔류응력이 남아 하드코팅에서 크랙이 난다.',
      tags: [
        ct('melt_temp', '용융 온도', '°C', 300, 1.2, 'confirmed', { lsl: 285, usl: 315, idle: 300, tau: 120, digits: 1, note: 'Covestro 렌즈 가이드: 280~320 °C, 표준 300 °C' }),
        ct('mold_temp', '금형 온도', '°C', 100, 0.8, 'confirmed', { lsl: 90, usl: 110, idle: 98, tau: 180, digits: 1, note: 'Covestro AL2447: 80~120 °C' }),
        cy('inj_pressure', '사출 압력(피크)', 'bar', 1150, 22, 'assumed', { digits: 0 }),
        cy('hold_pressure', '보압', 'bar', 650, 10, 'assumed', { lsl: 600, usl: 700, digits: 0 }),
        cy('cushion', '쿠션량', 'mm', 6.0, 0.25, 'assumed', { lsl: 4, usl: 8, digits: 2 }),
      ],
      attrs: [
        attr('lens_stress', '렌즈 잔류응력', 'MPa', 6.0, 0.5, [['tag:mold_temp', -0.55], ['tag:melt_temp', -0.25], ['tag:hold_pressure', 0.3]], 'confirmed', { digits: 2, note: 'Covestro: 금형·용융온도↓, 보압↑ → 잔류응력↑ (계수는 가정)' }),
      ],
      defects: [
        defect('SILVER', '은줄(실버스트릭)', 0.003, [['tag:HL-DR-01.moisture', 1, 0.8]], 'weak', { note: '건조 부족·수분' }),
        defect('WELD', '웰드라인', 0.004, [['tag:mold_temp', -1, 0.25], ['tag:melt_temp', -1, 0.3]], 'assumed'),
        defect('BLACK', '흑점', 0.002, [['tag:melt_temp', 1, 1.0]], 'weak', { note: '용융 > 330 °C·체류시간' }),
      ],
    },
    {
      code: 'HL-HC-01', name: '렌즈 하드코팅 라인', kind: 'tunnel-hardcoat', step: 'LENS_COAT', pos: [-27, -33], cycle: 2700, cycleCv: 0.005, slots: 44, mtbf: 900, mttr: 40, grade: 'confirmed',
      desc: '클린룸에서 프라이머·실록산 하드코트를 플로우 코팅하고 130 °C에서 45분 열경화한다. 출구에서 외관을 검사한다.',
      tags: [
        ct('oven_temp', '경화로 온도', '°C', 130, 0.6, 'confirmed', { lsl: 125, usl: 135, tau: 300, digits: 1, note: 'Momentive AS4000: 130 °C × 30~60 min' }),
        ct('particles', '클린룸 입자(0.5µm)', '개/ft³', 6000, 600, 'assumed', { usl: 10000, tau: 120, digits: 0, note: 'ISO 7급 가정' }),
        ct('humidity', '부스 습도', '%RH', 45, 1.5, 'assumed', { lsl: 35, usl: 60, tau: 300, digits: 1 }),
        cy('coat_thick', '하드코트 두께', 'µm', 8.0, 0.45, 'confirmed', { lsl: 4.5, usl: 12, digits: 2, note: 'Momentive: 4.5~12 µm' }),
      ],
      defects: [
        defect('CRACK', '코팅 크랙', 0.003, [['attr:lens_stress', 1, 0.75], ['tag:oven_temp', 1, 0.3]], 'confirmed', { note: 'Covestro: 잔류응력 + 코팅 용제 → 크랙' }),
        defect('ADHESION', '밀착 불량', 0.002, [['attr:lens_stress', 1, 0.7], ['tag:oven_temp', -1, 0.8]], 'weak'),
        defect('DUST', '이물', 0.004, [['tag:particles', 1, 0.9]], 'assumed'),
      ],
    },
    {
      code: 'HL-IM-R1', name: '리플렉터 BMC 사출기', kind: 'injection', step: 'REFL_MOLD', pos: [-47, -25.5], cycle: 60, cycleCv: 0.01, mtbf: 720, mttr: 25, grade: 'weak',
      desc: '열경화성 BMC로 리플렉터를 성형한다. 금형 약 150 °C, 경화 30~40초.',
      tags: [
        ct('mold_temp', '금형 온도', '°C', 150, 1.0, 'confirmed', { lsl: 140, usl: 160, idle: 148, tau: 180, digits: 1, note: 'LyondellBasell BMC 304: 약 150 °C' }),
        cy('inj_pressure', '성형 압력', 'bar', 50, 1.8, 'confirmed', { lsl: 35, usl: 65, digits: 1, note: 'BMC 304: 35~65 bar' }),
        cy('cure_time', '경화 시간', 's', 35, 0.8, 'confirmed', { lsl: 30, usl: 40, digits: 1, note: 'Wah Hong BMC: 30~40 s' }),
      ],
      attrs: [
        attr('surface_rough', '표면 조도(Ra)', 'nm', 20, 2, [['tag:mold_temp', -1.2], ['tag:cure_time', -0.8]], 'assumed', { digits: 1 }),
      ],
      defects: [
        defect('SHORT', '미성형', 0.002, [['tag:inj_pressure', -1, 0.8]], 'assumed'),
        defect('BLISTER', '기포', 0.002, [['tag:mold_temp', 1, 0.6]], 'assumed'),
      ],
    },
    {
      code: 'HL-VM-01', name: '진공증착기 (Al + HMDSO)', kind: 'metallizer', step: 'REFL_MET', pos: [-31, -25.5], cycle: 1440, cycleCv: 0.01, batch: 24, mtbf: 1200, mttr: 60, grade: 'confirmed',
      desc: '리플렉터 24개를 랙에 걸어 진공에서 알루미늄을 증착하고 같은 챔버에서 HMDSO 보호막을 입힌다. 한 배치 약 24분.',
      tags: [
        ct('chamber_pressure', '챔버 압력', 'Pa', 0.2, 0.008, 'confirmed', { usl: 0.35, tau: 60, digits: 3, note: '특허 US6520650: 약 0.002 mbar' }),
        cy('pumpdown', '펌프다운 시간', 'min', 9.0, 0.3, 'assumed', { usl: 14, digits: 1 }),
        cy('al_thick', 'Al 막두께', 'nm', 60, 2.5, 'confirmed', { lsl: 45, usl: 90, digits: 1, note: 'US6520650: 45~90 nm, 최적 약 60 nm' }),
        cy('topcoat_time', '탑코트 시간', 's', 35, 1.5, 'confirmed', { usl: 60, digits: 1, note: 'US6520650: 30~40 s 최적, 1 min 초과 시 백화' }),
      ],
      attrs: [
        attr('reflectance', '반사율', '%', 88, 0.6, [['tag:al_thick', 0.3], ['tag:chamber_pressure', -0.1], ['attr:surface_rough', -0.3]], 'assumed', { digits: 1 }),
      ],
      defects: [
        defect('HAZE', '백화(헤이즈)', 0.003, [['tag:chamber_pressure', 1, 0.6], ['tag:topcoat_time', 1, 0.8]], 'weak'),
        defect('RAINBOW', '무지개 얼룩', 0.002, [['tag:al_thick', 0, 0.8]], 'weak'),
        defect('PEEL', '증착 박리', 0.002, [['attr:surface_rough', 1, 0.7]], 'assumed'),
      ],
    },
    {
      code: 'HL-IM-H1', name: '하우징 사출기 850t', kind: 'injection', step: 'HOUS_MOLD', pos: [-47, -17.5], cycle: 62, cycleCv: 0.01, mtbf: 600, mttr: 25, grade: 'assumed',
      desc: 'PP-TD 하우징을 사출한다. 냉각이 고르지 않으면 렌즈와 붙는 플랜지가 휘어 기밀 불량의 원인이 된다.',
      tags: [
        ct('melt_temp', '용융 온도', '°C', 220, 1.2, 'assumed', { lsl: 200, usl: 240, idle: 220, tau: 120, digits: 1 }),
        ct('mold_temp', '금형 온도', '°C', 45, 0.8, 'assumed', { lsl: 30, usl: 60, idle: 40, tau: 180, digits: 1 }),
        cy('cool_time', '냉각 시간', 's', 28, 0.6, 'assumed', { lsl: 24, usl: 34, digits: 1 }),
        cy('hold_pressure', '보압', 'bar', 450, 9, 'assumed', { digits: 0 }),
      ],
      attrs: [
        attr('flange_flat', '플랜지 평탄도', 'mm', 0.15, 0.025, [['tag:cool_time', -0.02], ['tag:mold_temp', 0.015]], 'assumed', { digits: 3 }),
      ],
      defects: [
        defect('WARP', '휨', 0.003, [['tag:cool_time', -1, 0.9]], 'assumed'),
        defect('SINK', '싱크마크', 0.002, [['tag:hold_pressure', -1, 0.7]], 'assumed'),
      ],
    },
    {
      code: 'HL-AS-01', name: '램프 조립 셀 (협동로봇)', kind: 'assembly-cell', step: 'ASSY', pos: [2, -24], cycle: 70, cycleCv: 0.03, mtbf: 480, mttr: 15, grade: 'assumed',
      desc: '하우징에 증착 리플렉터, LED 모듈 2개(로우·하이빔), 레벨링 액추에이터를 체결하고 배선한다. 클린·ESD 환경.',
      tags: [
        cy('screw_torque', '체결 토크', 'N·m', 1.2, 0.035, 'assumed', { lsl: 1.0, usl: 1.4, digits: 3 }),
        cy('conn_force', '커넥터 삽입력', 'N', 45, 2.5, 'assumed', { lsl: 35, usl: 60, digits: 1 }),
      ],
      attrs: [
        attr('aim_offset', '광원 정렬 편차', '°', 0, 0.03, [['attr:led_offset', 0.035]], 'assumed', { digits: 3, note: 'LED 장착 편차가 광축 편차로 이어진다고 가정' }),
      ],
      defects: [
        defect('SCREW', '체결 불량', 0.002, [['tag:screw_torque', 0, 1.0]], 'assumed'),
        defect('CONN', '커넥터 미체결', 0.002, [['tag:conn_force', -1, 0.9]], 'assumed', { latent: true }),
      ],
    },
    {
      code: 'HL-SL-01', name: '렌즈 핫멜트 실링·압착기', kind: 'sealer', step: 'SEAL', pos: [12, -24], cycle: 66, cycleCv: 0.01, mtbf: 720, mttr: 20, grade: 'weak',
      desc: '하우징 홈에 핫멜트 실런트를 도포하고 코팅 렌즈를 눌러 붙인다. PP 하우징과 PC 렌즈는 극성 차이로 융착이 어려워 실런트를 쓴다.',
      tags: [
        ct('hotmelt_temp', '핫멜트 온도', '°C', 190, 1.0, 'assumed', { lsl: 180, usl: 200, idle: 185, tau: 120, digits: 1 }),
        cy('bead_volume', '도포량', '%', 100, 2.5, 'assumed', { lsl: 85, usl: 115, digits: 1 }),
        cy('clamp_time', '압착 시간', 's', 20, 0.4, 'assumed', { digits: 1 }),
      ],
      attrs: [
        attr('seal_integrity', '실링 완전성', '%', 100, 1.2, [['tag:hotmelt_temp', 0.9], ['tag:bead_volume', 1.3], ['attr:flange_flat', -1.1]], 'weak', { digits: 2, note: '한양대 논문: 핫멜트 접착부 박리 → 수분 침투' }),
      ],
    },
    {
      code: 'HL-LT-01', name: '기밀(리크) 검사기', kind: 'leak-tester', step: 'LEAK', pos: [21, -24], cycle: 50, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'weak',
      desc: '램프 내부를 30 mbar로 가압하고 30초 동안 압력 강하를 잰다. 강하가 1,000 Pa(10 mbar)를 넘으면 누설.',
      tags: [
        ct('test_pressure', '시험 압력', 'Pa', 3000, 12, 'confirmed', { lsl: 2900, usl: 3100, tau: 30, digits: 0, note: 'NHTSA TSB: 최대 30 mbar' }),
      ],
      measures: [
        meas('leak_drop', '30 s 압력 강하', 'Pa', 250, 50, [['attr:seal_integrity', -120]], 'LEAK', 'confirmed', { usl: 1000, digits: 0, note: 'NHTSA TSB: 30 s 동안 > 10 mbar 강하면 누설 (영향 계수는 가정)' }),
      ],
    },
    {
      code: 'HL-PH-01', name: '배광·에이밍 검사기 (카메라식)', kind: 'photometry', step: 'PHOTO', pos: [31, -24], cycle: 55, cycleCv: 0.01, mtbf: 1440, mttr: 20, grade: 'weak',
      desc: '암실에서 빔을 촬영해 컷오프 위치·각도·최대 광도를 잰다. UN R149·FMVSS 108 배광 기준의 양산용 축소판.',
      tags: [
        ct('room_lux', '암실 조도', 'lux', 0.5, 0.05, 'assumed', { usl: 2, tau: 30, digits: 2 }),
      ],
      measures: [
        meas('aim_v', '수직 광축', '°', 0, 0.05, [['attr:aim_offset', 0.03]], 'AIM', 'assumed', { lsl: -0.3, usl: 0.3, digits: 3, note: '에이밍 정밀도 < ±0.2 cm (FORI) 참고' }),
        meas('max_kcd', '최대 광도', 'kcd', 38, 1.0, [['attr:reflectance', 1.1], ['attr:aim_offset', -0.15]], 'LUX', 'assumed', { lsl: 32, digits: 1 }),
      ],
    },
    {
      code: 'HL-EOL-01', name: 'EOL 점등·통신 검사기', kind: 'eol-tester', step: 'EOL', pos: [41, -24], cycle: 40, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '전 기능을 점등하고 전류와 LIN 통신 응답을 확인한다. 커넥터 미체결과 LED 납땜 불량이 여기서 걸린다.',
      tags: [ct('supply_v', '공급 전압', 'V', 13.5, 0.02, 'assumed', { tau: 30, digits: 2 })],
      measures: [meas('lamp_current', '소비 전류', 'A', 1.8, 0.025, [], 'ELEC', 'assumed', { lsl: 1.65, usl: 1.95, digits: 3 })],
      detects: [{ defect: 'CONN', prob: 0.98 }, { defect: 'COLD', prob: 0.9 }],
    },
    {
      code: 'HL-PK-01', name: '포장·라벨 셀 (협동로봇)', kind: 'packer', step: 'PACK', pos: [50, -24], cycle: 25, cycleCv: 0.03, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '완제품에 출하 라벨을 붙이고 전용 용기에 적재한다. 가득 차면 AMR이 완제품 창고로 옮긴다.',
      tags: [cy('label_ok', '라벨 판독', '', 1, 0, 'assumed', { digits: 0 })],
    },
  ],
  conveyors: [
    [[-43, -33], [-35, -33]],
    [[-19, -33], [12, -33], [12, -27]],
    [[-43, -25.5], [-33.5, -25.5]],
    [[-28.5, -25.5], [-1, -25.5]],
    [[-42.5, -17.5], [-4, -17.5], [-4, -22.5], [-1, -22.5]],
    [[5, -24], [54, -24]],
  ],
};
