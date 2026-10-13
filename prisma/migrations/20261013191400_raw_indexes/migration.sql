-- Constraints Prisma cannot express.

-- Nickname is unique case-insensitively.
CREATE UNIQUE INDEX "User_nickname_lower_key" ON "User" (lower("nickname"));

-- One active ticket per member per event.
CREATE UNIQUE INDEX "Ticket_eventId_userId_active_key"
  ON "Ticket" ("eventId", "userId")
  WHERE "status" <> 'CANCELLED';

-- Discount code is unique per event, case-insensitively.
CREATE UNIQUE INDEX "DiscountCode_eventId_code_lower_key"
  ON "DiscountCode" ("eventId", lower("code"));

-- Order numbers: CCSS-YYYY-NNNN, NNNN drawn from this sequence.
CREATE SEQUENCE "order_number_seq" START 1;

-- Sanity checks on money / quantities (öre are always non-negative integers).
ALTER TABLE "TicketType" ADD CONSTRAINT "TicketType_priceOre_check" CHECK ("priceOre" >= 0 AND "quantity" >= 0);
ALTER TABLE "FoodPackage" ADD CONSTRAINT "FoodPackage_priceOre_check" CHECK ("priceOre" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_check" CHECK ("subtotalOre" >= 0 AND "discountOre" >= 0 AND "totalOre" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_amounts_check" CHECK ("unitPriceOre" >= 0 AND "quantity" > 0);
ALTER TABLE "DiscountCode" ADD CONSTRAINT "DiscountCode_value_check" CHECK ("value" > 0 AND ("kind" <> 'PERCENT' OR "value" <= 100));
ALTER TABLE "User" ADD CONSTRAINT "User_locale_check" CHECK ("locale" IN ('sv', 'en'));
