-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "allocationPercent" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "riskPercent" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "mode" TEXT NOT NULL,
    "tradingStyle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "learnedRules" JSONB,
    "monthlyPnL" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTrades" INTEGER NOT NULL DEFAULT 0,
    "winRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "stopLoss" DOUBLE PRECISION NOT NULL,
    "takeProfit" DOUBLE PRECISION,
    "size" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "exitPrice" DOUBLE PRECISION,
    "realizedPnL" DOUBLE PRECISION,
    "closeReason" TEXT,
    "duration" INTEGER,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_lessons" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT,
    "agentId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candles" (
    "id" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candles_pair_timeframe_timestamp_key" ON "candles"("pair", "timeframe", "timestamp");

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lessons" ADD CONSTRAINT "trade_lessons_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lessons" ADD CONSTRAINT "trade_lessons_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
