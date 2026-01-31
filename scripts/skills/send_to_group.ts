/**
 * Send a message to a group chat
 */

import { dbGetGroupChatByName } from "../../src/db";

type Input = {
  group_name?: string;
  message?: string;
};

function readJsonStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    process.stdin.on("error", reject);
  });
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  
  const groupName = (input.group_name ?? "").trim();
  const message = (input.message ?? "").trim();

  if (!groupName) {
    process.stdout.write(JSON.stringify({ response: "Group name is required." }));
    process.exit(0);
  }

  if (!message) {
    process.stdout.write(JSON.stringify({ response: "Message is required." }));
    process.exit(0);
  }

  // Look up group chat by name
  const group = dbGetGroupChatByName(groupName);
  if (!group) {
    process.stdout.write(JSON.stringify({ response: `I couldn't find a group called "${groupName}". Make sure I'm in that group and have received at least one message from it.` }));
    process.exit(0);
  }

  // Return hints to the router for formatting and sending
  process.stdout.write(JSON.stringify({ 
    response: `I'll send that to ${group.name}.`,
    hints: {
      send_to_group: true,
      group_chat_id: group.chat_id,
      group_name: group.name,
      message: message
    }
  }));
}

main();
