/**
 * 아주 짧은 조회 캐시. 화면은 몇 초마다 같은 조회를 다시 부르고, 동시 사용자가 늘면 같은 무거운 계산(에너지·보전 집계)을
 * 동시에 여러 번 돌려 DB를 붙잡는다. 같은 조건의 요청은 ttl 동안 결과(계산 중이면 그 Promise)를 같이 쓴다.
 * 실패한 결과는 바로 버린다 (다음 요청이 다시 계산한다)
 */
export class TtlCache<T> {
  private readonly m = new Map<string, { at: number; p: Promise<T> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 64,
  ) {}

  get(key: string, make: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.m.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.p;
    const p = make();
    this.m.set(key, { at: now, p });
    p.catch(() => {
      if (this.m.get(key)?.p === p) this.m.delete(key);
    });
    // 오래된 것부터 버린다 (Map은 넣은 순서를 지킨다)
    while (this.m.size > this.max) {
      const first = this.m.keys().next().value;
      if (first === undefined) break;
      this.m.delete(first);
    }
    return p;
  }

  clear(): void {
    this.m.clear();
  }
}
