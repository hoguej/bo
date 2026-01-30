#!/usr/bin/env bun
/**
 * Admin server: database view for ~/.bo/bo.db
 * Run: bun run scripts/admin-server.ts  →  http://localhost:3847
 * Left: table list. Right: query editor + result table. FK cells clickable for drill-down.
 */

import { loadEnv } from "../src/env";
loadEnv(process.cwd());

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dbGetTables,
  dbGetTableInfo,
  dbGetForeignKeys,
  dbGetPkColumns,
  dbRunQuery,
  dbGetRowByColumn,
  dbGetUsersByIds,
  dbInsertRow,
  dbUpdateRow,
  dbDeleteRow,
} from "../src/db";

const PORT = parseInt(process.env.BO_ADMIN_PORT ?? "3847", 10);
const HTML_PATH = join(import.meta.dir, "admin.html");

function json(res: unknown, status = 200) {
  return new Response(JSON.stringify(res), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 400) {
  return json({ error: msg }, status);
}

const router: Record<string, (req: Request, url: URL) => Promise<Response> | Response> = {
  "GET /api/db/tables": () => json({ tables: dbGetTables() }),


  "POST /api/db/query": async (req) => {
    const body = (await req.json()) as { sql?: string; params?: unknown[] };
    const sql = typeof body?.sql === "string" ? body.sql.trim() : "";
    if (!sql) return err("sql required");
    const params = Array.isArray(body?.params) ? body.params : [];
    const result = dbRunQuery(sql, params);
    if (result.error) return err(result.error, 400);
    return json(result);
  },

};

const server = {
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/" || path === "/index.html") {
      try {
        const html = readFileSync(HTML_PATH, "utf-8");
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store",
          },
        });
      } catch (e) {
        return new Response("admin.html not found", { status: 404 });
      }
    }

    const key = `${method} ${path}`;
    const baseKey = path.startsWith("/api/") ? `${method} ${path.split("?")[0]}` : key;
    let handler = router[key] ?? router[baseKey];

    if (!handler && method === "GET" && path.startsWith("/api/db/schema/")) {
      const table = path.slice("/api/db/schema/".length).split("/")[0] ?? "";
      const columns = dbGetTableInfo(table);
      if (!columns.length) return err("Table not found", 404);
      return json({ columns, foreignKeys: dbGetForeignKeys(table) });
    }

    if (!handler && method === "GET" && path.startsWith("/api/db/row/")) {
      const parts = path.slice("/api/db/row/".length).split("/");
      if (parts.length >= 3) {
        const [table, column, ...valueParts] = parts;
        const value = decodeURIComponent(valueParts.join("/") ?? "");
        const num = Number(value);
        const useValue = value === String(num) && !Number.isNaN(num) ? num : value;
        const row = dbGetRowByColumn(table!, column!, useValue);
        return json({ row: row ?? null });
      }
    }

    if (!handler && method === "GET" && path.startsWith("/api/db/users")) {
      const idsParam = url.searchParams.get("ids") ?? "";
      const ids = idsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
      const users = dbGetUsersByIds(ids);
      return json({ users });
    }

    if (!handler && method === "POST" && path.startsWith("/api/db/row/")) {
      const table = path.slice("/api/db/row/".length).split("/")[0] ?? "";
      const body = (await req.json()) as Record<string, unknown>;
      if (!body || typeof body !== "object") return err("body required");
      const result = dbInsertRow(table, body);
      if (result.error) return err(result.error, 400);
      return json({ ok: true, lastId: result.lastId });
    }

    if (!handler && method === "PATCH" && path.startsWith("/api/db/row/")) {
      const table = path.slice("/api/db/row/".length).split("/")[0] ?? "";
      const body = (await req.json()) as { pk?: Record<string, unknown>; data?: Record<string, unknown> };
      if (!body?.pk || !body?.data) return err("pk and data required");
      const result = dbUpdateRow(table, body.pk, body.data);
      if (result.error) return err(result.error, 400);
      return json({ ok: true, changes: result.changes });
    }

    if (!handler && method === "DELETE" && path.startsWith("/api/db/row/")) {
      const table = path.slice("/api/db/row/".length).split("/")[0] ?? "";
      const body = (await req.json()) as { pk?: Record<string, unknown> };
      if (!body?.pk) return err("pk required");
      const result = dbDeleteRow(table, body.pk);
      if (result.error) return err(result.error, 400);
      return json({ ok: true, changes: result.changes });
    }

    if (handler) {
      try {
        return await handler(req, url);
      } catch (e) {
        console.error(e);
        return json({ error: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

Bun.serve(server);
console.log(`Bo DB Admin: http://localhost:${PORT}`);
