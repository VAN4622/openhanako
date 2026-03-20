import fs from "fs";
import os from "os";
import path from "path";

function isSafePath(filePath, allowedRoots) {
  const resolved = path.resolve(filePath);
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

function uniqueDirectoryRoots(candidates) {
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    if (!candidate?.path) continue;
    try {
      const resolved = path.resolve(candidate.path);
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory() || seen.has(resolved)) continue;
      seen.add(resolved);
      roots.push({ id: candidate.id, path: resolved });
    } catch {
      // Ignore missing or inaccessible directories.
    }
  }
  return roots;
}

function listDirectoriesOnly(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(dirPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

  function getDirectoryRoots() {
    return uniqueDirectoryRoots([
      { id: "workspace", path: engine.getHomeFolder?.() || engine.homeCwd },
      { id: "home", path: os.homedir() },
      { id: "current", path: engine.cwd },
    ]);
  }

  app.get("/api/fs/directories", async (req, reply) => {
    const roots = getDirectoryRoots();
    if (roots.length === 0) {
      return reply.code(500).send({ error: "no directory roots available" });
    }

    const requestedPath = typeof req.query.path === "string"
      ? req.query.path.trim()
      : "";
    const targetPath = requestedPath ? path.resolve(requestedPath) : roots[0].path;

    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      return reply.code(404).send({ error: "directory not found" });
    }

    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: "path is not a directory" });
    }

    const allowedRoots = roots.map((root) => root.path);
    if (!isSafePath(targetPath, allowedRoots)) {
      return reply.code(403).send({ error: "path not allowed" });
    }

    const parentCandidate = path.dirname(targetPath);
    const parentPath = parentCandidate !== targetPath && isSafePath(parentCandidate, allowedRoots)
      ? parentCandidate
      : null;

    return {
      roots,
      currentPath: targetPath,
      parentPath,
      directories: listDirectoriesOnly(targetPath),
    };
  });

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
