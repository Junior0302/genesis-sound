const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const archiver = require('archiver');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const MAX_URLS = 10;
const MAX_PARALLEL = 2;
const JOB_TTL_MS = 1000 * 60 * 60;

const tempRoot = path.join(__dirname, 'temp');
const localBinaryRoot = path.join(__dirname, 'bin');
const jobs = new Map();
const queue = [];
let activeCount = 0;

const allowedOrigins = new Set(
  FRONTEND_ORIGIN.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function isAllowedOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (allowedOrigins.has(origin)) {
    return true;
  }

  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
}

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('CORS origin not allowed'));
    },
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      message:
        "Le service reçoit trop de demandes en ce moment. Merci de patienter quelques instants avant de recommencer.",
    },
  }),
);

const toolState = {
  ytDlp: false,
  ffmpeg: false,
  ytDlpPath: YT_DLP_PATH,
  ffmpegPath: FFMPEG_PATH,
};

function probeBinary(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, {
      stdio: 'ignore',
      shell: false,
      timeout: 30000,
    });
    return result.status === 0;
  } catch (error) {
    return false;
  }
}

function listExistingPaths(paths) {
  return paths.filter((candidate, index) => {
    if (!candidate || paths.indexOf(candidate) !== index) {
      return false;
    }

    if (candidate === 'yt-dlp' || candidate === 'ffmpeg') {
      return true;
    }

    return fs.existsSync(candidate);
  });
}

function findWingetFfmpegPaths() {
  const wingetPackageRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Packages',
  );

  if (!wingetPackageRoot || !fs.existsSync(wingetPackageRoot)) {
    return [];
  }

  try {
    const packageDirs = fs
      .readdirSync(wingetPackageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Gyan.FFmpeg_'))
      .map((entry) => path.join(wingetPackageRoot, entry.name));

    const candidates = [];

    for (const packageDir of packageDirs) {
      const nestedDirs = fs
        .readdirSync(packageDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('ffmpeg'))
        .map((entry) => path.join(packageDir, entry.name, 'bin', 'ffmpeg.exe'));

      candidates.push(...nestedDirs);
    }

    return candidates.filter((candidate) => fs.existsSync(candidate));
  } catch (error) {
    return [];
  }
}

function resolveBinaryPath(candidates, versionArgs) {
  for (const candidate of candidates) {
    if (probeBinary(candidate, versionArgs)) {
      return candidate;
    }
  }

  return null;
}

function refreshToolState() {
  const ytDlpCandidates = listExistingPaths([
    process.env.YT_DLP_PATH,
    path.join(localBinaryRoot, 'yt-dlp.exe'),
    YT_DLP_PATH,
    'yt-dlp',
  ]);

  const ffmpegCandidates = listExistingPaths([
    process.env.FFMPEG_PATH,
    FFMPEG_PATH,
    'ffmpeg',
    ...findWingetFfmpegPaths(),
  ]);

  toolState.ytDlpPath = resolveBinaryPath(ytDlpCandidates, ['--version']);
  toolState.ffmpegPath = resolveBinaryPath(ffmpegCandidates, ['-version']);
  toolState.ytDlp = Boolean(toolState.ytDlpPath);
  toolState.ffmpeg = Boolean(toolState.ffmpegPath);
}

function ensureTempRoot() {
  return fsPromises.mkdir(tempRoot, { recursive: true });
}

function normalizeUrls(input) {
  const rawList = Array.isArray(input)
    ? input
    : String(input || '')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);

  const unique = [...new Set(rawList)];
  return unique;
}

function isValidYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '');
    const isYoutubeHost =
      hostname === 'youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'm.youtube.com';

    if (!isYoutubeHost) {
      return false;
    }

    if (hostname === 'youtu.be') {
      return url.pathname.length > 1;
    }

    return url.searchParams.has('v') || url.pathname.startsWith('/shorts/');
  } catch (error) {
    return false;
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return '--:--';
  }

  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return [hours, minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
  }

  return [minutes, secs].map((value) => String(value).padStart(2, '0')).join(':');
}

function sanitizeFileName(value, fallback = 'genesis-audio') {
  const normalized = String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  const reservedNames = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);

  const trimmed = normalized.slice(0, 120).trim();
  if (!trimmed) {
    return fallback;
  }

  if (reservedNames.has(trimmed.toUpperCase())) {
    return `${fallback}-${Date.now()}`;
  }

  return trimmed;
}

