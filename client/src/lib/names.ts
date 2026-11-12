import { DEFECT_NAMES, FACTORY, LINES, STATIONS } from '@lumitwin/shared';

/** 품목 코드 → 이름 (공정 결과물 + 구매 자재) */
export const ITEM_NAMES: Record<string, string> = Object.fromEntries([
  ...LINES.flatMap((l) => l.steps.map((s) => [s.item, s.itemName] as const)),
  ...FACTORY.materials.map((m) => [m.code, m.name] as const),
]);

export const defectName = (code?: string | null) => (code ? (DEFECT_NAMES[code] ?? code) : '');
export const stationName = (code: string) => STATIONS[code]?.name ?? code;

/** 설비의 값(태그·부품 속성·검사값) 이름·단위와, 계산되는 값이면 그 입력 */
export function valueMeta(station: string, key: string): { name: string; unit: string; inputs: string[] } {
  const st = STATIONS[station];
  const t = st?.tags.find((x) => x.key === key);
  if (t) return { name: t.name, unit: t.unit, inputs: (t.terms ?? []).map((x) => refName(x.ref, station)) };
  const a = st?.attrs?.find((x) => x.key === key);
  if (a) return { name: a.name, unit: a.unit, inputs: a.terms.map((x) => refName(x.ref, station)) };
  const m = st?.measures?.find((x) => x.key === key);
  if (m) return { name: m.name, unit: m.unit, inputs: m.terms.map((x) => refName(x.ref, station)) };
  return { name: key, unit: '', inputs: [] };
}

/** 참조 표기(tag:key · tag:STATION.key · attr:key)를 사람이 읽는 이름으로 */
export function refName(ref: string, here: string): string {
  const [kind, name] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  if (kind === 'tag') {
    const [code, key] = name.includes('.') ? name.split('.', 2) : [here, name];
    const st = STATIONS[code];
    const t = st?.tags.find((x) => x.key === key);
    return code === here ? (t?.name ?? key) : `${st?.name ?? code} ${t?.name ?? key}`;
  }
  if (kind === 'attr') {
    for (const s of Object.values(STATIONS)) {
      const a = s.attrs?.find((x) => x.key === name);
      if (a) return `${a.name} (부품 속성)`;
    }
  }
  return name;
}
