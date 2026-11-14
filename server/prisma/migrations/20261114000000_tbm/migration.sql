-- TBM 회의 체크리스트 대조 (P10): 회의 녹음·대화록을 원청·안전팀 항목과 그날 MES 상태 항목에 대조한 기록과 조장 후속 조치

-- CreateTable
CREATE TABLE "tbm_meeting" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER,
    "line" TEXT NOT NULL,
    "shift" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "file_name" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "mode" TEXT NOT NULL,
    "model" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "v_at" TIMESTAMPTZ(3),
    "analyzed_at" TIMESTAMPTZ(3),
    "ms" INTEGER,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "lines" JSONB NOT NULL DEFAULT '[]',
    "items" JSONB NOT NULL DEFAULT '[]',
    "changes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chunks" INTEGER NOT NULL DEFAULT 0,
    "covered" INTEGER NOT NULL DEFAULT 0,
    "partial" INTEGER NOT NULL DEFAULT 0,
    "missing" INTEGER NOT NULL DEFAULT 0,
    "uncertain" INTEGER NOT NULL DEFAULT 0,
    "alarmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "tbm_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tbm_followup" (
    "id" SERIAL NOT NULL,
    "meeting_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "by" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "v_at" TIMESTAMPTZ(3),

    CONSTRAINT "tbm_followup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tbm_meeting_line_created_at_idx" ON "tbm_meeting"("line", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tbm_followup_meeting_id_code_key" ON "tbm_followup"("meeting_id", "code");

