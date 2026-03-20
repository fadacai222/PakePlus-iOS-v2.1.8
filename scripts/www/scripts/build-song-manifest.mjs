import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const songsRoot = path.join(projectRoot, "songs");
const outputPath = path.join(projectRoot, "song-manifest.js");

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function stripExtension(name) {
  const value = String(name || "");
  const lastDot = value.lastIndexOf(".");
  return lastDot > 0 ? value.slice(0, lastDot) : value;
}

function isJsonFile(name) {
  return /\.json$/i.test(name || "");
}

function isAudioFile(name) {
  return /\.(mp3|ogg|wav)$/i.test(name || "");
}

function isImageFile(name) {
  return /\.(jpg|jpeg|png|webp)$/i.test(name || "");
}

function encodeSongPath(...parts) {
  return (
    "./" +
    parts
      .map((part) =>
        String(part || "")
          .split(/[\\/]+/)
          .filter(Boolean)
          .map((segment) => encodeURIComponent(segment))
          .join("/"),
      )
      .filter(Boolean)
      .join("/")
  );
}

function buildPreferredBases(displayName, chartName, audioName) {
  const bases = [];
  const seen = new Set();
  const values = [displayName, chartName, audioName];

  for (const value of values) {
    const base = normalizeKey(stripExtension(value));
    if (base && !seen.has(base)) {
      seen.add(base);
      bases.push(base);
    }
  }

  for (const part of String(displayName || "").split("#")) {
    const base = normalizeKey(stripExtension(part));
    if (base && !seen.has(base)) {
      seen.add(base);
      bases.push(base);
    }
  }

  return bases;
}

function findFileByBase(files, bases) {
  for (const base of bases) {
    for (const file of files) {
      if (normalizeKey(stripExtension(file.name)) === base) {
        return file;
      }
    }
  }

  return null;
}

function chooseBestMediaPair(displayName, chartFiles, audioFiles) {
  for (const chart of chartFiles) {
    const chartBase = normalizeKey(stripExtension(chart.name));
    for (const audio of audioFiles) {
      const audioBase = normalizeKey(stripExtension(audio.name));
      if (chartBase && chartBase === audioBase) {
        return { chart, audio };
      }
    }
  }

  const preferredBases = buildPreferredBases(displayName, "", "");
  const preferredChart = findFileByBase(chartFiles, preferredBases);
  const preferredAudio = findFileByBase(audioFiles, preferredBases);

  if (preferredChart && preferredAudio) {
    return { chart: preferredChart, audio: preferredAudio };
  }

  if (preferredChart && audioFiles.length === 1) {
    return { chart: preferredChart, audio: audioFiles[0] };
  }

  if (preferredAudio && chartFiles.length === 1) {
    return { chart: chartFiles[0], audio: preferredAudio };
  }

  if (chartFiles.length > 0 && audioFiles.length > 0) {
    return { chart: chartFiles[0], audio: audioFiles[0] };
  }

  return null;
}

function chooseBestCover(displayName, imageFiles, pair) {
  if (!imageFiles.length) {
    return null;
  }

  for (const file of imageFiles) {
    if (/(bann|banner|cover|bg)/i.test(file.name)) {
      return file;
    }
  }

  const preferredBases = buildPreferredBases(
    displayName,
    pair?.chart?.name || "",
    pair?.audio?.name || "",
  );
  return findFileByBase(imageFiles, preferredBases) || imageFiles[0];
}

function buildSongAliases(displayName, pair) {
  const aliases = [];
  const seen = new Set();
  const rawValues = [displayName];

  if (pair?.chart) {
    rawValues.push(stripExtension(pair.chart.name));
  }
  if (pair?.audio) {
    rawValues.push(stripExtension(pair.audio.name));
  }

  for (const part of String(displayName || "").split("#")) {
    rawValues.push(part);
  }

  for (const value of rawValues) {
    const normalized = normalizeKey(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    aliases.push(value);
  }

  return aliases;
}

function readChartData(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function collectSongEntry(dirent) {
  const dirName = dirent.name;
  const dirPath = path.join(songsRoot, dirName);
  const fileDirents = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile());

  const chartFiles = [];
  const audioFiles = [];
  const imageFiles = [];

  for (const entry of fileDirents) {
    const file = { name: entry.name };
    if (isJsonFile(entry.name)) {
      chartFiles.push(file);
    } else if (isAudioFile(entry.name)) {
      audioFiles.push(file);
    } else if (isImageFile(entry.name)) {
      imageFiles.push(file);
    }
  }

  const pair = chooseBestMediaPair(dirName, chartFiles, audioFiles);
  if (!pair) {
    return null;
  }

  const cover = chooseBestCover(dirName, imageFiles, pair);
  const chartPath = path.join(dirPath, pair.chart.name);

  return {
    id: dirName,
    title: stripExtension(pair.audio.name || pair.chart.name || dirName),
    dirName,
    chartPath: encodeSongPath("songs", dirName, pair.chart.name),
    audioPath: encodeSongPath("songs", dirName, pair.audio.name),
    coverPath: cover ? encodeSongPath("songs", dirName, cover.name) : null,
    aliases: buildSongAliases(dirName, pair),
    source: "embedded-manifest",
    chartData: readChartData(chartPath),
  };
}

function buildManifest() {
  if (!fs.existsSync(songsRoot)) {
    throw new Error("songs directory not found");
  }

  const songs = fs
    .readdirSync(songsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(collectSongEntry)
    .filter(Boolean)
    .sort((a, b) => a.dirName.localeCompare(b.dirName, "zh-CN"));

  return {
    preferManifest: false,
    generatedAt: new Date().toISOString(),
    songs,
  };
}

const manifest = buildManifest();
const fileContent =
  "window.__LOCAL_SONG_MANIFEST__ = " +
  JSON.stringify(manifest) +
  ";\n";

fs.writeFileSync(outputPath, fileContent, "utf8");
console.log(
  `Wrote ${manifest.songs.length} songs to ${path.relative(projectRoot, outputPath)}`,
);
