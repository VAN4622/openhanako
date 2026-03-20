import fs from "fs";
import os from "os";
import path from "path";
import { t } from "../i18n.js";

const MAX_FILES = 9;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function countFiles(p) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return 1;
    let count = 0;
    for (const entry of fs.readdirSync(p)) {
      count += countFiles(path.join(p, entry));
    }
    return count;
  } catch {
    return 0;
  }
}

function cleanOldUploads(uploadsDir) {
  try {
    if (!fs.existsSync(uploadsDir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
      const fullPath = path.join(uploadsDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function writeUploadedContent(uploadsDir, file) {
  const rawName = typeof file?.name === "string" ? file.name.trim() : "";
  const data = typeof file?.data === "string" ? file.data.trim() : "";
  if (!rawName || !data) {
    throw new Error("name and data are required");
  }

  const safeName = path.basename(rawName);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || "upload";
  const buf = Buffer.from(data, "base64");
  if (!buf.length) {
    throw new Error("Uploaded file is empty");
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`Uploaded file exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }

  const destName = `${base}_${Date.now().toString(36)}${ext}`;
  const destPath = path.join(uploadsDir, destName);
  fs.writeFileSync(destPath, buf);
  return {
    src: rawName,
    dest: destPath,
    name: safeName,
    isDirectory: false,
    size: buf.length,
  };
}

export default async function uploadRoute(app, { engine }) {
  app.post("/api/upload", async (req, reply) => {
    const { paths, files } = req.body || {};
    const hasPaths = Array.isArray(paths) && paths.length > 0;
    const hasFiles = Array.isArray(files) && files.length > 0;

    if (!hasPaths && !hasFiles) {
      return reply.code(400).send({ error: t("error.pathsRequired") });
    }

    let totalFiles = 0;
    if (hasPaths) {
      for (const p of paths) {
        totalFiles += countFiles(p);
      }
    }
    if (hasFiles) {
      totalFiles += files.length;
    }
    if (totalFiles > MAX_FILES) {
      return reply.code(400).send({
        error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
        totalFiles,
        max: MAX_FILES,
      });
    }

    const cwd = engine.cwd;
    const isRealCwd = cwd !== process.cwd();
    const uploadsDir = isRealCwd
      ? path.join(cwd, ".hanako-uploads")
      : path.join(os.tmpdir(), ".hanako-uploads");

    fs.mkdirSync(uploadsDir, { recursive: true });
    cleanOldUploads(uploadsDir);

    const results = [];

    if (hasPaths) {
      for (const srcPath of paths) {
        try {
          if (!path.isAbsolute(srcPath)) {
            results.push({ src: srcPath, error: "Path must be absolute" });
            continue;
          }
          if (!fs.existsSync(srcPath)) {
            results.push({ src: srcPath, error: t("error.pathNotFound") });
            continue;
          }

          const stat = fs.statSync(srcPath);
          const name = path.basename(srcPath);
          const timestamp = Date.now().toString(36);
          const isDir = stat.isDirectory();
          const ext = isDir ? "" : path.extname(srcPath);
          const base = isDir ? name : path.basename(srcPath, ext);
          const destName = `${base}_${timestamp}${ext}`;
          const destPath = path.join(uploadsDir, destName);

          if (isDir) {
            fs.cpSync(srcPath, destPath, { recursive: true });
          } else {
            fs.copyFileSync(srcPath, destPath);
          }

          results.push({
            src: srcPath,
            dest: destPath,
            name,
            isDirectory: isDir,
          });
        } catch (err) {
          results.push({ src: srcPath, error: err.message });
        }
      }
    }

    if (hasFiles) {
      for (const file of files) {
        try {
          results.push(writeUploadedContent(uploadsDir, file));
        } catch (err) {
          results.push({ src: file?.name || null, error: err.message });
        }
      }
    }

    return { uploads: results, uploadsDir };
  });
}
