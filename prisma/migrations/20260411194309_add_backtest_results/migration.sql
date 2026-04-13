-- CreateTable
CREATE TABLE "backtest_results" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_results_pkey" PRIMARY KEY ("id")
);
