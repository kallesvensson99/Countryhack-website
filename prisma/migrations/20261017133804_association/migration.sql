-- CreateEnum
CREATE TYPE "DocCategory" AS ENUM ('MINUTES', 'BYLAWS', 'REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocVisibility" AS ENUM ('PUBLIC', 'LOGGED_IN', 'STAFF');

-- AlterTable
ALTER TABLE "OrgSettings" ADD COLUMN     "aboutIntroEn" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "aboutIntroSv" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "AssociationDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "DocCategory" NOT NULL,
    "docDate" DATE,
    "visibility" "DocVisibility" NOT NULL DEFAULT 'LOGGED_IN',
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssociationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardMember" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "roleEn" TEXT NOT NULL DEFAULT '',
    "email" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssociationDocument_category_docDate_idx" ON "AssociationDocument"("category", "docDate");

-- CreateIndex
CREATE INDEX "BoardMember_sortOrder_idx" ON "BoardMember"("sortOrder");
