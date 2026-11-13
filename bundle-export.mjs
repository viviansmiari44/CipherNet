// bundle-export.mjs

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "share");
fs.mkdirSync(outDir, { recursive: true });

// Adjust this if bundles are too large for your upload limit.
const maxChars = 250000;

const allowedExtensions = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".prisma",
    ".sql",
    ".toml",
    ".md",
    ".txt",
    ".py",
]);

const excluded = [
    /node_modules/,
    /(^|\/)\.next\//,
    /(^|\/)\.env/,
    /(^|\/)\.git\//,
    /(^|\/)logs\//,
    /(__pycache__)/,
    /backend\.zip$/,
    /package-lock\.json$/,
    /next-env\.d\.ts$/,
    // Exclude sensitive files with private keys
    /vault\.txt$/,
    /user_trap_keys\.json$/,
    /withdrawal_addresses\.json$/,
];

const norm = (p) => p.split(path.sep).join("/");

// Directories to include in the bundle
const includeDirs = [
    "", // root level files
    "apas-frontend",
    "lib",
    "scripts",
    "src",
    "tools",
    "prisma"
];

function isAllowed(absPath) {
    const rel = norm(path.relative(root, absPath));
    const base = path.basename(absPath);

    // Allow example env files only
    if (base === ".env.example") {
        return true;
    }

    if (excluded.some((rx) => rx.test(rel))) {
        return false;
    }

    const ext = path.extname(absPath).toLowerCase();
    return allowedExtensions.has(ext);
}

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (
                entry.name === "node_modules" ||
                entry.name === ".next" ||
                entry.name === ".git" ||
                entry.name === "logs" ||
                entry.name === "__pycache__"
            ) {
                continue;
            }

            walk(abs, out);
        } else if (entry.isFile()) {
            if (isAllowed(abs)) {
                out.push(abs);
            }
        }
    }

    return out;
}

const files = includeDirs
    .flatMap((dir) => {
        const fullPath = path.join(root, dir);
        return walk(fullPath);
    })
    .sort((a, b) =>
        norm(path.relative(root, a)).localeCompare(norm(path.relative(root, b)))
    );

let current = [];
let currentSize = 0;
let bundleIndex = 1;

function writeBundle() {
    if (!current.length) return;

    const file = path.join(
        outDir,
        `bundle-${String(bundleIndex).padStart(3, "0")}.txt`
    );

    fs.writeFileSync(file, current.join("\n"), "utf8");
    console.log("Created", file);

    bundleIndex += 1;
    current = [];
    currentSize = 0;
}

for (const abs of files) {
    const rel = norm(path.relative(root, abs));
    const content = fs.readFileSync(abs, "utf8");

    const block = [
        "",
        `===== FILE: ${rel} =====`,
        content,
        `===== END FILE: ${rel} =====`,
        "",
    ].join("\n");

    if (currentSize + block.length > maxChars && current.length) {
        writeBundle();
    }

    current.push(block);
    currentSize += block.length;
}

writeBundle();

fs.writeFileSync(
    path.join(outDir, "file-list.txt"),
    files.map((abs) => norm(path.relative(root, abs))).join("\n"),
    "utf8"
);

console.log("Done.");
console.log(`Created ${bundleIndex - 1} bundle file(s) in ./share`);
console.log("Upload the files inside ./share, 5 at a time.");