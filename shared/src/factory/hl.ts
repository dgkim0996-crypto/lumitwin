import type { LineDef } from '../types';
import { attr, ct, cy, defect, fix, health, meas, power, warmup } from './build';

/**
 * A베이 — LED 헤드램프 라인
 * 근거: docs/research/01-headlamp-process.md · P9 전력·상태 감시·불량 처리 기준: docs/research/04-energy-health-ncr.md
 * 부품 공정(렌즈·리플렉터·하우징) 3줄이 조립 라인에 합류한다. LED 모듈은 B베이(전장) LED 레인에서 AMR로 들어온다.
 */
export const HL: LineDef = {
  code: 'HL',
  name: 'LED 헤드램프 라인',
  short: '헤드램프',
  color: '#f5b544',
  desc: '렌즈 사출·하드코팅, 리플렉터 사출·진공증착, 하우징 사출이 조립 라인에 합류해 실링·기밀·배광 검사를 거친다.',
  product: { code: 'HL-VX1', name: 'LED 헤드램프 (가상 차종 VX1)' },
  variants: [
    { code: 'HL-VX1-L', name: '좌측 (LH)', desc: '운전석 쪽 헤드램프', grade: 'assumed' },
    { code: 'HL-VX1-R', name: '우측 (RH)', desc: '조수석 쪽 헤드램프. 배광 컷오프 방향과 에이밍 기준이 좌측과 대칭', grade: 'assumed' },
  ],
  release: 'ASSY',
  // 렌즈·하우징·리플렉터는 좌·우를 한 금형(패밀리 금형)에서 함께 뽑는다고 보고 사출은 기종 변경이 없다 (가정)
  changeover: [
    { station: 'HL-AS-01', minutes: 6, what: '조립 지그·부품 트레이 교체 (좌↔우)', grade: 'assumed' },
    { station: 'HL-SL-01', minutes: 4, what: '실링 지그·도포 경로 변경', grade: 'assumed' },
    { station: 'HL-LT-01', minutes: 3, what: '기밀 치구 교체', grade: 'assumed' },
    { station: 'HL-PH-01', minutes: 2, what: '배광 측정 레시피 변경 (컷오프 방향)', grade: 'assumed' },
    { station: 'HL-EOL-01', minutes: 1, what: 'EOL 시험 프로그램 변경', grade: 'assumed' },
    { station: 'HL-PK-01', minutes: 1, what: '라벨 양식·포장 용기 변경', grade: 'assumed' },
  ],
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
      code: 'HL-DR-01', name: 'PC 레진 제습 건조기', kind: 'dryer', step: 'LENS_MOLD', aux: true, pos: [-55.5, -36], cycle: 0, mtbf: 2400, mttr: 30, grade: 'confirmed',
      desc: '렌즈용 PC 레진을 120 °C에서 2~3시간 건조해 수분을 0.02 % 이하로 맞춘다. 자기 공정 없이 렌즈 사출기(HL-IM-L1) 호퍼에 붙어 이슬점·수분 같은 공정 조건만 내는 보조 설비라 생산 수·OEE에서 뺀다.',
      power: power(6, 4.5, 1, 'weak', '설치 용량 약 11 kW(공정 히터 6 + 재생 히터 4 + 송풍기 약 1, PPE FX-100 표기) × 평균 부하율 약 55 % (가정). 보조 설비라 늘 가동으로 센다'),
      tags: [
        ct('dry_temp', '건조 온도', '°C', 120, 0.6, 'confirmed', { lsl: 115, usl: 125, tau: 300, digits: 1, note: 'Covestro AL2447: 120 °C × 2~3 h' }),
        ct('dew_point', '이슬점', '°C', -40, 1.2, 'assumed', { usl: -25, tau: 240, digits: 1, note: '제습 건조기 일반 운전값' }),
        ct('moisture', '레진 수분', '%', 0.012, 0.0015, 'confirmed', { usl: 0.02, tau: 600, digits: 4, terms: [['tag:dew_point', 0.0015], ['tag:dry_temp', -0.0006]], note: 'Covestro: 수분 ≤ 0.02 %' }),
      ],
    },
    {
      code: 'HL-IM-L1', name: '렌즈 사출기 650t', kind: 'injection', step: 'LENS_MOLD', pos: [-47, -33], cycle: 62, cycleCv: 0.01, mtbf: 600, mttr: 25, grade: 'assumed',
      warmup: warmup('WELD'),
      desc: '외부 렌즈(PC)를 사출한다. 금형온도가 낮거나 보압이 높으면 잔류응력이 남아 하드코팅에서 크랙이 난다.',
      power: power(38, 19, 14, 'weak', '650 t급 서보 유압. 설치 용량 펌프 65 kW·히터 48 kW(Haitian JU6500 매물 표기). 가동 평균은 렌즈 약 45 kg/h × 약 0.8 kWh/kg(서보 유압 비에너지 범위) + 금형 온조기. 멈춰도 배럴 히터·온조기가 온도를 지킨다'),
      health: health(1.05, 62, 48, 300, '서보 유압 펌프·구동 모터 베어링', 'II', 'assumed', '구동 모터 약 65 kW → ISO 10816-1 II등급. 신품 진동은 A/B 경계(1.12) 바로 아래. 베어링 실제 수명 약 3만 시간(가정)을 1/100로'),
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
      power: power(60, 55, 30, 'assumed', '클린 부스 공조(FFU)·플로 코터 펌프·130 °C 경화로(16 m) 합. 경화로와 클린룸 공조는 렌즈가 없어도 계속 돌아 대기·정지 전력이 크다'),
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
      warmup: warmup('SHORT'),
      desc: '열경화성 BMC로 리플렉터를 성형한다. 금형 약 150 °C, 경화 30~40초.',
      power: power(22, 13, 10, 'assumed', 'BMC 전용 약 300 t 유압기 가정. 배럴은 물로 식히고 금형(약 150 °C)을 전기 히터로 데워, 멈춰도 금형 가열 전력이 남는다'),
      health: health(1.05, 34, 46, 280, '유압 펌프·구동 모터 베어링', 'II', 'assumed', '구동 모터 약 30 kW → II등급. 충전재가 많은 BMC라 하중 변동이 커서 실제 수명 약 2.8만 시간(가정)을 1/100로'),
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
      power: power(34, 22, 10, 'weak', '헤드램프 리플렉터용 증착기 공개 사양: 평균 최대 36 kW·피크 50 kW (Ferrivatt VATT-1600). 대기 중에도 진공 펌프가 돈다'),
      health: health(0.68, 16, 62, 300, '루츠 진공 펌프 베어링·타이밍 기어', 'I', 'assumed', '루츠 펌프 약 7.5 kW → I등급. 루츠 펌프는 뜨겁게 돈다. 실제 수명 약 3만 시간(가정)을 1/100로'),
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
      warmup: warmup('SINK'),
      desc: 'PP-TD 하우징을 사출한다. 냉각이 고르지 않으면 렌즈와 붙는 플랜지가 휘어 기밀 불량의 원인이 된다.',
      power: power(44, 20, 15, 'weak', '850 t급 서보 유압 가정. 하우징 약 90 kg/h × 약 0.5 kWh/kg(서보 유압 비에너지 범위, 두꺼운 PP라 낮게) + 금형 온조기'),
      health: health(1.08, 74, 50, 300, '서보 유압 펌프·구동 모터 베어링', 'II', 'assumed', '구동 모터 약 75 kW → II등급 상한. 실제 수명 약 3만 시간(가정)을 1/100로'),
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
      code: 'HL-AS-01', name: '램프 조립 셀 (협동로봇)', kind: 'assembly-cell', step: 'ASSY', gate: true, pos: [2, -24], cycle: 70, cycleCv: 0.03, mtbf: 480, mttr: 15, grade: 'assumed',
      desc: '하우징에 증착 리플렉터, LED 모듈 2개(로우·하이빔), 레벨링 액추에이터를 체결하고 배선한다. 클린·ESD 환경.',
      power: power(2.2, 1.2, 0.4, 'weak', '협동로봇 2대(UR10e급 평균 약 350 W, 제조사 표기) + 체결기·팰릿 컨베이어·비전 (가정)'),
      health: health(0.66, 2.4, 40, 220, '협동로봇 관절 감속기·체결 스핀들', 'I', 'assumed', '왕복 구동부라 ISO 10816-1 적용 대상은 아니지만 소형기 I등급 구역을 빌려 쓴다. 실제 수명 약 2.2만 시간(가정)을 1/100로'),
      tags: [
        cy('screw_torque', '체결 토크', 'N·m', 1.2, 0.035, 'assumed', { lsl: 1.0, usl: 1.4, digits: 3 }),
        cy('conn_force', '커넥터 삽입력', 'N', 45, 2.5, 'assumed', { lsl: 35, usl: 60, digits: 1 }),
      ],
      attrs: [
        attr('aim_offset', '광원 정렬 편차', '°', 0, 0.03, [['attr:led_offset', 0.035]], 'assumed', { digits: 3, note: 'LED 장착 편차가 광축 편차로 이어진다고 가정' }),
      ],
      defects: [
        defect('SCREW', '체결 불량', 0.002, [['tag:screw_torque', 0, 1.0]], 'assumed', {
          ...fix('REWORK', 4, 0.95), note: '처리: 나사를 풀고 새 나사로 다시 체결한 뒤 재확인 (가정). BMS 하우징 체결(EM-HA-B)과 같은 기준',
        }),
        defect('CONN', '커넥터 미체결', 0.002, [['tag:conn_force', -1, 0.9]], 'assumed', {
          latent: true, ...fix('REWORK', 12, 0.9),
          note: 'EOL에서 걸린다. 처리: 커넥터 재체결. 렌즈를 붙인 뒤라 핫멜트를 데워 렌즈를 열어야 해 시간이 걸린다 (가정). 미러 조립(OSM-AS-01)과 같은 기준',
        }),
      ],
    },
    {
      code: 'HL-SL-01', name: '렌즈 핫멜트 실링·압착기', kind: 'sealer', step: 'SEAL', gate: true, pos: [12, -24], cycle: 66, cycleCv: 0.01, mtbf: 720, mttr: 20, grade: 'weak',
      desc: '하우징 홈에 핫멜트 실런트를 도포하고 코팅 렌즈를 눌러 붙인다. PP 하우징과 PC 렌즈는 극성 차이로 융착이 어려워 실런트를 쓴다.',
      power: power(5, 4, 3, 'assumed', '핫멜트 탱크·호스·건 히터(약 190 °C 유지) + 도포 로봇·압착기. 멈춰도 핫멜트를 녹여 둔다'),
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
      code: 'HL-LT-01', name: '기밀(리크) 검사기', kind: 'leak-tester', step: 'LEAK', gate: true, pos: [21, -24], cycle: 50, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'weak',
      desc: '램프 내부를 30 mbar로 가압하고 30초 동안 압력 강하를 잰다. 강하가 1,000 Pa(10 mbar)를 넘으면 누설.',
      power: power(0.6, 0.4, 0.15, 'assumed', '압력 감쇠식 시험기·지그 실린더 제어 (압축공기는 공용 유틸리티라 뺐다)'),
      tags: [
        ct('test_pressure', '시험 압력', 'Pa', 3000, 12, 'confirmed', { lsl: 2900, usl: 3100, tau: 30, digits: 0, note: 'NHTSA TSB: 최대 30 mbar' }),
      ],
      measures: [
        meas('leak_drop', '30 s 압력 강하', 'Pa', 250, 50, [['attr:seal_integrity', -120]], 'LEAK', 'confirmed', {
          usl: 1000, digits: 0, ...fix('REPAIR', 20, 0.75),
          note: 'NHTSA TSB: 30 s 동안 > 10 mbar 강하면 누설 (영향 계수는 가정). 처리: 핫멜트를 다시 데워 렌즈를 눌러 붙이고(재실링) 재검사. 부틸 핫멜트는 다시 녹일 수 있다 (시간·성공률 가정)',
        }),
      ],
    },
    {
      code: 'HL-PH-01', name: '배광·에이밍 검사기 (카메라식)', kind: 'photometry', step: 'PHOTO', gate: true, pos: [31, -24], cycle: 55, cycleCv: 0.01, mtbf: 1440, mttr: 20, grade: 'weak',
      desc: '암실에서 빔을 촬영해 컷오프 위치·각도·최대 광도를 잰다. UN R149·FMVSS 108 배광 기준의 양산용 축소판.',
      power: power(1.4, 0.8, 0.25, 'assumed', '암실 카메라·스크린 조명·시험 램프 점등·위치 조정 서보·PC'),
      tags: [
        ct('room_lux', '암실 조도', 'lux', 0.5, 0.05, 'assumed', { usl: 2, tau: 30, digits: 2 }),
      ],
      measures: [
        meas('aim_v', '수직 광축', '°', 0, 0.05, [['attr:aim_offset', 0.03]], 'AIM', 'assumed', {
          lsl: -0.3, usl: 0.3, digits: 3, ...fix('REWORK', 5, 0.95),
          note: '에이밍 정밀도 < ±0.2 cm (FORI) 참고. 처리: 램프의 에이밍 나사로 광축을 다시 맞추고 재검사 (재조정, 가정)',
        }),
        meas('max_kcd', '최대 광도', 'kcd', 38, 1.0, [['attr:reflectance', 1.1], ['attr:aim_offset', -0.15]], 'LUX', 'assumed', {
          lsl: 32, digits: 1, ...fix('MRB', 30, 0.6),
          note: '처리: 품질 판정(MRB). 규격 근처는 재측정 편차일 수 있고, 진짜 미달이면 리플렉터·LED 모듈을 바꿔야 해서 자동으로 정하지 않는다. 수리를 고르면 30분·성공 60 % (가정)',
        }),
      ],
    },
    {
      code: 'HL-EOL-01', name: 'EOL 점등·통신 검사기', kind: 'eol-tester', step: 'EOL', gate: true, pos: [41, -24], cycle: 40, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '전 기능을 점등하고 전류와 LIN 통신 응답을 확인한다. 커넥터 미체결과 LED 납땜 불량이 여기서 걸린다.',
      power: power(0.9, 0.6, 0.15, 'assumed', '시험 전원·LIN 인터페이스·PC'),
      tags: [ct('supply_v', '공급 전압', 'V', 13.5, 0.02, 'assumed', { tau: 30, digits: 2 })],
      measures: [
        meas('lamp_current', '소비 전류', 'A', 1.8, 0.025, [], 'ELEC', 'assumed', {
          lsl: 1.65, usl: 1.95, digits: 3, ...fix('REPAIR', 20, 0.75), note: '처리: 원인을 찾아 LED 모듈·배선을 바꾸고 재시험 (렌즈 개봉, 가정)',
        }),
      ],
      detects: [{ defect: 'CONN', prob: 0.98 }, { defect: 'COLD', prob: 0.9 }],
    },
    {
      code: 'HL-PK-01', name: '포장·라벨 셀 (협동로봇)', kind: 'packer', step: 'PACK', gate: true, pos: [50, -24], cycle: 25, cycleCv: 0.03, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '완제품에 출하 라벨을 붙이고 전용 용기에 적재한다. 가득 차면 AMR이 완제품 창고로 옮긴다.',
      power: power(1, 0.5, 0.15, 'weak', '협동로봇 1대(UR10e급 평균 약 350 W, 제조사 표기) + 라벨 프린터·컨베이어 (가정)'),
      health: health(0.64, 1.6, 37, 350, '협동로봇 관절 감속기·적재 컨베이어 감속기', 'I', 'assumed', '하중이 가벼워 가장 오래 간다. 실제 수명 약 3.5만 시간(가정)을 1/100로'),
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
