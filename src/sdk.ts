import { IMessageSDK } from "@photon-ai/imessage-kit";

let sdk: IMessageSDK | null = null;

export function getSdk(): IMessageSDK {
  if (!sdk) {
    sdk = new IMessageSDK({
      debug: false,
      watcher: { excludeOwnMessages: false },
    });
  }
  return sdk;
}

export async function closeSdk(): Promise<void> {
  if (sdk) {
    await sdk.close();
    sdk = null;
  }
}
