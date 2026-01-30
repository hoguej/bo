import type { IMessageSDK } from "@photon-ai/imessage-kit";
import { dbGetPrimaryUserPhone } from "../db";
import { toE164 } from "../phone";

export async function runSendSelf(sdk: IMessageSDK, args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) {
    console.error("Usage: bo send-self <message text>");
    console.error("Set config primary_user_id in admin, or BO_MY_PHONE / BO_MY_EMAIL for your iMessage address.");
    process.exit(1);
  }

  const primaryPhone = dbGetPrimaryUserPhone();
  const to = primaryPhone ? toE164(primaryPhone) : (process.env.BO_MY_PHONE ?? process.env.BO_MY_EMAIL);
  if (!to) {
    console.error("Set config primary_user_id in admin, or BO_MY_PHONE or BO_MY_EMAIL. Example: BO_MY_PHONE=+1234567890 bo send-self 'Hi'");
    process.exit(1);
  }

  await sdk.send(to, text);
  console.log(JSON.stringify({ ok: true, to, text }));
}
