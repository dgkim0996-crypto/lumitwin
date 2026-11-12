import type { LineDef } from '../types';
import { attr, ct, cy, defect, meas } from './build';

/**
 * B베이 — 전장 모듈 라인 (SMT)
 * 근거: docs/research/02-electronics-smt-process.md
 * LED 레인은 헤드램프용 LED 광원 모듈을 만들어 AMR로 A베이에 보내고, BMS 레인은 12V 보조배터리 BMS 완제품을 만든다.
 * LED 레인 끝의 PCB 라우터는 공개 사례(램프 PCB 라우터 공정의 양팔 이동 협동로봇)를 반영했다.
 */
export const EM: LineDef = {
  code: 'EM',
  name: '전장 모듈 라인 (LED·BMS)',
  short: '전장',
  color: '#4fb3ff',
  desc: 'LED 레인은 헤드램프 LED 모듈을, BMS 레인은 12V 보조배터리 BMS를 만든다. 인쇄 → SPI → 마운터 → 리플로우 → AOI → ICT → 코팅 → FCT → EOL.',
  product: { code: 'BMS-12V', name: '12V 보조배터리 BMS' },
  taktSec: 45,
  bay: { x0: -58, x1: 58, z0: -8, z1: 10 },
  finalStep: 'BMS_PACK',
  steps: [
    { code: 'LED_PRINT', name: 'LED 솔더 인쇄', inputs: [{ material: 'MCPCB', qty: 1 }, { material: 'PASTE', qty: 1 }], buffer: 4, item: 'LED_PCB', itemName: 'LED 기판', serial: 'new', prefix: 'LM' },
    { code: 'LED_MOUNT', name: 'LED 마운트', inputs: [{ step: 'LED_PRINT', qty: 1 }, { material: 'LED_PKG', qty: 1 }], buffer: 4, item: 'LED_PCB', itemName: 'LED 기판', serial: 'keep' },
    { code: 'LED_REFLOW', name: 'LED 리플로우', inputs: [{ step: 'LED_MOUNT', qty: 1 }], buffer: 6, item: 'LED_PCB', itemName: 'LED 기판', serial: 'keep' },
    { code: 'LED_AOI', name: 'LED AOI', inputs: [{ step: 'LED_REFLOW', qty: 1 }], buffer: 6, item: 'LED_PCB', itemName: 'LED 기판', serial: 'keep' },
    { code: 'LED_ROUTE', name: 'PCB 라우팅·분리', inputs: [{ step: 'LED_AOI', qty: 1 }], buffer: 80, item: 'LED_MOD', itemName: 'LED 광원 모듈', serial: 'keep' },

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
      code: 'EM-PR-L', name: 'LED 솔더 인쇄기', kind: 'printer', step: 'LED_PRINT', pos: [-45, -4], cycle: 28, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: 'MCPCB에 스텐실로 SAC305 솔더 페이스트를 인쇄한다.',
      tags: [
        ct('squeegee_speed', '스퀴지 속도', 'mm/s', 40, 0.4, 'weak', { lsl: 20, usl: 80, tau: 60, digits: 1, note: '20~80 mm/s (미세 피치 20~40)' }),
        ct('print_pressure', '인쇄 압력', 'N/mm', 0.4, 0.008, 'weak', { lsl: 0.3, usl: 0.5, tau: 60, digits: 3 }),
      ],
      attrs: [attr('paste_vol', '페이스트 체적', '%', 100, 4, [['tag:print_pressure', 1.5], ['tag:squeegee_speed', -1.2]], 'weak', { digits: 1 })],
    },
    {
      code: 'EM-MT-L', name: 'LED 마운터', kind: 'mounter', step: 'LED_MOUNT', pos: [-41.5, -4], cycle: 30, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: 'LED 패키지를 장착한다. 장착 정밀도 ±35 µm(3σ)급. 노즐이 닳으면 장착 편차가 커져 헤드램프 광축이 틀어진다.',
      tags: [
        ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 }),
        cy('feeder_err', '피더 경고', '회', 0, 0, 'assumed', { digits: 0 }),
      ],
      attrs: [attr('led_offset', 'LED 장착 편차', 'µm', 12, 4, [['tag:nozzle_vacuum', 1.5]], 'confirmed', { digits: 1, note: 'Yamaha YSM20R: ±0.035 mm (3σ)' })],
      defects: [defect('MISSING', '부품 누락', 0.001, [['tag:nozzle_vacuum', 1, 1.0]], 'assumed', { latent: true })],
    },
    {
      code: 'EM-RF-L', name: 'LED 리플로우 오븐', kind: 'reflow', step: 'LED_REFLOW', pos: [-35, -4], cycle: 300, cycleCv: 0.005, slots: 10, mtbf: 1440, mttr: 30, grade: 'confirmed',
      desc: 'MCPCB용 리플로우. 피크 235~245 °C, 피크 근처 20~40초 (LED 제조사 권장).',
      tags: [
        ct('peak_temp', '피크 온도', '°C', 240, 1.0, 'confirmed', { lsl: 235, usl: 250, tau: 180, digits: 1, note: 'Cree: SAC 피크 235~245 °C' }),
        ct('tal', 'TAL(액상선 이상 시간)', 's', 62, 2.0, 'weak', { lsl: 40, usl: 80, tau: 180, digits: 1 }),
        ct('o2_ppm', '질소 O₂ 농도', 'ppm', 900, 60, 'weak', { usl: 1500, tau: 120, digits: 0 }),
      ],
      attrs: [attr('void_pct', '솔더 보이드율', '%', 8, 1.5, [['tag:peak_temp', -0.6], ['tag:tal', -0.5]], 'weak', { digits: 1, note: 'MCPCB 보이드↑ → 열저항↑' })],
      defects: [defect('COLD', '냉납', 0.0015, [['tag:peak_temp', -1, 1.0], ['tag:tal', -1, 0.8]], 'weak', { latent: true })],
    },
    {
      code: 'EM-AOI-L', name: 'LED AOI', kind: 'aoi', step: 'LED_AOI', pos: [-29, -4], cycle: 25, cycleCv: 0.01, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '부품 유무·극성·위치·납땜 외관을 카메라로 판정한다. 냉납은 외관으로 일부만 보인다.',
      tags: [ct('light_level', '조명 밝기', '%', 100, 0.5, 'assumed', { tau: 60, digits: 1 })],
      detects: [{ defect: 'MISSING', prob: 0.99 }, { defect: 'COLD', prob: 0.45 }],
    },
    {
      code: 'EM-RT-L', name: 'PCB 라우터 + 양팔 이동 협동로봇', kind: 'router-cobot', step: 'LED_ROUTE', pos: [-22.5, -4], cycle: 60, cycleCv: 0.05, batch: 4, mtbf: 900, mttr: 15, grade: 'confirmed',
      desc: 'LED 기판 4연 어레이를 라우터로 잘라 모듈로 나눈다. 양팔 이동 협동로봇이 투입·분리·적재·양품/불량 분류를 맡는다 (공개 사례 반영).',
      tags: [
        ct('spindle_rpm', '스핀들 회전수', 'rpm', 40000, 250, 'assumed', { lsl: 35000, tau: 60, digits: 0 }),
        ct('dust_dp', '집진 차압', 'kPa', 1.2, 0.05, 'assumed', { usl: 2.0, tau: 120, digits: 2 }),
      ],
      defects: [defect('EDGE', '가장자리 균열', 0.001, [['tag:spindle_rpm', -1, 0.6]], 'assumed')],
    },

    // ── BMS 레인 (z = 4) ──
    {
      code: 'EM-LM-B', name: 'DMC 레이저 마커', kind: 'laser-marker', step: 'BMS_MARK', pos: [-51, 4], cycle: 18, cycleCv: 0.01, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: 'PCB에 2D 데이터매트릭스 코드를 새겨 시리얼을 붙인다. 이후 모든 공정 이력이 이 코드로 이어진다.',
      tags: [ct('laser_power', '레이저 출력', 'W', 20, 0.15, 'assumed', { tau: 60, digits: 2 })],
      defects: [defect('UNREAD', '코드 판독 불가', 0.0005, [['tag:laser_power', -1, 0.8]], 'assumed')],
    },
    {
      code: 'EM-PR-B', name: '솔더 인쇄기', kind: 'printer', step: 'BMS_PRINT', pos: [-47, 4], cycle: 30, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: '스텐실로 솔더 페이스트를 인쇄한다. 개구부가 막히면 페이스트가 덜 나와 미납·냉납으로 이어진다.',
      tags: [
        ct('squeegee_speed', '스퀴지 속도', 'mm/s', 40, 0.4, 'weak', { lsl: 20, usl: 80, tau: 60, digits: 1 }),
        ct('print_pressure', '인쇄 압력', 'N/mm', 0.4, 0.008, 'weak', { lsl: 0.3, usl: 0.5, tau: 60, digits: 3 }),
        ct('snap_off', '판 분리 속도', 'mm/s', 2.0, 0.05, 'weak', { lsl: 1, usl: 3, tau: 60, digits: 2 }),
      ],
      attrs: [attr('paste_vol', '페이스트 체적', '%', 100, 4, [['tag:print_pressure', 1.5], ['tag:squeegee_speed', -1.2]], 'weak', { digits: 1 })],
      defects: [defect('BRIDGE', '솔더 브리지', 0.0015, [['tag:print_pressure', 1, 0.9], ['attr:paste_vol', 1, 0.8]], 'weak', { latent: true })],
    },
    {
      code: 'EM-SPI-B', name: '3D SPI', kind: 'spi', step: 'BMS_SPI', pos: [-43.5, 4], cycle: 25, cycleCv: 0.01, mtbf: 2880, mttr: 10, grade: 'weak',
      desc: '인쇄된 페이스트의 높이·체적을 3D로 잰다. 체적 70~130 %를 벗어나면 불량.',
      tags: [ct('cal_offset', '높이 보정값', 'µm', 0, 0.5, 'assumed', { tau: 600, digits: 2 })],
      measures: [meas('paste_volume', '페이스트 체적', '%', 100, 1.0, [['attr:paste_vol', 4]], 'PASTE', 'weak', { lsl: 70, usl: 130, digits: 1, note: '가장 흔한 판정 기준 70~130 %' })],
      detects: [{ defect: 'BRIDGE', prob: 0.3 }],
    },
    {
      code: 'EM-MT-B1', name: '칩 마운터', kind: 'mounter', step: 'BMS_MOUNT1', pos: [-40, 4], cycle: 36, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: '저항·커패시터 같은 칩 부품을 고속 장착한다 (보드당 약 250점 가정).',
      tags: [ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 })],
      defects: [
        defect('MISSING', '부품 누락', 0.0008, [['tag:nozzle_vacuum', 1, 1.0]], 'assumed', { latent: true }),
        defect('SHIFT', '부품 틀어짐', 0.001, [['tag:nozzle_vacuum', 1, 0.7]], 'assumed', { latent: true }),
      ],
    },
    {
      code: 'EM-MT-B2', name: 'IC 마운터', kind: 'mounter', step: 'BMS_MOUNT2', pos: [-36.5, 4], cycle: 38, cycleCv: 0.02, mtbf: 600, mttr: 15, grade: 'confirmed',
      desc: 'MCU·셀 모니터링 AFE·CAN 트랜시버 같은 IC를 장착한다.',
      tags: [ct('nozzle_vacuum', '노즐 진공', 'kPa', -80, 1.2, 'assumed', { usl: -65, tau: 60, digits: 1 })],
      defects: [defect('SHIFT', '부품 틀어짐', 0.0008, [['tag:nozzle_vacuum', 1, 0.7]], 'assumed', { latent: true })],
    },
    {
      code: 'EM-RF-B', name: '질소 리플로우 오븐', kind: 'reflow', step: 'BMS_REFLOW', pos: [-29, 4], cycle: 320, cycleCv: 0.005, slots: 8, mtbf: 1440, mttr: 30, grade: 'weak',
      desc: 'SAC305 프로파일: 소크 150→180 °C 약 120초, 피크 245 °C, TAL 40~80초. 피크·TAL이 낮으면 냉납이 생기는데 외관(AOI)으로는 절반 정도만 보인다.',
      tags: [
        ct('soak_temp', '소크 온도', '°C', 175, 1.0, 'weak', { lsl: 150, usl: 190, tau: 180, digits: 1 }),
        ct('peak_temp', '피크 온도', '°C', 245, 1.0, 'weak', { lsl: 240, usl: 255, tau: 180, digits: 1, note: 'SAC305 피크 245~255 °C' }),
        ct('tal', 'TAL(액상선 이상 시간)', 's', 60, 2.0, 'weak', { lsl: 40, usl: 80, tau: 180, digits: 1 }),
        ct('o2_ppm', '질소 O₂ 농도', 'ppm', 800, 50, 'weak', { usl: 1000, tau: 120, digits: 0 }),
      ],
      attrs: [attr('joint_q', '솔더 접합 품질', '점', 100, 1.5, [['tag:peak_temp', 0.35], ['tag:tal', 0.25]], 'weak', { digits: 1 })],
      defects: [
        defect('COLD', '냉납', 0.0015, [['tag:peak_temp', -1, 0.5], ['tag:tal', -1, 0.35]], 'weak', { latent: true }),
        defect('TOMB', '툼스톤', 0.0008, [['tag:o2_ppm', -1, 0.3]], 'weak', { latent: true }),
      ],
    },
    {
      code: 'EM-AOI-B', name: 'AOI', kind: 'aoi', step: 'BMS_AOI', pos: [-22, 4], cycle: 30, cycleCv: 0.01, mtbf: 1440, mttr: 10, grade: 'assumed',
      desc: '부품 누락·틀어짐·브리지·툼스톤을 외관으로 찾는다. 냉납 검출률은 약 35 %로 가정.',
      tags: [ct('light_level', '조명 밝기', '%', 100, 0.5, 'assumed', { tau: 60, digits: 1 })],
      detects: [{ defect: 'MISSING', prob: 0.99 }, { defect: 'SHIFT', prob: 0.95 }, { defect: 'BRIDGE', prob: 0.9 }, { defect: 'TOMB', prob: 0.95 }, { defect: 'COLD', prob: 0.35 }],
    },
    {
      code: 'EM-ICT-B', name: 'ICT 인서킷 테스터', kind: 'ict', step: 'BMS_ICT', pos: [-17.5, 4], cycle: 42, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '핀으로 회로를 짚어 단락·개방·부품값을 확인한다.',
      tags: [ct('fixture_count', '지그 접촉 횟수', '천회', 12, 0.01, 'assumed', { tau: 3600, digits: 1 })],
      detects: [{ defect: 'BRIDGE', prob: 0.99 }, { defect: 'MISSING', prob: 0.99 }, { defect: 'COLD', prob: 0.6 }, { defect: 'SHIFT', prob: 0.7 }],
    },
    {
      code: 'EM-CC-B', name: '선택 컨포멀 코팅기 + UV 검사', kind: 'coater', step: 'BMS_COAT', pos: [-11, 4], cycle: 40, cycleCv: 0.02, mtbf: 900, mttr: 20, grade: 'weak',
      desc: '아크릴 코팅을 선택 도포하고 경화한 뒤 UV 조명으로 도포 유무를 본다. UV 검사는 두께를 재지 못한다.',
      tags: [
        ct('spray_pressure', '스프레이 압력', 'MPa', 0.25, 0.006, 'assumed', { lsl: 0.2, usl: 0.32, tau: 60, digits: 3 }),
        ct('cure_temp', '경화 온도', '°C', 80, 0.8, 'assumed', { lsl: 70, usl: 90, tau: 180, digits: 1 }),
        cy('coat_thick', '코팅 두께', 'µm', 50, 4, 'weak', { lsl: 25, usl: 127, digits: 1, note: '25~127 µm (1~5 mil)' }),
      ],
      attrs: [attr('coat_q', '코팅 품질', '점', 100, 1.5, [['tag:coat_thick', 0.6], ['tag:spray_pressure', -0.6], ['tag:cure_temp', 0.5]], 'weak', { digits: 1 })],
      defects: [
        defect('BUBBLE', '코팅 기포', 0.002, [['tag:spray_pressure', 1, 0.9]], 'weak'),
        defect('NOCOAT', '코팅 미도포', 0.001, [['tag:coat_thick', -1, 1.0]], 'weak'),
      ],
    },
    {
      code: 'EM-FCT-B1', name: 'FCT 기능 시험기 #1', kind: 'fct', step: 'BMS_FCT', pos: [-4, 2.2], cycle: 85, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '전원을 넣고 셀 전압 측정 정확도, 전류, 온도, 밸런싱, CAN 통신을 시험한다.',
      tags: [ct('ref_v', '기준 전압원', 'V', 3.7, 0.0005, 'assumed', { tau: 600, digits: 4 })],
      measures: [
        meas('cell_v_err', '셀 전압 측정 오차', 'mV', 1.2, 0.4, [['attr:joint_q', -0.7]], 'FUNC', 'assumed', { usl: 5, digits: 2, note: 'AFE ±1.5 mV(TI BQ79616-Q1) → 판정 ±5 mV 가정' }),
        meas('sleep_ua', '암전류', 'µA', 85, 5, [], 'CURRENT', 'assumed', { usl: 120, digits: 1 }),
      ],
      detects: [{ defect: 'COLD', prob: 0.9 }, { defect: 'SHIFT', prob: 0.8 }],
    },
    {
      code: 'EM-FCT-B2', name: 'FCT 기능 시험기 #2', kind: 'fct', step: 'BMS_FCT', pos: [-4, 5.8], cycle: 85, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: 'FCT #1과 같은 시험기. 택트를 맞추려고 두 대를 병렬로 둔다.',
      tags: [ct('ref_v', '기준 전압원', 'V', 3.7, 0.0005, 'assumed', { tau: 600, digits: 4 })],
      measures: [
        meas('cell_v_err', '셀 전압 측정 오차', 'mV', 1.2, 0.4, [['attr:joint_q', -0.7]], 'FUNC', 'assumed', { usl: 5, digits: 2 }),
        meas('sleep_ua', '암전류', 'µA', 85, 5, [], 'CURRENT', 'assumed', { usl: 120, digits: 1 }),
      ],
      detects: [{ defect: 'COLD', prob: 0.9 }, { defect: 'SHIFT', prob: 0.8 }],
    },
    {
      code: 'EM-HA-B', name: '하우징 체결 셀', kind: 'screw-cell', step: 'BMS_HOUSING', pos: [3, 4], cycle: 40, cycleCv: 0.02, mtbf: 720, mttr: 12, grade: 'weak',
      desc: '코팅된 기판을 하우징에 넣고 M3 나사 4개를 자동 드라이버로 체결한다.',
      tags: [cy('screw_torque', '체결 토크', 'N·m', 1.05, 0.03, 'weak', { lsl: 0.9, usl: 1.2, digits: 3, note: 'M3 금속 나사 약 1.0~1.1 N·m' })],
      defects: [defect('SCREW', '체결 불량', 0.0015, [['tag:screw_torque', 0, 1.0]], 'weak')],
    },
    {
      code: 'EM-EOL-B', name: 'EOL 시험기', kind: 'eol-tester', step: 'BMS_EOL', pos: [10, 4], cycle: 42, cycleCv: 0.01, mtbf: 1440, mttr: 15, grade: 'assumed',
      desc: '완제품 상태에서 절연저항, CAN 진단 응답, 펌웨어·DTC를 확인한다.',
      tags: [ct('test_v', '절연 시험 전압', 'V', 500, 1.5, 'assumed', { tau: 60, digits: 0 })],
      measures: [meas('insulation', '절연저항', 'MΩ', 800, 50, [['attr:coat_q', 70]], 'INSUL', 'assumed', { lsl: 100, digits: 0 })],
      detects: [{ defect: 'COLD', prob: 0.95 }],
    },
    {
      code: 'EM-PK-B', name: 'BMS 포장', kind: 'packer', step: 'BMS_PACK', pos: [17, 4], cycle: 20, cycleCv: 0.03, mtbf: 2880, mttr: 10, grade: 'assumed',
      desc: 'ESD 트레이에 담아 라벨을 붙인다.',
      tags: [cy('label_ok', '라벨 판독', '', 1, 0, 'assumed', { digits: 0 })],
    },
  ],
  conveyors: [
    [[-47, -4], [-17, -4]],
    [[-53, 4], [-7, 4]],
    [[-7, 4], [-6, 2.2], [-2, 2.2], [-1, 4]],
    [[-7, 4], [-6, 5.8], [-2, 5.8], [-1, 4]],
    [[-1, 4], [20, 4]],
  ],
};
