import type { FactoryDef, LineDef, MaterialDef, ScenarioDef, StationDef } from '../types';
import { EM } from './em';
import { HL } from './hl';
import { OSM } from './osm';

const MATERIALS: MaterialDef[] = [
  { code: 'PC_RESIN', name: 'PC 레진 (광학 등급)', supplier: '가상 화학 A', lotSize: 1500 },
  { code: 'BMC', name: 'BMC 컴파운드', supplier: '가상 화학 B', lotSize: 1200 },
  { code: 'PP_TD', name: 'PP-TD 컴파운드', supplier: '가상 화학 A', lotSize: 2000 },
  { code: 'LEVELER', name: '레벨링 액추에이터', supplier: '가상 부품 C', lotSize: 400 },
  { code: 'HOTMELT', name: '부틸 핫멜트 실런트', supplier: '가상 화학 D', lotSize: 600 },
  { code: 'MCPCB', name: 'LED용 MCPCB', supplier: '가상 PCB E', lotSize: 800 },
  { code: 'LED_PKG', name: 'LED 패키지', supplier: '가상 반도체 F', lotSize: 1000 },
  { code: 'PASTE', name: 'SAC305 솔더 페이스트', supplier: '가상 소재 G', lotSize: 500 },
  { code: 'PCB_BMS', name: 'BMS PCB', supplier: '가상 PCB E', lotSize: 500 },
  { code: 'AFE_IC', name: '셀 모니터링 AFE IC', supplier: '가상 반도체 H', lotSize: 1000 },
  { code: 'COATING', name: '아크릴 컨포멀 코팅액', supplier: '가상 소재 G', lotSize: 800 },
  { code: 'BMS_CASE', name: 'BMS 하우징', supplier: '가상 부품 C', lotSize: 600 },
  { code: 'ASA', name: 'ASA 레진', supplier: '가상 화학 A', lotSize: 2000 },
  { code: 'PAINT', name: '베이스·클리어 도료', supplier: '가상 도료 I', lotSize: 400 },
  { code: 'PA6GF', name: 'PA6-GF30', supplier: '가상 화학 B', lotSize: 1500 },
  { code: 'MOTOR', name: '폴딩 모터', supplier: '가상 부품 J', lotSize: 500 },
  { code: 'GEARSET', name: '웜기어·클러치 세트', supplier: '가상 부품 J', lotSize: 500 },
  { code: 'GREASE', name: '기어 그리스', supplier: '가상 소재 K', lotSize: 2000 },
  { code: 'GLASS', name: '히팅 미러 글래스', supplier: '가상 유리 L', lotSize: 400 },
  { code: 'TURN_LED', name: '턴시그널 LED 모듈', supplier: '가상 부품 C', lotSize: 600 },
  { code: 'HARNESS', name: '미러 하네스', supplier: '가상 부품 M', lotSize: 600 },
];

