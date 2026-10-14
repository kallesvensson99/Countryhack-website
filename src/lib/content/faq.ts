/**
 * Structure of the FAQ. The wording lives in messages/{sv,en}.json under "faq" as `q_<id>` / `a_<id>`;
 * answers may use {minAge} and {contact}.
 */
export const FAQ_GROUPS = [
  { id: "tickets", items: ["howToBuy", "age", "refund", "hold", "code", "forFriend", "vat"] },
  { id: "seatsFood", items: ["chooseSeat", "changeSeat", "food", "allergies"] },
  { id: "onSite", items: ["bring", "checkin", "minors"] },
  { id: "account", items: ["noMail", "data", "delete", "contact"] },
] as const;

export type FaqGroupId = (typeof FAQ_GROUPS)[number]["id"];
