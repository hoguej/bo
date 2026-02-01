#!/usr/bin/env bun
import { loadEnv } from "./env";

loadEnv(process.cwd());

import { runMigration } from "./db";
import { closeSdk, getSdk } from "./sdk";
import { runGetMessages } from "./commands/get-messages";
import { runSendSelf } from "./commands/send-self";
import { runListChats } from "./commands/list-chats";
import { runReact } from "./commands/react";
import { runWatchSelf } from "./commands/watch-self";
import { runFacts, runForget, runRemember } from "./commands/memory";
import { runSkills } from "./commands/skills";

const [,, cmd, ...args] = process.argv;

async function main() {
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(`
bo — iMessage CLI for AI wrappers

Usage: bo <command> [options]

Commands:
  get-messages [options]   Get messages (--limit N, --unread, --sender ID, --chat ID)
  send-self <text>        Send a message to yourself (set BO_MY_PHONE or BO_MY_EMAIL)
  list-chats [options]    List chats (--limit N, --unread)
  react [options]         List or show reactions (--list); send not yet supported
  watch-self              Watch self-chat; run /command from messages and reply (never reply to our own)
  remember <k> <v...>     Save a fact (name/location/email/etc.) for later
  forget <k>              Delete a saved fact
  facts                   List saved facts
  skills                  List local skills (scripts) Bo can run
  migrate                 Migrate data from JSON files into ~/.bo/bo.db now

Examples:
  bo get-messages --limit 10
  bo get-messages --unread
  bo send-self "Reminder: call back"
  bo list-chats --limit 5
  bo react --list
  bo remember name "Justin"
  bo facts
  bo skills
`);
    process.exit(0);
  }

  try {
    // For watch-self, we don't need iMessage SDK (Telegram-only mode)
    const needsSdk = !["watch-self", "remember", "forget", "facts", "skills"].includes(cmd);
    const sdk = needsSdk ? getSdk() : null;

    switch (cmd) {
      case "get-messages":
        await runGetMessages(sdk!, args);
        break;
      case "send-self":
        await runSendSelf(sdk!, args);
        break;
      case "list-chats":
        await runListChats(sdk!, args);
        break;
      case "react":
        await runReact(sdk!, args);
        break;
      case "watch-self":
        await runWatchSelf(sdk as any, args);
        break;
      case "remember":
        await runRemember(args);
        break;
      case "forget":
        await runForget(args);
        break;
      case "facts":
        await runFacts(args);
        break;
      case "skills":
        await runSkills(args);
        break;
      case "migrate":
        runMigration();
        console.log("Migration complete. Data is in ~/.bo/bo.db (or BO_DB_PATH).");
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        process.exit(1);
    }
  } finally {
    await closeSdk();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
