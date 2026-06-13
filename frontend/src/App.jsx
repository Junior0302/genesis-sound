import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001/api'
const MAX_URLS = 10
const APP_FOLDER_NAME = 'Genesis Audio'

const statusConfig = {
  preparing: { label: 'Preparation' },
  queued: { label: 'File active' },
  downloading: { label: 'Capture' },
  converting: { label: 'MP3' },
  completed: { label: 'Pret' },
  error: { label: 'Erreur' },
}

const sampleLinks = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=3JZ_D3ELwOQ',
  'https://youtu.be/kJQP7kiw5Fk',
]

const navItems = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'convert', label: 'Convertisseur' },
  { id: 'results', label: 'Conversions' },
  { id: 'player', label: 'Lecteur' },
]

function mergeJobs(previousJobs, nextJobs) {
  const map = new Map(previousJobs.map((job) => [job.id, job]))
  nextJobs.forEach((job) => {
    map.set(job.id, { ...map.get(job.id), ...job })
  })
  return [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

function prettyDate(value) {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  }).format(new Date(value))
}

function sanitizeFileName(name) {
  return String(name || 'audio.mp3')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatTrackTitle(name) {
  return name.replace(/\.mp3$/i, '').replace(/[_-]+/g, ' ').trim()
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return ''
  }

  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${Math.round(value / 1024)} KB`
}

function App() {
  const audioRef = useRef(null)
  const objectUrlsRef = useRef([])

  const [inputValue, setInputValue] = useState('')
  const [jobs, setJobs] = useState([])
  const [feedback, setFeedback] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [health, setHealth] = useState({
    loading: true,
    ok: false,
    message: '',
    tools: { ytDlp: false, ffmpeg: false },
    limits: { maxUrls: MAX_URLS, parallelConversions: 2 },
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDownloadingAll, setIsDownloadingAll] = useState(false)
  const [library, setLibrary] = useState([])
  const [libraryError, setLibraryError] = useState('')
  const [currentTrackId, setCurrentTrackId] = useState('')
  const [folderLabel, setFolderLabel] = useState('')
  const [musicDirectoryHandle, setMusicDirectoryHandle] = useState(null)
  const [isSyncingLibrary, setIsSyncingLibrary] = useState(false)
  const [currentView, setCurrentView] = useState('dashboard')

  const directoryAccessSupported =
    typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

  const inputUrls = useMemo(
    () =>
      inputValue
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [inputValue],
  )

  const completedJobs = useMemo(
    () => jobs.filter((job) => job.status === 'completed' && job.canDownload),
    [jobs],
  )

  const activeJobs = useMemo(
    () =>
      jobs.filter((job) =>
        ['preparing', 'queued', 'downloading', 'converting'].includes(job.status),
      ),
    [jobs],
  )

  const currentTrack = useMemo(
    () => library.find((track) => track.id === currentTrackId) || null,
    [currentTrackId, library],
  )

  useEffect(() => {
    let active = true

    async function loadHealth() {
      try {
        const response = await fetch(`${API_BASE}/health`)
        const data = await response.json()

        if (!active) {
          return
        }

        setHealth({
          loading: false,
          ok: data.ok,
          message: data.message,
          tools: data.tools,
          limits: data.limits,
        })
      } catch (error) {
        if (!active) {
          return
        }

        setHealth((current) => ({
          ...current,
          loading: false,
          ok: false,
          message: 'API indisponible',
        }))
      }
    }

    loadHealth()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (activeJobs.length === 0) {
      return undefined
    }

    const intervalId = window.setInterval(async () => {
      try {
        const response = await fetch(
          `${API_BASE}/jobs?ids=${activeJobs.map((job) => job.id).join(',')}`,
        )
        const data = await response.json()
        setJobs((current) => mergeJobs(current, data.jobs || []))
      } catch (error) {
        setSubmitError('Suivi temporairement indisponible.')
      }
    }, 2000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeJobs])

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current = []
    }
  }, [])

  useEffect(() => {
    if (!currentTrack && library.length > 0) {
      setCurrentTrackId(library[0].id)
    }
  }, [currentTrack, library])

  async function refreshLibrary(handle = musicDirectoryHandle) {
    if (!handle) {
      return
    }

    setIsSyncingLibrary(true)
    setLibraryError('')

    try {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current = []

      const tracks = []

      for await (const entry of handle.values()) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.mp3')) {
          continue
        }

        const file = await entry.getFile()
        const url = URL.createObjectURL(file)
        objectUrlsRef.current.push(url)

        tracks.push({
          id: `${entry.name}-${file.lastModified}`,
          name: formatTrackTitle(entry.name),
          fileName: entry.name,
          url,
          size: file.size,
          updatedAt: file.lastModified,
        })
      }

      tracks.sort((a, b) => b.updatedAt - a.updatedAt)
      setLibrary(tracks)

      if (tracks.length === 0) {
        setCurrentTrackId('')
      } else if (!tracks.some((track) => track.id === currentTrackId)) {
        setCurrentTrackId(tracks[0].id)
      }
    } catch (error) {
      setLibraryError("Impossible d'ouvrir les MP3 du dossier selectionne.")
    } finally {
      setIsSyncingLibrary(false)
    }
  }

  async function pickMusicFolder() {
    if (!directoryAccessSupported) {
      setLibraryError('Choisissez Chrome ou Edge pour relier un dossier local.')
      return null
    }

    try {
      const rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      const appFolderHandle = await rootHandle.getDirectoryHandle(APP_FOLDER_NAME, {
        create: true,
      })

      setMusicDirectoryHandle(appFolderHandle)
      setFolderLabel(`${rootHandle.name}/${APP_FOLDER_NAME}`)
      await refreshLibrary(appFolderHandle)
      setFeedback('Lecteur relie au dossier local.')
      return appFolderHandle
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setLibraryError("Le dossier n'a pas pu etre configure.")
      }
      return null
    }
  }

  async function ensureMusicFolder() {
    if (musicDirectoryHandle) {
      return musicDirectoryHandle
    }

    return pickMusicFolder()
  }

  async function saveBlobInMusicFolder(blob, fileName) {
    const directoryHandle = await ensureMusicFolder()
    if (!directoryHandle) {
      return false
    }

    const safeName = sanitizeFileName(fileName || `genesis-${Date.now()}.mp3`)
    const fileHandle = await directoryHandle.getFileHandle(safeName, { create: true })
    const writable = await fileHandle.createWritable()

    await writable.write(blob)
    await writable.close()
    await refreshLibrary(directoryHandle)
    return true
  }

  async function fetchBlob(url) {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error('Telechargement impossible.')
    }

    return response.blob()
  }

  function triggerBrowserDownload(url, fileName) {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function fillExampleLinks() {
    setInputValue(sampleLinks.join('\n'))
    setSubmitError('')
    setFeedback('')
    setCurrentView('convert')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFeedback('')
    setSubmitError('')

    if (inputUrls.length === 0) {
      setSubmitError('Ajoutez au moins un lien.')
      return
    }

    if (inputUrls.length > MAX_URLS) {
      setSubmitError(`Maximum ${MAX_URLS} liens.`)
      return
    }

    setIsSubmitting(true)

    try {
      const response = await fetch(`${API_BASE}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ urls: inputUrls }),
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || 'Une erreur est survenue.')
      }

      setFeedback(data.message)
      setJobs((current) => mergeJobs(current, data.jobs || []))
      setInputValue('')
      setCurrentView('results')
    } catch (error) {
      setSubmitError(error.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSaveJob(job) {
    if (!job?.canDownload) {
      return
    }

    setFeedback('')
    setSubmitError('')

    try {
      const fileUrl = `${API_BASE}/jobs/${job.id}/download`

      if (directoryAccessSupported) {
        const blob = await fetchBlob(fileUrl)
        const saved = await saveBlobInMusicFolder(blob, job.fileName || `${job.id}.mp3`)
        if (saved) {
          setFeedback('MP3 ajoute au dossier du lecteur.')
          setCurrentView('player')
          return
        }
      }

      triggerBrowserDownload(fileUrl, job.fileName || `${job.id}.mp3`)
      setFeedback('MP3 telecharge.')
    } catch (error) {
      setSubmitError(error.message || 'Le MP3 n a pas pu etre enregistre.')
    }
  }

  async function handleDownloadAll() {
    if (completedJobs.length === 0) {
      return
    }

    setSubmitError('')
    setFeedback('')
    setIsDownloadingAll(true)

    try {
      if (directoryAccessSupported) {
        for (const job of completedJobs) {
          const blob = await fetchBlob(`${API_BASE}/jobs/${job.id}/download`)
          await saveBlobInMusicFolder(blob, job.fileName || `${job.id}.mp3`)
        }

        setFeedback('Tous les MP3 ont ete ajoutes au dossier du lecteur.')
        setCurrentView('player')
        return
      }

      const response = await fetch(`${API_BASE}/jobs/download-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ids: completedJobs.map((job) => job.id) }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.message || 'Le ZIP n a pas pu etre genere.')
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      triggerBrowserDownload(url, 'genesis-audio-mp3.zip')
      window.URL.revokeObjectURL(url)
      setFeedback('Archive ZIP telechargee.')
    } catch (error) {
      setSubmitError(error.message)
    } finally {
      setIsDownloadingAll(false)
    }
  }

  return (
    <div className="app-shell">
      <div className="dashboard-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark">G</div>
            <div>
              <strong>Genesis Audio</strong>
              <span>Dashboard</span>
            </div>
          </div>

          <nav className="sidebar-nav">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sidebar-link ${currentView === item.id ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="sidebar-card">
            <span className="eyebrow">Etat</span>
            <div
              className={`topbar-status ${health.tools.ytDlp && health.tools.ffmpeg ? 'is-ready' : 'is-warning'}`}
            >
              <span className="status-dot" />
              {health.tools.ytDlp && health.tools.ffmpeg ? 'Pret' : 'Configuration'}
            </div>
          </div>

          <div className="sidebar-card sidebar-stack">
            <span>{MAX_URLS} liens max</span>
            <span>{completedJobs.length} MP3 prets</span>
            <span>{library.length} en lecture</span>
          </div>
        </aside>

        <div className="dashboard-main">
          <div className="topbar">
            <div className="brand-lockup">
              <div>
                <strong>Studio MP3</strong>
                <span>{health.loading ? 'Chargement...' : health.message}</span>
              </div>
            </div>
          </div>

          <div className="mobile-nav">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mobile-nav-link ${currentView === item.id ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <header
            className={`hero-section minimal-hero ${
              currentView === 'dashboard' ? '' : 'is-hidden'
            }`}
          >
            <div className="hero-copy slim-hero">
              <div className="hero-heading">
                <span className="eyebrow">Noir / Blanc / Vert</span>
                <h1>Convertir et ecouter.</h1>
              </div>

              <div className="hero-inline-meta">
                <span>{MAX_URLS} liens max</span>
                <span>{completedJobs.length} prets</span>
                <span>{library.length} en lecture</span>
              </div>

              <div className="hero-actions slim-actions">
                <a className="primary-button" href="#converter">
                  Convertir
                </a>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={pickMusicFolder}
                  disabled={!directoryAccessSupported}
                >
                  Lier dossier
                </button>
              </div>
            </div>
          </header>

          <main className="dashboard-content">
            <div className="workspace-column">
              <section
                id="converter"
                className={`converter-card ${
                  currentView === 'convert' || currentView === 'dashboard' ? '' : 'is-hidden'
                }`}
              >
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Convertisseur</span>
                    <h2>Liens YouTube</h2>
                  </div>
                  <button type="button" className="ghost-button" onClick={fillExampleLinks}>
                    Exemples
                  </button>
                </div>

                <form className="converter-form" onSubmit={handleSubmit}>
                  <textarea
                    id="youtube-links"
                    value={inputValue}
                    onChange={(event) => setInputValue(event.target.value)}
                    placeholder={`https://youtube.com/watch?v=xxxxx\nhttps://youtu.be/yyyyy`}
                    rows={7}
                  />

                  <div className="form-meta">
                    <span>
                      {inputUrls.length} / {MAX_URLS}
                    </span>
                    <span>{health.loading ? 'Verification...' : health.message}</span>
                  </div>

                  <div className="form-actions">
                    <button className="primary-button" type="submit" disabled={isSubmitting}>
                      {isSubmitting ? 'Envoi...' : 'Convertir en MP3'}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={handleDownloadAll}
                      disabled={completedJobs.length === 0 || isDownloadingAll}
                    >
                      {isDownloadingAll ? 'Sauvegarde...' : 'Tout envoyer au lecteur'}
                    </button>
                  </div>

                  {feedback ? <div className="message success">{feedback}</div> : null}
                  {submitError ? <div className="message error">{submitError}</div> : null}
                </form>
              </section>

              <section
                id="results"
                className={`results-section ${
                  currentView === 'results' || currentView === 'dashboard' ? '' : 'is-hidden'
                }`}
              >
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Resultats</span>
                    <h2>Conversions</h2>
                  </div>
                </div>

                {jobs.length === 0 ? (
                  <div className="empty-state">Les titres convertis apparaitront ici.</div>
                ) : (
                  <div className="results-list">
                    {jobs.map((job) => {
                      const status = statusConfig[job.status] || statusConfig.preparing

                      return (
                        <article className="result-card compact-result" key={job.id}>
                          <div className="thumbnail-wrapper">
                            {job.thumbnail ? (
                              <img src={job.thumbnail} alt={job.title} />
                            ) : (
                              <div className="thumbnail-placeholder">MP3</div>
                            )}
                          </div>

                          <div className="result-content">
                            <div className="result-topline">
                              <span className={`status-pill status-${job.status}`}>{status.label}</span>
                              <span className="result-date">{prettyDate(job.createdAt)}</span>
                            </div>

                            <h3>{job.title}</h3>

                            <div className="result-meta">
                              <span>{job.duration}</span>
                              <span>{job.progress}%</span>
                            </div>

                            <div className="progress-track" aria-hidden="true">
                              <span style={{ width: `${job.progress}%` }} />
                            </div>

                            {job.error ? <p className="status-detail">{job.error}</p> : null}

                            <div className="result-actions">
                              <button
                                type="button"
                                className={`download-button ${job.canDownload ? '' : 'disabled'}`}
                                onClick={() => handleSaveJob(job)}
                                disabled={!job.canDownload}
                              >
                                Sauver
                              </button>
                            </div>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>

            <section
              id="player"
              className={`player-card ${
                currentView === 'player' || currentView === 'dashboard' ? '' : 'is-hidden'
              }`}
            >
              <div className="panel-head">
                <div>
                  <span className="eyebrow">Lecteur</span>
                  <h2>Ma bibliotheque</h2>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => refreshLibrary()}
                  disabled={!musicDirectoryHandle || isSyncingLibrary}
                >
                  {isSyncingLibrary ? 'Scan...' : 'Rafraichir'}
                </button>
              </div>

              <div className="folder-strip">
                <span>{folderLabel || 'Aucun dossier relie'}</span>
                {!musicDirectoryHandle ? (
                  <button type="button" className="secondary-button" onClick={pickMusicFolder}>
                    Choisir
                  </button>
                ) : null}
              </div>

              <div className="now-playing">
                <div className="cover-disc">
                  <div className="disc-core" />
                </div>
                <div className="track-meta">
                  <strong>{currentTrack?.name || 'Aucun titre'}</strong>
                  <span>{currentTrack ? currentTrack.fileName : 'Reliez un dossier Genesis Audio'}</span>
                </div>
              </div>

              <audio
                ref={audioRef}
                className="audio-element"
                controls
                src={currentTrack?.url || undefined}
              />

              {libraryError ? <div className="message error small">{libraryError}</div> : null}
              {!directoryAccessSupported ? (
                <div className="message error small">
                  L acces dossier demande Chrome ou Edge.
                </div>
              ) : null}

              <div className="library-list">
                {library.length === 0 ? (
                  <div className="empty-library">Le dossier local sera utilise pour lire vos MP3.</div>
                ) : (
                  library.map((track) => (
                    <button
                      type="button"
                      key={track.id}
                      className={`track-row ${track.id === currentTrackId ? 'active' : ''}`}
                      onClick={() => setCurrentTrackId(track.id)}
                    >
                      <span>{track.name}</span>
                      <small>{formatBytes(track.size)}</small>
                    </button>
                  ))
                )}
              </div>
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}

export default App
