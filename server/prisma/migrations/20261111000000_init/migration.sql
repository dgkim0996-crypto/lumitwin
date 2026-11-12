-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "sim_run" (
    "id" SERIAL NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sim_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_unit" (
    "run_id" INTEGER NOT NULL,
    "serial" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "last_step" TEXT NOT NULL,
    "last_station" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "defect" TEXT,
    "parent_serial" TEXT,
    "first_at" TIMESTAMPTZ(3) NOT NULL,
    "last_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_unit_pkey" PRIMARY KEY ("run_id","serial")
);

-- CreateTable
CREATE TABLE "process_record" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "serial" TEXT NOT NULL,
    "item" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "defect" TEXT,
    "cycle_sec" DOUBLE PRECISION NOT NULL,
    "values" JSONB NOT NULL,
    "attrs" JSONB,
    "lots" JSONB,
    "comps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "escaped" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "process_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_lot_use" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "material" TEXT NOT NULL,
    "lot" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "station" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "material_lot_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_event" (
    "id" BIGSERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "station" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "state_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarm" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "live_id" INTEGER NOT NULL,
    "station" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "acked_at" TIMESTAMPTZ(3),

    CONSTRAINT "alarm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sim_run_started_at_key" ON "sim_run"("started_at");

-- CreateIndex
CREATE INDEX "production_unit_run_id_parent_serial_idx" ON "production_unit"("run_id", "parent_serial");

-- CreateIndex
CREATE INDEX "production_unit_run_id_line_status_idx" ON "production_unit"("run_id", "line", "status");

-- CreateIndex
CREATE INDEX "process_record_run_id_serial_idx" ON "process_record"("run_id", "serial");

-- CreateIndex
CREATE INDEX "process_record_run_id_station_ended_at_idx" ON "process_record"("run_id", "station", "ended_at");

-- CreateIndex
CREATE INDEX "material_lot_use_run_id_lot_idx" ON "material_lot_use"("run_id", "lot");

-- CreateIndex
CREATE INDEX "material_lot_use_run_id_serial_idx" ON "material_lot_use"("run_id", "serial");

-- CreateIndex
CREATE INDEX "state_event_run_id_station_at_idx" ON "state_event"("run_id", "station", "at");

-- CreateIndex
CREATE INDEX "alarm_run_id_at_idx" ON "alarm"("run_id", "at");

-- CreateIndex
CREATE INDEX "alarm_live_id_idx" ON "alarm"("live_id");

