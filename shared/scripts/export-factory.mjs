// 빌드한 공장 정의를 dist/factory.json으로 내보낸다. Python 시뮬레이터(sim/)가 이 파일을 읽는다.
// P9: 실행 MES 규칙(mes.ts)을 계산해 둔 표도 `mes` 아래에 같이 싣는다. 시뮬레이터가 TS 규칙을 다시 짜지 않고 이 표를 읽는다
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const mod = await import(`${pathToFileURL(join(dist, 'index.mjs')).href}?t=${Date.now()}`);

/** 설비별로 날 수 있는 불량 코드 (자기 불량 + 측정 규격 이탈 + 검출하는 잠재 불량) */
function defectCodes(s) {
  return [...new Set([...(s.defects ?? []).filter((d) => !d.latent).map((d) => d.code), ...(s.measures ?? []).map((m) => m.defect), ...(s.detects ?? []).map((d) => d.defect)])];
}

const stations = {};
const ngRule = {};
const pmMinutes = {};
for (const line of mod.FACTORY.lines) {
  for (const s of line.stations) {
    stations[s.code] = {
      faRequired: mod.faRequired(s),
      inspection: mod.isInspection(s),
      productScope: mod.inProductScope(line, s.step),
      prevStep: mod.prevStep(line, s.step) ?? null,
    };
    ngRule[s.code] = Object.fromEntries(defectCodes(s).map((d) => [d, mod.defaultDisposition(line.code, s.code, d)]));
    pmMinutes[s.code] = mod.PM_PLANS[s.kind]?.minutes ?? 20;
  }
}

const mes = {
  woLot: mod.WO_LOT,
  woAhead: mod.WO_AHEAD,
  repairDefault: mod.REPAIR_DEFAULT,
  repairTechs: mod.REPAIR_TECHS,
  midInspectHours: mod.MID_INSPECT_HOURS,
  ilkTimeoutSec: mod.ILK_TIMEOUT_SEC,
  ilkRetrySec: mod.ILK_RETRY_SEC,
  healthIntervalSec: mod.HEALTH_INTERVAL_SEC,
  shifts: mod.SHIFTS,
  /** 계획 보전 정지 사유 · 작업지시가 없어 투입 공정이 설 때 사유 */
  pmReason: mod.PM_REASON,
  noPlanReason: mod.OPERATOR_REASONS.stop[3],
  productSteps: Object.fromEntries(mod.FACTORY.lines.map((l) => [l.code, mod.productSteps(l)])),
  /** 설비 → { faRequired, inspection, productScope, prevStep } */
  stations,
  /** 설비 → 불량 코드 → { action: REPAIR|REWORK|SCRAP|UAI|MRB, rule, minutes, prob } (MES 자동 판정과 같은 값) */
  ngRule,
  /** 설비 → 계획·예지 보전 작업 시간 (분) */
  pmMinutes,
};

writeFileSync(join(dist, 'factory.json'), JSON.stringify({ ...mod.FACTORY, mes }, null, 2), 'utf8');
const n = mod.FACTORY.lines.reduce((k, l) => k + l.stations.length, 0);
process.stdout.write(`[shared] factory.json 내보냄 · 라인 ${mod.FACTORY.lines.length} · 설비 ${n} · 시나리오 ${mod.FACTORY.scenarios.length} · 실행 규칙 포함\n`);
