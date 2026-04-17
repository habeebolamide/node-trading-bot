/*
  Warnings:

  - Added the required column `status` to the `pending_signals` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "pending_signals" ADD COLUMN     "status" TEXT NOT NULL;
