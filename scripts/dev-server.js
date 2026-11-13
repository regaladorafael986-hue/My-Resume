// Local preview: serves the site and /api/jarvis the way Vercel does, using keys from .env.local.
// Usage: npm start   (then open http://localhost:3000)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 3000);

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(path.join(root, file));
  } catch {
    /* file not present */
  }
}

// Import after the env is loaded: the handler reads JARVIS_MODEL at load time.
const { default: jarvis } = await import(pathToFileURL(path.join(root, "api", "jarvis.js")).href);
const headers = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")).headers?.[0]?.headers ?? [];

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    for (const h of headers) res.setHeader(h.key, h.value);
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/jarvis") {
      return jarvis(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
    }
    const file = path.join(root, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
    const blocked = !file.startsWith(root + path.sep) || /[\\/](\.|node_modules)/.test(file.slice(root.length));
    if (blocked || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => {
    const keySet = Boolean(process.env.ANTHROPIC_API_KEY);
    console.log(`Portfolio running at http://localhost:${port}`);
    console.log(
      keySet
        ? `Jarvis is live (model: ${process.env.JARVIS_MODEL || "claude-opus-5-5"}).`
        : "Jarvis has no key yet: add ANTHROPIC_API_KEY to .env.local and restart."
    );
  });
