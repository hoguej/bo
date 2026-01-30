/**
 * Todo skill: per-person todo lists. Add, list, mark done, remove, edit, set due.
 * Owner = sender (my list) or contact name (Carrie's list). List shows #1, #2, #3.
 * Data stored in ~/.bo/bo.db (SQLite).
 */

import {
  dbAddTodo,
  dbDeleteTodo,
  dbGetTodos,
  dbUpdateTodoDone,
  dbUpdateTodoDue,
  dbUpdateTodoText,
} from "../../src/db";
import { getNameToNumber, getNumberToName } from "../../src/contacts";
import { normalizeOwner } from "../../src/memory";

type Todo = {
  id: number;
  text: string;
  done: boolean;
  due?: string | null;
  createdAt: string;
};

type Input = {
  action: "add" | "list" | "mark_done" | "remove" | "edit" | "set_due";
  text?: string;
  number?: number;
  for_contact?: string;
  due?: string;
};

function loadTodos(owner: string): Todo[] {
  const rows = dbGetTodos(owner);
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done !== 0,
    due: r.due ?? undefined,
    createdAt: r.createdAt,
  }));
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
  const todos = loadTodos(owner);

  switch (action) {
    case "add": {
      const text = (input.text ?? "").trim();
      if (!text) {
        process.stderr.write("todo skill: add requires text\n");
        process.exit(1);
      }
      dbAddTodo(owner, text, input.due?.trim() || null);
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
      const todo = todos[num - 1]!;
      dbUpdateTodoDone(owner, todo.id);
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
      const todo = todos[num - 1]!;
      const removed = todo.text;
      dbDeleteTodo(owner, todo.id);
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
      const todo = todos[num - 1]!;
      dbUpdateTodoText(owner, todo.id, newText);
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
      const todo = todos[num - 1]!;
      dbUpdateTodoDue(owner, todo.id, due);
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