function mapJobForClient(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    progress: job.progress,
    title: job.title,
    duration: job.duration,
    thumbnail: job.thumbnail,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    fileName: job.fileName,
    canDownload: Boolean(job.outputPath && job.status === 'completed'),
    downloadUrl: job.outputPath ? `/api/jobs/${job.id}/download` : null,
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function parsePercent(line) {
  const match = line.match(/(\d+(?:\.\d+)?)%/);
  if (!match) {
    return null;
  }

  return Math.max(0, Math.min(100, Number(match[1])));
}

function humanizeYtError(stderr) {
  const source = String(stderr || '').toLowerCase();

  if (source.includes('unsupported url') || source.includes('not a valid url')) {
    return 'Le lien fourni est invalide. Merci de verifier l URL YouTube.';
  }

  if (source.includes('video unavailable') || source.includes('private video')) {
    return 'Cette video est indisponible ou protegee. Essayez avec un autre lien.';
  }

  if (source.includes('sign in to confirm') || source.includes('bot')) {
    return "YouTube demande une verification supplementaire. Merci de reessayer plus tard.";
  }

  if (source.includes('certificate_verify_failed') || source.includes('ssl')) {
    return "La connexion securisee vers YouTube a ete refusee par l'environnement reseau. Un mode de compatibilite SSL a ete applique.";
  }

  if (source.includes('ffmpeg')) {
    return "FFmpeg est introuvable. Installez-le ou configurez la variable d'environnement FFMPEG_PATH.";
  }

  return "La conversion n'a pas pu aboutir pour ce lien. Merci de reessayer.";
}

async function fetchMetadata(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      toolState.ytDlpPath,
      ['--dump-single-json', '--no-playlist', '--no-warnings', '--no-check-certificates', url],
      {
        shell: false,
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || 'metadata_error'));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          title: data.title || 'Titre indisponible',
          duration: formatDuration(data.duration),
          thumbnail:
            data.thumbnail ||
            (Array.isArray(data.thumbnails) && data.thumbnails.length > 0
              ? data.thumbnails[data.thumbnails.length - 1].url
              : null),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function findMp3File(jobDir, jobId) {
  const files = await fsPromises.readdir(jobDir);
  const exactMatch = files.find((file) => file === `${jobId}.mp3`);

  if (exactMatch) {
    return path.join(jobDir, exactMatch);
  }

  const anyMp3 = files.find((file) => file.toLowerCase().endsWith('.mp3'));
  return anyMp3 ? path.join(jobDir, anyMp3) : null;
}

async function convertJob(job) {
  const jobDir = path.join(tempRoot, job.id);
  await fsPromises.mkdir(jobDir, { recursive: true });

  updateJob(job, {
    status: 'converting',
    progress: 5,
    workingDirectory: jobDir,
    error: null,
  });

  const args = [
    '--no-playlist',
    '--newline',
    '--no-check-certificates',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '-o',
    path.join(jobDir, `${job.id}.%(ext)s`),
    job.url,
  ];

  if (toolState.ffmpegPath) {
    args.unshift(toolState.ffmpegPath);
    args.unshift('--ffmpeg-location');
  }

  await new Promise((resolve, reject) => {
    const child = spawn(toolState.ytDlpPath, args, {
      shell: false,
      windowsHide: true,
    });

    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        const percent = parsePercent(line);
        if (percent !== null) {
          updateJob(job, {
            status: percent >= 100 ? 'converting' : 'downloading',
            progress: percent >= 100 ? 92 : Math.min(90, Math.round(percent)),
          });
        }

        if (line.includes('Destination')) {
          updateJob(job, { status: 'downloading', progress: Math.max(job.progress, 8) });
        }

        if (line.includes('ExtractAudio')) {
          updateJob(job, { status: 'converting', progress: Math.max(job.progress, 94) });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || 'conversion_error'));
        return;
      }

      resolve();
    });
  });

  const outputPath = await findMp3File(jobDir, job.id);
  if (!outputPath) {
    throw new Error('output_missing');
  }

  const baseName = sanitizeFileName(job.title, `genesis-audio-${job.id}`);
  const namedOutputPath = path.join(jobDir, `${baseName}.mp3`);

  if (outputPath !== namedOutputPath) {
    await fsPromises.rename(outputPath, namedOutputPath);
  }

  updateJob(job, {
    status: 'completed',
    progress: 100,
    outputPath: namedOutputPath,
    fileName: path.basename(namedOutputPath),
  });
}

function processQueue() {
  while (activeCount < MAX_PARALLEL && queue.length > 0) {
    const job = queue.shift();

    if (!job || job.status === 'error') {
      continue;
    }

    activeCount += 1;

    convertJob(job)
      .catch((error) => {
        updateJob(job, {
          status: 'error',
          progress: 0,
          error: humanizeYtError(error.message),
        });
      })
      .finally(() => {
        activeCount -= 1;
        processQueue();
      });
  }
}

async function prepareJob(job) {
  if (!toolState.ytDlp) {
    updateJob(job, {
      status: 'error',
      error:
        "yt-dlp est introuvable sur ce serveur. Installez-le ou configurez la variable d'environnement YT_DLP_PATH.",
    });
    return;
  }

  if (!toolState.ffmpeg) {
    updateJob(job, {
      status: 'error',
      error:
        "FFmpeg est introuvable sur ce serveur. Installez-le ou configurez la variable d'environnement FFMPEG_PATH.",
    });
    return;
  }

  try {
    updateJob(job, { status: 'preparing', progress: 2 });
    const metadata = await fetchMetadata(job.url);
    updateJob(job, {
      title: metadata.title,
      duration: metadata.duration,
      thumbnail: metadata.thumbnail,
      status: 'queued',
      progress: 0,
    });
    queue.push(job);
    processQueue();
  } catch (error) {
    updateJob(job, {
      status: 'error',
      progress: 0,
      error: humanizeYtError(error.message),
    });
  }
}

