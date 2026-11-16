-- What-if 계획 시뮬레이션 (P11): 지금 공장 상태를 복사해 계획 1~3개를 시뮬레이터로 여러 번 돌린 계산 기록

-- CreateTable
CREATE TABLE "whatif_run" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "status" TEXT NOT NULL,
    "horizon_h" DOUBLE PRECISION NOT NULL,
    "reps" INTEGER NOT NULL,
    "seed" INTEGER NOT NULL,
    "request" JSONB NOT NULL,
    "base" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "progress_done" INTEGER NOT NULL DEFAULT 0,
    "progress_total" INTEGER NOT NULL DEFAULT 0,
    "v_start_at" TIMESTAMPTZ(3) NOT NULL,
    "elapsed_ms" INTEGER,

    CONSTRAINT "whatif_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatif_run_created_at_idx" ON "whatif_run"("created_at");
