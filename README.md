# Genesis Audio

Plateforme web premium pour convertir des liens YouTube en fichiers MP3, avec interface responsive React et API Node.js/Express.

## Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Outils systeme: `yt-dlp`, `ffmpeg`

## Fonctionnalites

- Saisie de 1 a 10 liens YouTube
- Validation des URLs
- Recuperation des metadonnees video
- File d attente avec conversions paralleles limitees
- Suivi de progression par lien
- Telechargement individuel des MP3
- Telechargement global en archive ZIP
- Nettoyage automatique des fichiers temporaires
- Limitation de requetes sur l API

## Installation

### 1. Installer les dependances JavaScript

```bash
cd frontend
npm install

cd ../backend
npm install
```

### 2. Installer les outils systeme

Le backend a besoin de `yt-dlp` et `ffmpeg`.

Dans cette version du projet:

- `yt-dlp` est deja present localement dans `backend/bin/yt-dlp.exe`
- `ffmpeg` est detecte automatiquement s il est installe sur Windows

Installation recommandee de `ffmpeg` avec `winget`:

```powershell
winget install Gyan.FFmpeg
```

Si vous souhaitez forcer des chemins explicites, vous pouvez definir:

```powershell
$env:YT_DLP_PATH="C:\chemin\vers\yt-dlp.exe"
$env:FFMPEG_PATH="C:\chemin\vers\ffmpeg.exe"
```

## Lancement

### Backend

```bash
cd backend
npm run dev
```

API par defaut: `http://localhost:3001`

### Frontend

```bash
cd frontend
npm run dev
```

Application par defaut: `http://localhost:5173`

## Variables d environnement

### Backend

- `PORT`: port du serveur Express
- `FRONTEND_ORIGIN`: origine autorisee CORS, par defaut `http://localhost:5173`
- `YT_DLP_PATH`: chemin vers `yt-dlp`
- `FFMPEG_PATH`: chemin vers `ffmpeg`

Exemple de fichier:

```bash
cd backend
copy .env.example .env
```

### Frontend

- `VITE_API_BASE`: base URL de l API, par defaut `http://localhost:3001/api`

Exemple de fichier:

```bash
cd frontend
copy .env.example .env
```

## Verification

- Build frontend: `cd frontend && npm run build`
- Verification syntaxe backend: `cd backend && node --check server.js`

## GitHub

Initialisation locale du depot:

```bash
git init
git add .
git commit -m "Initial commit - Genesis Audio"
```

Connexion a un depot GitHub:

```bash
git branch -M main
git remote add origin https://github.com/VOTRE-COMPTE/genesis-audio.git
git push -u origin main
```

## Deploiement Vercel

Vercel convient tres bien pour le frontend React/Vite, mais pas pour ce backend de conversion en l etat:

- le backend depend de `yt-dlp` et `ffmpeg`
- les conversions peuvent prendre du temps
- Vercel serverless n est pas adapte a ce type de traitement long et a ces binaires systeme

Recommandation:

- deployer `frontend/` sur Vercel
- deployer `backend/` sur un service Node dedie comme Railway, Render ou un VPS

### Frontend sur Vercel

1. Importer le projet GitHub dans Vercel
2. Definir `frontend` comme `Root Directory`
3. Ajouter la variable d environnement `VITE_API_BASE` avec l URL publique du backend
4. Lancer le deployement

La configuration SPA est deja prete dans `frontend/vercel.json`.

Exemple:

```env
VITE_API_BASE=https://votre-backend-public.example.com/api
```

## Notes

- Les conversions sont actives si `backend/bin/yt-dlp.exe` est present et si `ffmpeg` est detecte ou configure.
- En environnement reseau filtre, le backend active un mode de compatibilite SSL pour `yt-dlp`.
- Les fichiers temporaires sont conserves temporairement puis supprimes automatiquement.