async function cleanupExpiredJobs() {
  const now = Date.now();
  const expiredJobs = [];

  for (const job of jobs.values()) {
    const createdAt = new Date(job.createdAt).getTime();
    if (now - createdAt > JOB_TTL_MS) {
      expiredJobs.push(job);
    }
  }

  await Promise.all(
    expiredJobs.map(async (job) => {
      if (job.workingDirectory) {
        await fsPromises.rm(job.workingDirectory, { recursive: true, force: true });
      }
      jobs.delete(job.id);
    }),
  );
}

app.get('/api/health', (req, res) => {
  refreshToolState();

  res.json({
    ok: true,
    message:
      toolState.ytDlp && toolState.ffmpeg
        ? 'Genesis Audio est pret a convertir vos liens.'
        : "Configuration requise: installez yt-dlp et FFmpeg pour activer les conversions.",
    tools: {
      ytDlp: toolState.ytDlp,
      ffmpeg: toolState.ffmpeg,
      ytDlpPath: toolState.ytDlpPath,
      ffmpegPath: toolState.ffmpegPath,
    },
    limits: {
      maxUrls: MAX_URLS,
      parallelConversions: MAX_PARALLEL,
    },
  });
});

app.post('/api/jobs', async (req, res) => {
  const urls = normalizeUrls(req.body?.urls ?? req.body?.text);

  if (urls.length === 0) {
    res.status(400).json({
      message: 'Ajoutez au moins un lien YouTube pour lancer une conversion.',
    });
    return;
  }

  if (urls.length > MAX_URLS) {
    res.status(400).json({
      message: `La plateforme accepte jusqu'a ${MAX_URLS} liens simultanes.`,
    });
    return;
  }

  const invalidUrls = urls.filter((url) => !isValidYoutubeUrl(url));
  if (invalidUrls.length > 0) {
    res.status(400).json({
      message: 'Un ou plusieurs liens sont invalides. Verifiez chaque URL YouTube puis recommencez.',
      invalidUrls,
    });
    return;
  }

  const createdJobs = urls.map((url) => {
    const job = {
      id: uuidv4(),
      url,
      title: 'Analyse de la video en cours',
      duration: '--:--',
      thumbnail: null,
      progress: 0,
      status: 'preparing',
      error: null,
      outputPath: null,
      fileName: null,
      workingDirectory: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    jobs.set(job.id, job);
    prepareJob(job);
    return mapJobForClient(job);
  });

  res.status(202).json({
    message: `${createdJobs.length} conversion(s) ajoutee(s) a la file d'attente.`,
    jobs: createdJobs,
  });
});

app.get('/api/jobs', (req, res) => {
  const ids = String(req.query.ids || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const result = ids.length
    ? ids.map((id) => jobs.get(id)).filter(Boolean).map(mapJobForClient)
    : [...jobs.values()].map(mapJobForClient);

  res.json({ jobs: result });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || !job.outputPath || job.status !== 'completed') {
    res.status(404).json({
      message: "Le fichier MP3 demande n'est pas encore disponible.",
    });
    return;
  }

  res.download(job.outputPath, job.fileName || `${job.id}.mp3`);
});

app.post('/api/jobs/download-all', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const completedJobs = ids
    .map((id) => jobs.get(id))
    .filter((job) => job && job.status === 'completed' && job.outputPath);

  if (completedJobs.length === 0) {
    res.status(400).json({
      message: 'Aucun MP3 pret au telechargement grouppe.',
    });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="genesis-audio-mp3.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (error) => {
    res.status(500).end(error.message);
  });

  archive.pipe(res);
  completedJobs.forEach((job) => {
    archive.file(job.outputPath, { name: job.fileName || `${job.id}.mp3` });
  });
  await archive.finalize();
});

app.use((req, res) => {
  res.status(404).json({
    message: 'La ressource demandee est introuvable.',
  });
});

app.use((error, req, res, next) => {
  res.status(500).json({
    message: error?.message || 'Une erreur serveur est survenue.',
  });
});

ensureTempRoot()
  .then(() => {
    refreshToolState();
    setInterval(cleanupExpiredJobs, 10 * 60 * 1000).unref();

    app.listen(PORT, () => {
      console.log(`Genesis Audio API active sur http://localhost:${PORT}`);
      console.log(`yt-dlp disponible: ${toolState.ytDlp ? 'oui' : 'non'}`);
      console.log(`ffmpeg disponible: ${toolState.ffmpeg ? 'oui' : 'non'}`);
      console.log(`chemin yt-dlp: ${toolState.ytDlpPath || 'non detecte'}`);
      console.log(`chemin ffmpeg: ${toolState.ffmpegPath || 'non detecte'}`);
    });
  })
  .catch((error) => {
    console.error("Impossible d'initialiser le serveur:", error);
    process.exit(1);
  });
