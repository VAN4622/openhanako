/**
 * fs.js - read-only file APIs for web/remote renderers.
 */
import fs from "fs";
import path from "path";
import os from "os";

function isSafePath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

export default async function fsRoute(app, { engine }) {
  const hanakoHome = path.resolve(engine.hanakoHome);

  function getAllowedRoots() {
    const roots = [hanakoHome];
    const deskHome = engine.agent?.deskManager?.homePath;
    if (deskHome) roots.push(path.resolve(deskHome));
    if (engine.cwd) roots.push(path.resolve(engine.cwd));
    roots.push(path.resolve(path.join(os.tmpdir(), ".hanako-uploads")));
    return roots;
  }

  app.get("/api/fs/read", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      reply.type("text/plain").send(content);
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  app.get("/api/fs/read-base64", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const buf = fs.readFileSync(filePath);
      reply.type("text/plain").send(buf.toString("base64"));
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  app.get("/api/fs/docx-html", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml({ path: filePath });
      reply.type("text/plain").send(result.value);
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });

  app.get("/api/fs/xlsx-html", async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.code(400).send({ error: "missing path" });
    if (!isSafePath(filePath, getAllowedRoots())) {
      return reply.code(403).send({ error: "path not allowed" });
    }
    try {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount === 0) {
        return reply.type("text/plain").send("");
      }
      const esc = (s) => String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      let html = "<table>";
      sheet.eachRow((row) => {
        html += "<tr>";
        for (let i = 1; i <= sheet.columnCount; i++) {
          html += `<td>${esc(row.getCell(i).text)}</td>`;
        }
        html += "</tr>";
      });
      html += "</table>";
      reply.type("text/plain").send(html);
    } catch {
      reply.code(404).send({ error: "file not found" });
    }
  });
}
