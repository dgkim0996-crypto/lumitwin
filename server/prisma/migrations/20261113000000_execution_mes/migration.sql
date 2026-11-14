-- 실행 MES (P9): 작업지시·인터록·불량 처리(NCR)·Hold·4M 변경점·초중종물·상태 감시·사용자·감사 기록

-- AlterTable
ALTER TABLE "production_unit" ADD COLUMN     "variant" TEXT,
ADD COLUMN     "work_order" INTEGER;

-- AlterTable
ALTER TABLE "process_record" ADD COLUMN     "fa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ilk_skip" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reinspect" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "variant" TEXT,
ADD COLUMN     "work_order" INTEGER;

-- CreateTable
CREATE TABLE "work_order" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "released" INTEGER NOT NULL DEFAULT 0,
    "done_qty" INTEGER NOT NULL DEFAULT 0,
    "scrap_qty" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL,
    "created_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "work_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interlock_log" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "line" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "interlock_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ncr" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "defect" TEXT NOT NULL,
    "variant" TEXT,
    "work_order" INTEGER,
    "status" TEXT NOT NULL,
    "disposition" TEXT,
    "rule" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "repair_ok" BOOLEAN,
    "repair_min" DOUBLE PRECISION,
    "reinspect" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "note" TEXT,

    CONSTRAINT "ncr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hold" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "material" TEXT,
    "lot" TEXT,
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "released_by" TEXT,
    "released_at" TIMESTAMPTZ(3),
    "release_note" TEXT,
    "result" TEXT,

    CONSTRAINT "hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_point" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "line" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sim_id" TEXT,
    "created_by" TEXT,
    "fa_status" TEXT NOT NULL,
    "fa_serial" TEXT,
    "fa_at" TIMESTAMPTZ(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),

    CONSTRAINT "change_point_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "line" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "variant" TEXT,
    "change_id" INTEGER,
    "by" TEXT,

    CONSTRAINT "inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_sample" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "station" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "vib" DOUBLE PRECISION NOT NULL,
    "cur" DOUBLE PRECISION NOT NULL,
    "temp" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "health_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" SERIAL NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "pass_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_log" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "v_at" TIMESTAMPTZ(3),
    "user" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "detail" JSONB,
    "ip" TEXT,

    CONSTRAINT "action_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_order_run_id_line_status_seq_idx" ON "work_order"("run_id", "line", "status", "seq");

-- CreateIndex
CREATE INDEX "interlock_log_run_id_at_idx" ON "interlock_log"("run_id", "at");

-- CreateIndex
CREATE INDEX "interlock_log_run_id_station_at_idx" ON "interlock_log"("run_id", "station", "at");

-- CreateIndex
CREATE INDEX "interlock_log_run_id_serial_idx" ON "interlock_log"("run_id", "serial");

-- CreateIndex
CREATE INDEX "ncr_run_id_status_idx" ON "ncr"("run_id", "status");

-- CreateIndex
CREATE INDEX "ncr_run_id_serial_idx" ON "ncr"("run_id", "serial");

-- CreateIndex
CREATE INDEX "ncr_run_id_opened_at_idx" ON "ncr"("run_id", "opened_at");

-- CreateIndex
CREATE INDEX "hold_run_id_status_idx" ON "hold"("run_id", "status");

-- CreateIndex
CREATE INDEX "change_point_run_id_at_idx" ON "change_point"("run_id", "at");

-- CreateIndex
CREATE INDEX "change_point_run_id_station_fa_status_idx" ON "change_point"("run_id", "station", "fa_status");

-- CreateIndex
CREATE INDEX "change_point_run_id_sim_id_idx" ON "change_point"("run_id", "sim_id");

-- CreateIndex
CREATE INDEX "inspection_run_id_station_at_idx" ON "inspection"("run_id", "station", "at");

-- CreateIndex
CREATE INDEX "inspection_run_id_type_at_idx" ON "inspection"("run_id", "type", "at");

-- CreateIndex
CREATE INDEX "health_sample_run_id_station_at_idx" ON "health_sample"("run_id", "station", "at");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_login_key" ON "app_user"("login");

-- CreateIndex
CREATE INDEX "action_log_at_idx" ON "action_log"("at");

-- CreateIndex
CREATE INDEX "action_log_user_at_idx" ON "action_log"("user", "at");


-- CreateIndex
CREATE INDEX "process_record_run_id_ended_at_idx" ON "process_record"("run_id", "ended_at");
