-- 작업자 태블릿의 작업 전 점검 기록

-- CreateTable
CREATE TABLE "check_record" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "station" TEXT NOT NULL,
    "doc" TEXT,
    "items" JSONB NOT NULL,
    "ng_count" INTEGER NOT NULL,
    "by" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_record_run_id_station_at_idx" ON "check_record"("run_id", "station", "at");
