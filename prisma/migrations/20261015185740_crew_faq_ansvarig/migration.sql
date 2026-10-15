-- CreateEnum
CREATE TYPE "FaqGroup" AS ENUM ('TICKETS', 'SEATS_FOOD', 'ON_SITE', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "CrewApplicationStatus" AS ENUM ('NEW', 'ACCEPTED', 'DECLINED');

-- AlterEnum
ALTER TYPE "UserTagKind" ADD VALUE 'ANSVARIG';

-- CreateTable
CREATE TABLE "FaqItem" (
    "id" TEXT NOT NULL,
    "group" "FaqGroup" NOT NULL,
    "questionSv" TEXT NOT NULL,
    "answerSv" TEXT NOT NULL,
    "questionEn" TEXT NOT NULL DEFAULT '',
    "answerEn" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FaqItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewJob" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL DEFAULT '',
    "descriptionEn" TEXT NOT NULL DEFAULT '',
    "before" BOOLEAN NOT NULL DEFAULT false,
    "during" BOOLEAN NOT NULL DEFAULT true,
    "after" BOOLEAN NOT NULL DEFAULT false,
    "spots" INTEGER,
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrewJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrewApplication" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "availability" TEXT NOT NULL,
    "status" "CrewApplicationStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrewApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FaqItem_group_sortOrder_idx" ON "FaqItem"("group", "sortOrder");

-- CreateIndex
CREATE INDEX "CrewJob_isOpen_sortOrder_idx" ON "CrewJob"("isOpen", "sortOrder");

-- CreateIndex
CREATE INDEX "CrewApplication_userId_idx" ON "CrewApplication"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CrewApplication_jobId_userId_key" ON "CrewApplication"("jobId", "userId");

-- AddForeignKey
ALTER TABLE "CrewJob" ADD CONSTRAINT "CrewJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewApplication" ADD CONSTRAINT "CrewApplication_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CrewJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrewApplication" ADD CONSTRAINT "CrewApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
