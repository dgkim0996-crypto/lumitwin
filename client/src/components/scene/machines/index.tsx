'use client';

// 설비 3D 모델. 공정군마다 파일이 따로다 (동시에 고쳐도 겹치지 않게):
//   molding.tsx   성형·표면 처리 (건조기·사출기·하드코팅·증착·도장)
//   smt.tsx       전장 SMT (마킹·인쇄·SPI·마운터·리플로우·AOI·라우터·ICT·코팅·FCT)
//   assembly.tsx  조립·검사·포장 (조립 셀·실링·리크·배광·EOL·기능 검사·포장)
// 미리보기: /dev/machines (설비 종류별로 한자리에 모아 본다)
import type { EquipmentKind, StationDef } from '@lumitwin/shared';
import { Box, MAT } from '../parts';
import { ASSEMBLY_KINDS, AssemblyMachine, assemblyCallouts } from './assembly';
import { type Callout, FOOTPRINT, type MachineProps } from './common';
import { MOLDING_KINDS, MoldingMachine, moldingCallouts } from './molding';
import { SMT_KINDS, SmtMachine, smtCallouts } from './smt';

export { FOOTPRINT, type Callout, type MachineProps };

export const MACHINE_GROUPS = {
  molding: { name: '성형·표면 처리', kinds: MOLDING_KINDS as readonly EquipmentKind[] },
  smt: { name: '전장 SMT', kinds: SMT_KINDS as readonly EquipmentKind[] },
  assembly: { name: '조립·검사·포장', kinds: ASSEMBLY_KINDS as readonly EquipmentKind[] },
} as const;
export type MachineGroup = keyof typeof MACHINE_GROUPS;

export function groupOf(kind: EquipmentKind): MachineGroup | undefined {
  return (Object.keys(MACHINE_GROUPS) as MachineGroup[]).find((g) => MACHINE_GROUPS[g].kinds.includes(kind));
}

export function Machine(props: MachineProps) {
  switch (groupOf(props.def.kind)) {
    case 'molding':
      return <MoldingMachine {...props} />;
    case 'smt':
      return <SmtMachine {...props} />;
    case 'assembly':
      return <AssemblyMachine {...props} />;
    default: {
      const [L, D, H] = FOOTPRINT[props.def.kind];
      return <Box size={[L, H, D]} pos={[0, H / 2, 0]} mat={MAT.body} />;
    }
  }
}

/** 고른 설비의 부위 이름표 (설비 원점 기준 좌표) */
export function calloutsFor(def: StationDef): Callout[] {
  switch (groupOf(def.kind)) {
    case 'molding':
      return moldingCallouts(def);
    case 'smt':
      return smtCallouts(def);
    case 'assembly':
      return assemblyCallouts(def);
    default:
      return [];
  }
}
