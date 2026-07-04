const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const outFile = path.join(require("os").tmpdir(), "worker-" + Date.now() + ".js");
const esbuild = path.join(__dirname, "node_modules", ".bin", "esbuild.cmd");
const entry = path.join(__dirname, "index.ts");

execSync(
  `"${esbuild}" --bundle "${entry}" --outfile="${outFile}" --platform=neutral --format=esm --target=es2022`,
  { stdio: "pipe" }
);
const scriptContent = fs.readFileSync(outFile, "utf8");
console.log("Script size:", scriptContent.length, "bytes");

const metadata = JSON.stringify({
  main_module: "index.js",
  compatibility_date: "2025-09-01",
  bindings: [
    { name: "BRAIN_KEY", type: "plain_text", text: "Saraha-Brain-Key" },
    { name: "BRAVE_API_KEY", type: "plain_text", text: "" },
    { name: "CF_API_TOKEN", type: "plain_text", text: "" }, // REDACTED - set via GitHub Secrets / wrangler secret
    { name: "DB", type: "d1", database_id: "4e4e5fde-2207-478a-b1ed-d55d6cc35a91" },
    { name: "GH_PAT", type: "plain_text", text: "" }, // REDACTED - set via GitHub Secrets / wrangler secret
    { name: "ONE_KNOWLEDGE_KEY", type: "plain_text", text: "" }, // REDACTED - set via GitHub Secrets / wrangler secret
    { name: "VECTORIZE", type: "vectorize", index_name: "saraha-brain-memory" },
  ],
});

const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2, 15);
const encoder = new TextEncoder();
const parts = [];

function addPart(name, content, contentType, filename) {
  let header = "--" + boundary + "\r\n";
  if (filename) {
    header += 'Content-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\r\n';
  } else {
    header += 'Content-Disposition: form-data; name="' + name + '"\r\n';
  }
  if (contentType) header += "Content-Type: " + contentType + "\r\n";
  header += "\r\n";
  parts.push(encoder.encode(header));
  parts.push(typeof content === "string" ? encoder.encode(content) : content);
  parts.push(encoder.encode("\r\n"));
}

addPart("metadata", metadata, "application/json");
addPart("index.js", scriptContent, "application/javascript+module", "index.js");
parts.push(encoder.encode("--" + boundary + "--\r\n"));

const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
const body = new Uint8Array(totalLength);
let offset = 0;
for (const p of parts) {
  body.set(p, offset);
  offset += p.length;
}

console.log("Uploading", body.length, "bytes...");

fetch(
  "https://api.cloudflare.com/client/v4/accounts/913f3a2576a358054eba9a58a9573949/workers/scripts/saraha-brain",
  {
    method: "PUT",
    headers: {
      Authorization:
        "Bearer " + (process.env.CF_API_TOKEN || ""),
      "Content-Type": "multipart/form-data; boundary=" + boundary,
    },
    body: body,
  }
)
  .then((r) => r.json())
  .then((d) => {
    if (d.success) {
      console.log("SUCCESS! Script deployed");
    } else {
      console.log("FAILED:", JSON.stringify(d.errors, null, 2));
    }
    try { fs.unlinkSync(outFile); } catch {}
  })
  .catch((e) => {
    console.log("Error:", e.message);
    try { fs.unlinkSync(outFile); } catch {}
  });