const SCENARIOS: ScenarioDef[] = [
  {
    id: 'HL-MOLD-COOL', name: '렌즈 금형 온조기 이상', line: 'HL',
    summary: '렌즈 사출 금형 온조기의 히터가 약해져 금형온도가 서서히 내려간다.',
    effects: [{ station: 'HL-IM-L1', target: 'tag', key: 'mold_temp', mode: 'drift', rate: -0.15, limit: -6 }],
    symptom: '한참 뒤 하드코팅 라인에서 코팅 크랙이 늘어난다. 사출 공정 자체의 불량은 조금만 는다.',
    rootCause: '렌즈 사출 금형온도 저하 → 잔류응력 증가 → 하드코팅 용제에 의한 크랙',
    howToFind: '크랙 난 렌즈의 시리얼로 사출 이력을 열어 금형온도를 본다. 정상 렌즈와 금형온도 분포를 비교한다.',
  },
  {
    id: 'HL-DRYER-DEW', name: '제습 건조기 재생 히터 고장', line: 'HL',
    summary: '렌즈용 PC 레진 건조기의 제습 성능이 떨어져 이슬점이 오른다.',
    effects: [{ station: 'HL-DR-01', target: 'tag', key: 'dew_point', mode: 'drift', rate: 0.5, limit: 22 }],
    symptom: '렌즈 사출에서 은줄 불량이 늘어난다.',
    rootCause: '건조기 이슬점 상승 → 레진 수분 증가 → 은줄',
    howToFind: '은줄 불량 시점과 건조기 이슬점·레진 수분 추세를 겹쳐 본다.',
  },
  {
    id: 'HL-VAC-LEAK', name: '증착 챔버 미세 누설', line: 'HL',
    summary: '진공증착기 도어 실링이 손상돼 챔버 압력이 잘 내려가지 않는다.',
    effects: [
      { station: 'HL-VM-01', target: 'tag', key: 'chamber_pressure', mode: 'drift', rate: 0.003, limit: 0.1 },
      { station: 'HL-VM-01', target: 'tag', key: 'pumpdown', mode: 'drift', rate: 0.1, limit: 6 },
      { station: 'HL-VM-01', target: 'cycle', mode: 'drift', rate: 6, limit: 360 },
    ],
    symptom: '증착 사이클이 길어져 조립 라인이 리플렉터를 기다리고, 백화 불량이 는다.',
    rootCause: '챔버 누설 → 기저 압력 상승·펌프다운 지연',
    howToFind: '증착기 OEE의 성능 손실과 펌프다운 시간 추세를 본다.',
  },
  {
    id: 'HL-LEAK-GAUGE', name: '리크 테스터 영점 드리프트', line: 'HL',
    summary: '기밀 검사기 압력 센서의 영점이 틀어져 측정값만 높게 나온다.',
    effects: [{ station: 'HL-LT-01', target: 'measure', key: 'leak_drop', mode: 'drift', rate: 12, limit: 650 }],
    symptom: '기밀 NG가 급증한다. 하지만 실링 공정 데이터는 정상이다.',
    rootCause: '계측기 문제(MSA). 제품은 정상인데 측정이 틀렸다',
    howToFind: 'NG 제품의 실링 완전성·핫멜트 조건이 정상인지 보고, 마스터 시료로 계측기를 점검한다.',
  },
  {
    id: 'EM-REFLOW-HEATER', name: '리플로우 존 히터 열화', line: 'EM',
    summary: 'BMS 레인 리플로우 오븐의 피크 존 히터가 약해진다.',
    effects: [
      { station: 'EM-RF-B', target: 'tag', key: 'peak_temp', mode: 'drift', rate: -0.2, limit: -9 },
      { station: 'EM-RF-B', target: 'tag', key: 'tal', mode: 'drift', rate: -0.4, limit: -18 },
    ],
    symptom: 'AOI는 대부분 통과하는데 ICT·FCT 불량이 늘어난다.',
    rootCause: '피크 온도·TAL 저하 → 냉납 (외관으로는 잘 안 보인다)',
    howToFind: 'FCT 불량 기판의 리플로우 이력에서 피크 온도·TAL을 본다.',
  },
  {
    id: 'EM-STENCIL-CLOG', name: '스텐실 개구부 막힘', line: 'EM',
    summary: 'BMS 인쇄기 스텐실 세척 주기가 길어져 개구부가 막힌다.',
    effects: [{ station: 'EM-PR-B', target: 'attr', key: 'paste_vol', mode: 'drift', rate: -0.5, limit: -28 }],
    symptom: 'SPI에서 페이스트 체적 불량이 늘어난다.',
    rootCause: '스텐실 막힘 → 페이스트 체적 감소',
    howToFind: 'SPI 체적 관리도에서 하향 추세를 확인하고 인쇄기 세척 이력을 본다.',
  },
  {
    id: 'EM-NOZZLE-WEAR', name: 'LED 마운터 노즐 마모', line: 'EM',
    summary: '전장 라인 LED 레인 마운터의 노즐이 닳아 장착 편차가 커진다.',
    effects: [{ station: 'EM-MT-L', target: 'attr', key: 'led_offset', mode: 'drift', rate: 0.5, limit: 30 }],
    symptom: '전장 라인은 조용한데, 헤드램프 라인 배광 검사에서 광축 불량이 늘어난다.',
    rootCause: '다른 라인(LED 레인 마운터)의 장착 편차 → LED 모듈 위치 편차 → 광축 틀어짐',
    howToFind: '광축 불량 램프의 부품 계보에서 LED 모듈 시리얼을 따라가 마운터 장착 편차를 본다.',
  },
  {
    id: 'OSM-GREASE', name: '그리스 디스펜서 막힘', line: 'OSM',
    summary: '액추에이터 조립 셀의 그리스 디스펜서 노즐이 막혀 도포량이 준다.',
    effects: [{ station: 'OSM-AC-01', target: 'tag', key: 'grease_mg', mode: 'drift', rate: -0.6, limit: -30 }],
    symptom: '기능 검사에서 작동 소음·모터 전류 불량이 늘어난다.',
    rootCause: '그리스 부족 → 기어 마찰 증가',
    howToFind: '소음 불량 미러의 액추에이터 이력에서 그리스 도포량을 본다.',
  },
  {
    id: 'OSM-GEAR-LOT', name: '웜기어 세트 불량 LOT 입고', line: 'OSM',
    summary: '협력사의 웜기어·클러치 세트 한 LOT가 치형 가공 편차로 들어온다. 켜는 순간 그 LOT로 바뀌고, 끄면 격리한다.',
    effects: [{ station: 'OSM-AC-01', target: 'attr', key: 'gear_friction', mode: 'step', amount: 0.22, lot: 'GEARSET' }],
    symptom: '기능 검사에서 작동 소음 불량이 갑자기 는다. 설비 조건(그리스·토크)은 모두 정상이다.',
    rootCause: '특정 자재 LOT 불량 (설비가 아니라 입고 자재 문제)',
    howToFind: '추적 화면의 LOT 품질에서 같은 시기에 쓴 웜기어 LOT끼리 불량률을 비교하고, 그 LOT의 회수 범위(조립된 완성품)를 뽑는다.',
  },
  {
    id: 'OSM-BOOTH-HUMID', name: '도장 부스 공조 이상', line: 'OSM',
    summary: '도장 부스 공조기 제습이 멈춰 습도가 오른다.',
    effects: [{ station: 'OSM-PT-01', target: 'tag', key: 'booth_humidity', mode: 'drift', rate: 0.4, limit: 22 }],
    symptom: '도장 핀홀 불량이 늘어난다.',
    rootCause: '부스 습도 상승',
    howToFind: '핀홀 불량 추세와 부스 습도를 겹쳐 본다.',
  },
];

