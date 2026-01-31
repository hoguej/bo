/**
 * Todo skill: per-person todo lists. Add, list, mark done, remove, edit, set due.
 * Owner = sender (my list) or contact name (Carrie's list). List shows task id, verbatim text, creator, due.
 * Data stored in ~/.bo/bo.db (SQLite). Creator is tracked by user id; assignee (list owner) can differ.
 */

import {
  dbAddTodo,
  dbDeleteTodo,
  dbGetTodos,
  dbGetUserById,
  dbUpdateTodoDone,
  dbUpdateTodoDue,
  dbUpdateTodoText,
} from "../../src/db";
import { getNumberToName, resolveContactToNumber } from "../../src/contacts";
import { normalizeOwner } from "../../src/memory";

type Todo = {
  id: number;
  text: string;
  done: boolean;
  due?: string | null;
  createdAt: string;
  creatorDisplayName: string;
};

type TodoItemInput = { text: string; due?: string };

type Input = {
  action: "add" | "add_many" | "list" | "mark_done" | "remove" | "edit" | "set_due";
  text?: string;
  items?: TodoItemInput[];
  number?: number;
  for_contact?: string;
  due?: string;
  show_done?: boolean;
  match_phrase?: string;
};

function loadTodos(owner: string, opts?: { includeDone?: boolean }): Todo[] {
  const rows = dbGetTodos(owner, opts);
  const numberToName = getNumberToName();
  return rows.map((r) => {
    let creatorDisplayName = "—";
    if (r.creator_user_id != null) {
      const u = dbGetUserById(r.creator_user_id);
      if (u) {
        const name = (u.first_name + " " + u.last_name).trim();
        const contactName = numberToName.get(u.phone_number);
        creatorDisplayName = contactName ?? (name.trim() ? name : u.phone_number) ?? "—";
      }
    }
    return {
      id: r.id,
      text: r.text,
      done: r.done !== 0,
      due: r.due ?? undefined,
      createdAt: r.createdAt,
      creatorDisplayName,
    };
  });
}

