'use client';

import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import {
  SOCKET,
  type AlarmLive,
  type AmrMsg,
  type LineLive,
  type LiveSnapshot,
  type SimEventMsg,
  type SimStatusMsg,
  type StationLive,
  type TickPayload,
  type UnitMsg,
} from '@lumitwin/shared';

const MAX_UNITS = 300;
const MAX_EVENTS = 60;

interface LiveState {
  socket: boolean;
  sim: SimStatusMsg | null;
  simConnected: boolean;
  stations: Record<string, StationLive>;
  lines: Record<string, LineLive>;
  amrs: Record<string, AmrMsg>;
  alarms: AlarmLive[];
  units: UnitMsg[];
  events: SimEventMsg[];
  /** 마지막 tick을 받은 실제 시각 (ms). 3D가 가상 시계를 보간하는 데 쓴다 */
  tickAt: number;
  selected: string | null;
  hovered: string | null;
  traceSerial: string | null;
  /** 늘어날 때마다 카메라가 공장 전체 보기로 돌아간다 */
  homeSeq: number;
  goHome: () => void;
  select: (code: string | null) => void;
  hover: (code: string | null) => void;
  openTrace: (serial: string | null) => void;
  ackLocal: (id: number) => void;
}

export const useLive = create<LiveState>((set) => ({
  socket: false,
  sim: null,
  simConnected: false,
  stations: {},
  lines: {},
  amrs: {},
  alarms: [],
  units: [],
  events: [],
  tickAt: 0,
  selected: null,
  hovered: null,
  traceSerial: null,
  homeSeq: 0,
  goHome: () => set((s) => ({ homeSeq: s.homeSeq + 1, selected: null })),
  select: (code) => set({ selected: code }),
  hover: (code) => set({ hovered: code }),
  openTrace: (serial) => set({ traceSerial: serial }),
  ackLocal: (id) => set((s) => ({ alarms: s.alarms.map((a) => (a.id === id ? { ...a, acked: true } : a)) })),
}));

let socket: Socket | null = null;
let users = 0;

function applyTick(t: TickPayload) {
  useLive.setState({ sim: t.sim, stations: t.stations, lines: t.lines, amrs: t.amrs, simConnected: t.connected.sim, tickAt: performance.now() });
}

/** 실시간 연결을 연다. 여러 컴포넌트가 불러도 소켓은 하나만 쓴다 */
export function useLiveConnection(): void {
  useEffect(() => {
    users++;
    if (!socket) {
      // 같은 주소의 /socket.io (Next rewrites → MES). 폴링으로 먼저 붙고 가능하면 웹소켓으로 올린다
      socket = io(process.env.NEXT_PUBLIC_SOCKET_URL ?? undefined, { path: '/socket.io' });
      socket.on('connect', () => useLive.setState({ socket: true }));
      socket.on('disconnect', () => useLive.setState({ socket: false }));
      socket.on(SOCKET.snapshot, (s: LiveSnapshot) => {
        applyTick(s);
        useLive.setState({ alarms: s.alarms });
      });
      socket.on(SOCKET.tick, applyTick);
      socket.on(SOCKET.unit, (batch: UnitMsg[]) => {
        useLive.setState((st) => ({ units: [...batch.reverse(), ...st.units].slice(0, MAX_UNITS) }));
      });
      socket.on(SOCKET.alarm, (a: AlarmLive) => useLive.setState((st) => ({ alarms: [a, ...st.alarms].slice(0, 300) })));
      socket.on(SOCKET.event, (e: SimEventMsg) => {
        useLive.setState((st) => ({
          events: [e, ...st.events].slice(0, MAX_EVENTS),
          ...(e.kind === 'reset' ? { alarms: [], units: [] } : {}),
        }));
      });
    }
    return () => {
      users--;
      if (users === 0 && socket) {
        socket.close();
        socket = null;
      }
    };
  }, []);
}