export const LINES: LineDef[] = [HL, EM, OSM];

export const FACTORY: FactoryDef = {
  name: 'LumiTwin 가상 공장',
  site: '가상 대구 사업장',
  disclaimer: '공개 자료를 바탕으로 만든 가상 공장입니다. 특정 회사의 실제 라인·수치와 무관합니다.',
  size: [140, 80],
  materials: MATERIALS,
  lines: LINES,
  transfers: [
    { code: 'T-LED', name: 'LED 모듈 → 헤드램프 조립', from: { line: 'EM', step: 'LED_ROUTE' }, to: { line: 'HL', step: 'ASSY' }, lot: 20, amr: 'AMR-01', path: [[-17, -4], [-17, -10], [2, -10], [2, -19.5]] },
    { code: 'T-HL-FG', name: '헤드램프 → 완제품 창고', from: { line: 'HL', step: 'PACK' }, to: { warehouse: 'FG' }, lot: 12, amr: 'AMR-02', path: [[54, -24], [56, -24], [56, -10], [61, -10]] },
    { code: 'T-EM-FG', name: 'BMS → 완제품 창고', from: { line: 'EM', step: 'BMS_PACK' }, to: { warehouse: 'FG' }, lot: 24, amr: 'AMR-03', path: [[20, 4], [20, 12], [61, 12]] },
    { code: 'T-OSM-FG', name: '사이드미러 → 완제품 창고', from: { line: 'OSM', step: 'PACK' }, to: { warehouse: 'FG' }, lot: 16, amr: 'AMR-04', path: [[27, 27], [30, 27], [30, 12.6], [61, 12.6]] },
  ],
  amrs: [
    { code: 'AMR-01', name: '이동식 협동로봇 #1', home: [-17, -4], speed: 1.0, handleSec: 90, grade: 'weak', desc: 'LED 모듈을 전장 라인에서 헤드램프 조립 셀로 옮긴다. 협동로봇이 트레이를 싣고 내린다.' },
    { code: 'AMR-02', name: '이동식 협동로봇 #2', home: [54, -24], speed: 1.0, handleSec: 60, grade: 'confirmed', desc: '포장된 헤드램프를 완제품 창고로 옮기고 라벨 정보를 등록한다 (공개 사례 반영).' },
    { code: 'AMR-03', name: '이동식 협동로봇 #3', home: [20, 4], speed: 1.0, handleSec: 60, grade: 'assumed', desc: '포장된 BMS를 완제품 창고로 옮긴다.' },
    { code: 'AMR-04', name: '이동식 협동로봇 #4', home: [27, 27], speed: 1.0, handleSec: 60, grade: 'assumed', desc: '포장된 사이드미러를 완제품 창고로 옮긴다.' },
  ],
  scenarios: SCENARIOS,
  warehouses: [
    { code: 'RM', name: '자재 창고', pos: [-64, 0], size: [10, 70] },
    { code: 'FG', name: '완제품 창고', pos: [65, 0], size: [8, 70] },
  ],
  aisles: [
    { x0: -58, x1: 62, z0: -12, z1: -8 },
    { x0: -58, x1: 62, z0: 10, z1: 14 },
  ],
};

/** 설비 코드 → 설비 정의 */
export const STATIONS: Record<string, StationDef & { line: LineDef['code'] }> = Object.fromEntries(
  LINES.flatMap((line) => line.stations.map((s) => [s.code, { ...s, line: line.code }])),
);

/**
 * 불량 코드 → 이름. 설비 불량 정의를 먼저 쓰고, 측정 규격 이탈은 "측정명 규격 이탈"로 채운다.
 * 코드는 공장 전체에서 하나의 뜻이어야 한다 (예: BMS 암전류 CURRENT와 미러 모터 전류 MOTOR_CURRENT는 다른 코드)
 */
export const DEFECT_NAMES: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const s of Object.values(STATIONS)) for (const d of s.defects ?? []) out[d.code] ??= d.name;
  for (const s of Object.values(STATIONS)) for (const m of s.measures ?? []) out[m.defect] ??= `${m.name} 규격 이탈`;
  return out;
})();