function resolveOwner(input: Input): { owner: string; displayName: string } {
  const fromRaw = process.env.BO_REQUEST_FROM ?? "";
  const numberToName = getNumberToName();

  // for_contact = assignee (whose list). Resolve by full name or first name (e.g. "Robert" → Robert Hogue's number).
  if (input.for_contact && input.for_contact.trim()) {
    const num = resolveContactToNumber(input.for_contact.trim());
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

/** List format: id (ascending), verbatim text, creator, due date if any. Read back text is always verbatim from storage. */
function formatTodoList(todos: Todo[], displayName: string): string {
  if (todos.length === 0) {
    const verb = displayName.toLowerCase() === "you" ? "have" : "has";
    return `${displayName} ${verb} no open todos.`;
  }
  const lines = todos.map((t) => {
    const due = t.due ? ` | due ${t.due}` : "";
    return `${t.id}. ${t.text} | ${t.creatorDisplayName}${due}`;
  });
  return `${displayName}'s todos:\n` + lines.join("\n");
}

/** Score how well phrase matches todo text (word overlap, case-insensitive). Higher = better match. */
function matchScore(phrase: string, todoText: string): number {
  const p = phrase.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const t = todoText.toLowerCase();
  if (p.length === 0) return 0;
  let hits = 0;
  for (const w of p) {
    if (w.length > 1 && t.includes(w)) hits++;
  }
  return hits / p.length;
}

/** Resolve which todo to act on: by number (id), or by match_phrase on own list. For other people's lists, number is required. */
function resolveTodoNumber(input: Input, todos: Todo[], isOwnList: boolean): number | null {
  const num = input.number;
  if (num != null && num >= 1) {
    const byId = todos.find((t) => t.id === num);
    if (byId) return byId.id;
  }
  if (!isOwnList) return null;
  const phrase = (input.match_phrase ?? "").trim();
  if (!phrase) return null;
  let best: { id: number; score: number } | null = null;
  for (const t of todos) {
    const score = matchScore(phrase, t.text);
    if (score > 0 && (!best || score > best.score)) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

function writeOutput(response: string, hints?: { todo_ids?: number[] }) {
  const out: Record<string, unknown> = { response };
  if (hints && (hints.todo_ids?.length ?? 0) > 0) out.hints = hints;
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const input = (await readJsonStdin()) as Input;
  const action = input?.action?.toLowerCase();
  if (!action || !["add", "add_many", "list", "mark_done", "remove", "edit", "set_due"].includes(action)) {
    process.stderr.write("todo skill: action must be add, add_many, list, mark_done, remove, edit, or set_due\n");
    process.exit(1);
  }

  const { owner, displayName } = resolveOwner(input);
  const fromRaw = process.env.BO_REQUEST_FROM ?? "";
  const requestorOwner = normalizeOwner(fromRaw);
  const isOwnList = !input.for_contact?.trim() || owner === requestorOwner;

  switch (action) {
    case "add": {
      const text = (input.text ?? "").trim();
      if (!text) {
        process.stderr.write("todo skill: add requires text\n");
        process.exit(1);
      }
      const creatorOwner = fromRaw ? requestorOwner : undefined;
      const id = dbAddTodo(owner, text, input.due?.trim() || null, creatorOwner);
      const forWho = input.for_contact ? ` to ${displayName}'s list` : "";
      writeOutput(`Added "${text}"${forWho}.`, id != null ? { todo_ids: [id] } : undefined);
      return;
    }

    case "add_many": {
      const rawItems = input.items;
      const items = Array.isArray(rawItems)
        ? rawItems
            .map((item) => (typeof item === "object" && item != null && typeof (item as TodoItemInput).text === "string" ? { text: (item as TodoItemInput).text.trim(), due: typeof (item as TodoItemInput).due === "string" ? (item as TodoItemInput).due?.trim() : undefined } : null))
            .filter((item): item is { text: string; due?: string } => item != null && item.text.length > 0)
        : [];
      if (items.length === 0) {
        process.stderr.write("todo skill: add_many requires items (array of { text, due? })\n");
        process.exit(1);
      }
      const creatorOwner = fromRaw ? requestorOwner : undefined;
      const ids: number[] = [];
      for (const item of items) {
        const id = dbAddTodo(owner, item.text, item.due ?? null, creatorOwner);
        if (id != null) ids.push(id);
      }
      const forWho = input.for_contact ? ` to ${displayName}'s list` : "";
      const count = ids.length;
      const response =
        count === 0
          ? `No todos added${forWho}.`
          : count === 1
            ? `Added 1 todo${forWho}: "${items[0]!.text}".`
            : `Added ${count} todos${forWho}: ${items.map((i) => `"${i.text}"`).join(", ")}.`;
      writeOutput(response, ids.length > 0 ? { todo_ids: ids } : undefined);
      return;
    }

    case "list": {
      const includeDone = input.show_done === true;
      const todos = loadTodos(owner, { includeDone });
      const out = formatTodoList(todos, displayName);
      const todoIds = todos.map((t) => t.id);
      writeOutput(out, todoIds.length ? { todo_ids: todoIds } : undefined);
      return;
    }

    case "mark_done": {
      const todos = loadTodos(owner, { includeDone: true });
      const id = resolveTodoNumber(input, todos, isOwnList);
      if (id == null) {
        const msg = isOwnList
          ? `Couldn't match a todo. Say which one (e.g. #3) or use a phrase that matches the task.`
          : `To complete a task on ${displayName}'s list, specify the task number (e.g. mark Carrie's task #4 as done).`;
        writeOutput(msg);
        return;
      }
      const todo = todos.find((t) => t.id === id)!;
      dbUpdateTodoDone(owner, todo.id);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      writeOutput(`Marked #${todo.id} done${forWho}.`, { todo_ids: [todo.id] });
      return;
    }

    case "remove": {
      const todos = loadTodos(owner, { includeDone: true });
      const id = resolveTodoNumber(input, todos, isOwnList);
      if (id == null) {
        const msg = isOwnList
          ? `Couldn't match a todo. Specify the task number (e.g. #2) or a matching phrase.`
          : `To remove a task from ${displayName}'s list, specify the task number.`;
        writeOutput(msg);
        return;
      }
      const todo = todos.find((t) => t.id === id)!;
      const removed = todo.text;
      dbDeleteTodo(owner, todo.id);
      const forWho = input.for_contact ? ` from ${displayName}'s list` : "";
      writeOutput(`Removed #${todo.id} "${removed}"${forWho}.`, { todo_ids: [todo.id] });
      return;
    }

    case "edit": {
      const newText = (input.text ?? "").trim();
      if (!newText) {
        process.stderr.write("todo skill: edit requires text (new content)\n");
        process.exit(1);
      }
      const todos = loadTodos(owner, { includeDone: true });
      const id = resolveTodoNumber(input, todos, isOwnList);
      if (id == null) {
        const msg = isOwnList
          ? `Couldn't match a todo. Specify the task number (e.g. #2) or a matching phrase.`
          : `To edit a task on ${displayName}'s list, specify the task number.`;
        writeOutput(msg);
        return;
      }
      const todo = todos.find((t) => t.id === id)!;
      dbUpdateTodoText(owner, todo.id, newText);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      writeOutput(`Updated #${todo.id} to "${newText}"${forWho}.`, { todo_ids: [todo.id] });
      return;
    }

    case "set_due": {
      const due = (input.due ?? "").trim();
      if (!due) {
        process.stderr.write("todo skill: set_due requires due (e.g. 2025-01-30 or tomorrow)\n");
        process.exit(1);
      }
      const todos = loadTodos(owner, { includeDone: true });
      const id = resolveTodoNumber(input, todos, isOwnList);
      if (id == null) {
        const msg = isOwnList
          ? `Couldn't match a todo. Specify the task number or a matching phrase.`
          : `To set due on ${displayName}'s list, specify the task number.`;
        writeOutput(msg);
        return;
      }
      const todo = todos.find((t) => t.id === id)!;
      dbUpdateTodoDue(owner, todo.id, due);
      const forWho = input.for_contact ? ` on ${displayName}'s list` : "";
      writeOutput(`Set #${todo.id} due ${due}${forWho}.`, { todo_ids: [todo.id] });
      return;
    }
  }
}

main().catch((err) => {
  process.stderr.write(err?.message ?? String(err));
  process.exit(1);
});
