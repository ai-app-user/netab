#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { execSync } from "node:child_process";

function usage() {
  return `Usage:
  node scripts/android_publish.mjs \\
    --app <android_deployer|app_tester> \\
    --channel <dev|beta|stable> \\
    --apk <path.apk> \\
    --dest-root <dir> \\
    --base-url <https://host/path> \\
    --package-name <android.package.name> \\
    --version-code <int> \\
    --version-name <string> \\
    [--git-commit <sha>] \\
    [--built-at <iso8601>] \\
    [--min-sdk <int>] \\
    [--min-deployer-version <int>] \\
    [--notes-file <path>]`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected token: ${token}\n${usage()}`);
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}\n${usage()}`);
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing required --${key}\n${usage()}`);
  }
  return value;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function gitCommitOrFallback(value) {
  if (value) {
    return value;
  }
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "local";
  }
}

async function sha256Of(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function readReleaseNotes(notesFile) {
  if (!notesFile) {
    return [];
  }
  const raw = await readFile(notesFile, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function upsertChannelIndex(indexJson, manifest) {
  const apps = Array.isArray(indexJson.apps) ? indexJson.apps : [];
  const existing = apps.find((app) => app.appId === manifest.appId);
  const channelInfo = {
    channel: manifest.channel,
    latestUrl: `./${manifest.appId}/${manifest.channel}/latest.json`,
    apkUrl: `./${manifest.appId}/${manifest.channel}/builds/${manifest.apkFileName}`,
    packageName: manifest.packageName,
    versionCode: manifest.versionCode,
    versionName: manifest.versionName,
  };

  if (!existing) {
    apps.push({
      appId: manifest.appId,
      packageName: manifest.packageName,
      channels: [channelInfo],
    });
  } else {
    existing.packageName = manifest.packageName;
    const channel = Array.isArray(existing.channels)
      ? existing.channels.find((item) => item.channel === manifest.channel)
      : null;
    if (!channel) {
      existing.channels = [...(existing.channels ?? []), channelInfo];
    } else {
      Object.assign(channel, channelInfo);
    }
  }

  apps.sort((a, b) => String(a.appId).localeCompare(String(b.appId)));
  for (const app of apps) {
    app.channels.sort((a, b) => String(a.channel).localeCompare(String(b.channel)));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    apps,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInstallPage(indexJson) {
  const apps = Array.isArray(indexJson.apps) ? indexJson.apps : [];
  const cards = apps
    .map((app) => {
      const channels = Array.isArray(app.channels) ? app.channels : [];
      const channelLinks = channels
        .map((channel) => {
          const latestUrl = channel.latestUrl;
          return `
          <div class="channel">
            <div><strong>${escapeHtml(channel.channel)}</strong></div>
            <div>Version: ${escapeHtml(channel.versionName)} (${escapeHtml(channel.versionCode)})</div>
            <div><a href="${escapeHtml(latestUrl)}">Manifest</a></div>
            <div><a href="${escapeHtml(channel.apkUrl)}">Download APK</a></div>
          </div>`;
        })
        .join("\n");

      return `
      <section class="card">
        <h2>${escapeHtml(app.appId)}</h2>
        <p class="muted">Package: ${escapeHtml(app.packageName)}</p>
        ${channelLinks}
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Netab Android Downloads</title>
  <style>
    :root {
      --bg: #f4efe4;
      --panel: #fffaf0;
      --ink: #1d2733;
      --muted: #5e6b76;
      --accent: #0d6b57;
      --line: #d8cdb8;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", sans-serif;
      background: linear-gradient(180deg, #efe2c2 0%, var(--bg) 28%, #f9f6ef 100%);
      color: var(--ink);
    }
    main {
      max-width: 860px;
      margin: 0 auto;
      padding: 28px 18px 48px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 2rem;
    }
    .intro {
      color: var(--muted);
      margin-bottom: 22px;
      line-height: 1.45;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 22px;
    }
    .actions a {
      display: inline-block;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--accent);
      color: white;
      text-decoration: none;
      font-weight: 600;
    }
    .actions a.secondary {
      background: white;
      color: var(--accent);
      border: 1px solid var(--line);
    }
    .grid {
      display: grid;
      gap: 14px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(38, 45, 55, 0.06);
    }
    .card h2 {
      margin: 0 0 8px;
    }
    .channel {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--line);
      line-height: 1.45;
    }
    a {
      color: var(--accent);
    }
    .muted {
      color: var(--muted);
      font-size: 0.95rem;
    }
    code {
      background: #efe7d4;
      padding: 0.15rem 0.35rem;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Netab Android Downloads</h1>
    <p class="intro">
      First-time Fire tablet flow: install <code>android_deployer</code> from this page in the browser, then use it for later updates.
      Heavy native development can still use <code>adb install -r</code>.
    </p>
    <div class="actions">
      <a href="./android_deployer/stable/latest.json">Android Deployer Manifest</a>
      <a href="./app_tester/dev/latest.json" class="secondary">App Tester Manifest</a>
      <a href="./index.json" class="secondary">Raw index.json</a>
    </div>
    <div class="grid">
      ${cards || '<section class="card"><p>No Android artifacts published yet.</p></section>'}
    </div>
  </main>
</body>
</html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const appId = required(options, "app");
  const channel = required(options, "channel");
  const apk = resolve(required(options, "apk"));
  const destRoot = resolve(required(options, "dest-root"));
  const baseUrl = normalizeBaseUrl(required(options, "base-url"));
  const packageName = required(options, "package-name");
  const versionCode = Number(required(options, "version-code"));
  const versionName = required(options, "version-name");
  const minSdk = Number(options["min-sdk"] ?? "26");
  const minDeployerVersion = Number(options["min-deployer-version"] ?? "1");
  const gitCommit = gitCommitOrFallback(options["git-commit"]);
  const builtAt = options["built-at"] ?? new Date().toISOString();
  const releaseNotes = await readReleaseNotes(options["notes-file"]);

  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error(`version-code must be a positive integer; received ${options["version-code"]}`);
  }
  if (!Number.isInteger(minSdk) || minSdk <= 0) {
    throw new Error(`min-sdk must be a positive integer; received ${options["min-sdk"] ?? "26"}`);
  }

  const apkStats = await stat(apk);
  const sha256 = await sha256Of(apk);
  const gitShort = gitCommit.slice(0, 7) || "local";
  const apkFileName = `${appId}-v${versionCode}-${gitShort}.apk`;

  const channelDir = join(destRoot, appId, channel);
  const buildsDir = join(channelDir, "builds");
  const stagedApk = join(buildsDir, apkFileName);
  const latestPath = join(channelDir, "latest.json");
  const latestUrl = `./latest.json`;
  const apkUrl = `./builds/${apkFileName}`;

  await mkdir(buildsDir, { recursive: true });
  await copyFile(apk, stagedApk);

  const manifest = {
    schemaVersion: 1,
    appId,
    channel,
    packageName,
    versionCode,
    versionName,
    gitCommit,
    builtAt,
    apkFileName,
    apkUrl,
    latestUrl,
    sha256,
    sizeBytes: apkStats.size,
    minAndroidSdk: minSdk,
    minDeployerVersion,
    releaseNotes,
    sourceApkName: basename(apk),
  };

  await writeFile(latestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const indexPath = join(destRoot, "index.json");
  const currentIndex = await readJsonIfExists(indexPath, { schemaVersion: 1, apps: [] });
  const updatedIndex = upsertChannelIndex(currentIndex, manifest);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify(updatedIndex, null, 2)}\n`, "utf8");
  await writeFile(join(destRoot, "index.html"), `${renderInstallPage(updatedIndex)}\n`, "utf8");

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        appId,
        channel,
        stagedApk,
        latestPath,
        apkUrl,
        latestUrl,
        sha256,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
