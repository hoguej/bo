/**
 * Todo skill: per-person todo lists. Add, list, mark done, remove, edit, set due.
 * Owner = sender (my list) or contact name (Carrie's list). List shows #1, #2, #3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getNameToNumber, getNumberToName } from "../../src/contacts";
import { normalizeOwner } from "../../src/memory";

type Todo = {
  text: string;
  done: boolean;
  due?: string;
  createdAt: string;
};

type Input = {
  action: "add" | "list" | "mark_done" | "remove" | "edit" | "set_due";
  text?: string;
  number?: number;
  for_contact?: string;
  due?: string;
};

function getTodosPath(owner: string): string {
  const baseDir = process.env.BO_MEMORY_PATH?.trim()
    ? dirname(process.env.BO_MEMORY_PATH)
    : join(homedir(), ".bo");
  const fileName = owner === "default" ? "todos.json" : `todos_${owner}.json`;
  return join(baseDir, fileName);
}

function loadTodos(owner: string): Todo[] {
  const path = getTodosPath(owner);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t): t is Todo =>
        t != null &&
        typeof t === "object" &&
        typeof (t as Todo).text === "string" &&
        typeof (t as Todo).done === "boolean"
    );
  } catch {
    return [];
  }
}

function saveTodos(owner: string, todos: Todo[]): void {
  const path = getTodosPath(owner);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(todos, null, 2), "utf-8");
}

function resolveOwner(input: Input): { owner: string; displayName: string } {
  const fromRaw = process.env.BO_REQUEST_FROM ?? "";
  const nameToNumber = getNameToNumber();
  const numberToName = getNumberToName();

  if (input.for_contact && input.for_contact.trim()) {
    const key = input.for_contact.trim().toLowerCase();
    const num = nameToNumber.get(key);
    if (num) {
      const displayName = numberToName.get(num) ?? input.for_contact.trim();
      return { owner: num, displayName };
    }
  }
  const owner = normalizeOwner(fromRaw);
  const displayName = numberToName.get(owner) ?? "You";
  return { owner, displayName };
}

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

function formatTodoList(todos: Todo[], displayName: string, showDone: boolean = true): string {
  const toShow = showDone ? todos : todos.filter((t) => !t.done);
  if (toShow.length === 0) {
    const verb = displayName.toLowerCase() === "you" ? "have" : "has";
    return `${displayName} ${verb} no todos.`;
  }
  const lines = todos.map((t, idx) => {
    if (!showDone && t.done) return null;
    const num = idx + 1;
    const due = t.due ? ` (due ${t.due})` : "";
    const done = t.done ? " ✓" : "";
    return `#${num} ${t.text}${due}${done}`;
  }).filter(Boolean) as string[];
  return `${displayName}'s todos:\n` + lines.join("\n");
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  const action = input?.action?.toLowerCase();
  if (!action || !["add", "list", "mark_done", "remove", "edit", "set_due"].includes(action)) {
    process.stderr.write("todo skill: action must be add, list, mark_done, remove, edit, or set_due\n");
    process.exit(1);
  }

  const { owner, displayName } = resolveOwner(input);
  let todos = loadTodos(owner);

  switch (action) {
    case "add": {
      const text = (input.text ?? "").trim();
      if (!text) {
        process.stderr.write("todo skill: add requires text\n");
        process.exit(1);
      }
      todos.push({
        text,
        done: false,
        due: input.due?.trim() || undefined,
        createdAt: new Date().toISOString(),
      });
      saveTodos(owner, todos);
      const forWho = input.for_contact ? ` to ${displayName}'s list` : "";
      process.stdout.write(`Added "${text}"${forWho}.`);
      return;
    }

    case "list": {
      const out = formatTodoList(todos, displayName);
      process.stdout.write(out);
      return;
    }

    case "mark_done": {
      const num = input.number;
      if (num == null || num < 1 || num > todos.length) {
        process.stdout.write(`No todo #${num ?? "?"}. Use a number from the list (e.g. #2).`);
        return;
      }
      const idx = num - 1;
      todos[idx]!.done = true;
      saveTodos(owner, todos);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      process.stdout.write(`Marked #${num} done${forWho}.`);
      return;
    }

    case "remove": {
      const num = input.number;
      if (num == null || num < 1 || num > todos.length) {
        process.stdout.write(`No todo #${num ?? "?"}. Use a number from the list.`);
        return;
      }
      const idx = num - 1;
      const removed = todos[idx]!.text;
      todos.splice(idx, 1);
      saveTodos(owner, todos);
      const forWho = input.for_contact ? ` from ${displayName}'s list` : "";
      process.stdout.write(`Removed #${num} "${removed}"${forWho}.`);
      return;
    }

    case "edit": {
      const num = input.number;
      const newText = (input.text ?? "").trim();
      if (num == null || num < 1 || num > todos.length) {
        process.stdout.write(`No todo #${num ?? "?"}. Use a number from the list.`);
        return;
      }
      if (!newText) {
        process.stderr.write("todo skill: edit requires text (new content)\n");
        process.exit(1);
      }
      const idx = num - 1;
      todos[idx]!.text = newText;
      saveTodos(owner, todos);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      process.stdout.write(`Updated #${num} to "${newText}"${forWho}.`);
      return;
    }

    case "set_due": {
      const num = input.number;
      const due = (input.due ?? "").trim();
      if (num == null || num < 1 || num > todos.length) {
        process.stdout.write(`No todo #${num ?? "?"}. Use a number from the list.`);
        return;
      }
      if (!due) {
        process.stderr.write("todo skill: set_due requires due (e.g. 2025-01-30 or tomorrow)\n");
        process.exit(1);
      }
      const idx = num - 1;
      todos[idx]!.due = due;
      saveTodos(owner, todos);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      process.stdout.write(`Set #${num} due ${due}${forWho}.`);
      return;
    }
  }
}

main().catch((err) => {
  process.stderr.write(err?.message ?? String(err));
  process.exit(1);
});
