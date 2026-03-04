require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// CORS for extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads', 'youtube-transfer');

// In-memory token storage (per channel)
const tokens = {
  1: null,
  2: null
};

const channelInfo = {
  1: null,
  2: null
};

// Pending auth state
let pendingAuthChannel = null;

// OAuth2 client factory
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

// Get authenticated client for channel
function getAuthClient(channelNum) {
  if (!tokens[channelNum]) return null;
  const client = createOAuth2Client();
  client.setCredentials(tokens[channelNum]);
  return client;
}

// OAuth scopes
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/userinfo.profile',
];

// ================== OAuth Routes ==================

// Start OAuth flow for channel 1 or 2
app.get('/auth/channel/:num', (req, res) => {
  const channelNum = parseInt(req.params.num);
  if (channelNum !== 1 && channelNum !== 2) {
    return res.status(400).json({ error: 'Invalid channel number' });
  }

  pendingAuthChannel = channelNum;
  const oauth2Client = createOAuth2Client();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<script>window.close(); window.opener.authError("${error}");</script>`);
  }

  if (!code || pendingAuthChannel === null) {
    return res.send('<script>window.close(); window.opener.authError("No code or channel");</script>');
  }

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens: newTokens } = await oauth2Client.getToken(code);

    const channelNum = pendingAuthChannel;
    pendingAuthChannel = null;

    tokens[channelNum] = newTokens;
    oauth2Client.setCredentials(newTokens);

    // Get channel info
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
    const channelResponse = await youtube.channels.list({
      part: 'snippet',
      mine: true
    });

    if (channelResponse.data.items && channelResponse.data.items.length > 0) {
      const channel = channelResponse.data.items[0];
      channelInfo[channelNum] = {
        id: channel.id,
        title: channel.snippet.title,
        thumbnail: channel.snippet.thumbnails?.default?.url
      };
    }

    res.send(`
      <html>
        <body>
          <h2>Bağlantı başarılı!</h2>
          <p>Bu pencere kapanacak...</p>
          <script>
            if (window.opener) {
              window.opener.authSuccess(${channelNum});
            }
            setTimeout(() => window.close(), 1000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.send(`<script>window.close(); window.opener.authError("${err.message}");</script>`);
  }
});

// Disconnect channel
app.post('/auth/disconnect/:num', (req, res) => {
  const channelNum = parseInt(req.params.num);
  if (channelNum !== 1 && channelNum !== 2) {
    return res.status(400).json({ error: 'Invalid channel number' });
  }

  tokens[channelNum] = null;
  channelInfo[channelNum] = null;
  res.json({ success: true });
});

// Get channel status
app.get('/auth/status', (req, res) => {
  res.json({
    channel1: {
      connected: !!tokens[1],
      info: channelInfo[1]
    },
    channel2: {
      connected: !!tokens[2],
      info: channelInfo[2]
    }
  });
});

// ================== API Routes ==================

// Get video list for channel
app.get('/api/videos/:channel', async (req, res) => {
  const channelNum = parseInt(req.params.channel);
  const authClient = getAuthClient(channelNum);

  if (!authClient) {
    return res.status(401).json({ error: 'Channel not authenticated' });
  }

  try {
    const youtube = google.youtube({ version: 'v3', auth: authClient });

    // First get uploads playlist ID
    const channelResponse = await youtube.channels.list({
      part: 'contentDetails',
      mine: true
    });

    const uploadsPlaylistId = channelResponse.data.items[0]?.contentDetails?.relatedPlaylists?.uploads;

    if (!uploadsPlaylistId) {
      return res.json({ videos: [] });
    }

    // Get videos from uploads playlist
    const playlistResponse = await youtube.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 50
    });

    // Get video IDs for duration check
    const videoIds = playlistResponse.data.items.map(item => item.contentDetails.videoId).join(',');

    // Get video details including duration
    const videosResponse = await youtube.videos.list({
      part: 'contentDetails',
      id: videoIds
    });

    // Create duration map
    const durationMap = {};
    videosResponse.data.items.forEach(video => {
      // Parse ISO 8601 duration (PT1M30S = 1 min 30 sec)
      const duration = video.contentDetails.duration;
      const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const hours = parseInt(match[1] || 0);
        const minutes = parseInt(match[2] || 0);
        const seconds = parseInt(match[3] || 0);
        durationMap[video.id] = hours * 3600 + minutes * 60 + seconds;
      }
    });

    const videos = playlistResponse.data.items.map(item => {
      const videoId = item.contentDetails.videoId;
      const duration = durationMap[videoId] || 0;
      const isShort = duration > 0 && duration <= 60;

      return {
        id: videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        publishedAt: item.snippet.publishedAt,
        duration,
        isShort
      };
    });

    res.json({ videos });
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get video details
app.get('/api/video/:channel/:videoId', async (req, res) => {
  const channelNum = parseInt(req.params.channel);
  const { videoId } = req.params;
  const authClient = getAuthClient(channelNum);

  if (!authClient) {
    return res.status(401).json({ error: 'Channel not authenticated' });
  }

  try {
    const youtube = google.youtube({ version: 'v3', auth: authClient });

    const videoResponse = await youtube.videos.list({
      part: 'snippet,status',
      id: videoId
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const video = videoResponse.data.items[0];
    res.json({
      id: video.id,
      title: video.snippet.title,
      description: video.snippet.description,
      tags: video.snippet.tags || [],
      categoryId: video.snippet.categoryId,
      privacyStatus: video.status.privacyStatus
    });
  } catch (err) {
    console.error('Error fetching video details:', err);
    res.status(500).json({ error: err.message });
  }
});

// Active transfers for progress tracking
const activeTransfers = new Map();

// Transfer video
app.post('/api/transfer', async (req, res) => {
  const { videoId, isShort } = req.body;

  const sourceAuth = getAuthClient(1);
  const destAuth = getAuthClient(2);

  if (!sourceAuth || !destAuth) {
    return res.status(401).json({ error: 'Both channels must be authenticated' });
  }

  const transferId = `transfer_${Date.now()}`;
  activeTransfers.set(transferId, { status: 'starting', progress: 0 });

  res.json({ transferId });

  // Run transfer in background
  (async () => {
    const tempDir = path.join(os.tmpdir(), 'youtube-transfer');
    const tempFile = path.join(tempDir, `${videoId}.mp4`);

    try {
      // Create temp directory
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Get video details from source
      activeTransfers.set(transferId, { status: 'fetching_metadata', progress: 5 });

      const youtube = google.youtube({ version: 'v3', auth: sourceAuth });
      const videoResponse = await youtube.videos.list({
        part: 'snippet,status,contentDetails',
        id: videoId
      });

      if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
        throw new Error('Video not found');
      }

      const videoDetails = videoResponse.data.items[0];

      // Check if it's a Short based on duration
      const duration = videoDetails.contentDetails.duration;
      const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      let totalSeconds = 0;
      if (durationMatch) {
        const hours = parseInt(durationMatch[1] || 0);
        const minutes = parseInt(durationMatch[2] || 0);
        const seconds = parseInt(durationMatch[3] || 0);
        totalSeconds = hours * 3600 + minutes * 60 + seconds;
      }
      const detectedShort = isShort || totalSeconds <= 60;

      let title = videoDetails.snippet.title;
      let description = videoDetails.snippet.description;

      // Add #Shorts hashtag for Shorts if not already present
      if (detectedShort) {
        if (!title.toLowerCase().includes('#shorts')) {
          title = title + ' #Shorts';
        }
        if (!description.toLowerCase().includes('#shorts')) {
          description = description + '\n\n#Shorts';
        }
      }

      const metadata = {
        title,
        description,
        tags: videoDetails.snippet.tags || [],
        categoryId: videoDetails.snippet.categoryId || '22',
        privacyStatus: videoDetails.status.privacyStatus,
        isShort: detectedShort
      };

      // Download video using yt-dlp
      activeTransfers.set(transferId, { status: 'downloading', progress: 10, isShort: detectedShort });

      await downloadVideo(videoId, tempFile, detectedShort, (progress) => {
        activeTransfers.set(transferId, {
          status: 'downloading',
          progress: 10 + Math.floor(progress * 0.4), // 10-50%
          isShort: detectedShort
        });
      });

      // Upload to destination channel
      activeTransfers.set(transferId, { status: 'uploading', progress: 50, isShort: detectedShort });

      const destYoutube = google.youtube({ version: 'v3', auth: destAuth });

      const uploadResponse = await destYoutube.videos.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags,
            categoryId: metadata.categoryId
          },
          status: {
            privacyStatus: metadata.privacyStatus
          }
        },
        media: {
          body: fs.createReadStream(tempFile)
        }
      }, {
        onUploadProgress: (evt) => {
          const progress = (evt.bytesRead / fs.statSync(tempFile).size) * 100;
          activeTransfers.set(transferId, {
            status: 'uploading',
            progress: 50 + Math.floor(progress * 0.4), // 50-90%
            isShort: detectedShort
          });
        }
      });

      const newVideoId = uploadResponse.data.id;

      // Delete from source channel
      activeTransfers.set(transferId, { status: 'deleting_source', progress: 90, isShort: detectedShort });

      await youtube.videos.delete({ id: videoId });

      // Cleanup temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      activeTransfers.set(transferId, {
        status: 'completed',
        progress: 100,
        newVideoId,
        isShort: detectedShort
      });

    } catch (err) {
      console.error('Transfer error:', err);

      // Cleanup on error
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      activeTransfers.set(transferId, {
        status: 'error',
        error: err.message
      });
    }
  })();
});

// Get transfer progress
app.get('/api/transfer/:transferId', (req, res) => {
  const { transferId } = req.params;
  const transfer = activeTransfers.get(transferId);

  if (!transfer) {
    return res.status(404).json({ error: 'Transfer not found' });
  }

  res.json(transfer);
});

// Delete video
app.delete('/api/video/:channel/:videoId', async (req, res) => {
  const channelNum = parseInt(req.params.channel);
  const { videoId } = req.params;
  const authClient = getAuthClient(channelNum);

  if (!authClient) {
    return res.status(401).json({ error: 'Channel not authenticated' });
  }

  try {
    const youtube = google.youtube({ version: 'v3', auth: authClient });
    await youtube.videos.delete({ id: videoId });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting video:', err);
    res.status(500).json({ error: err.message });
  }
});

// Active downloads for progress tracking
const activeDownloads = new Map();

// Download video only (to local folder)
app.post('/api/download', async (req, res) => {
  const { videoId, isShort } = req.body;

  const sourceAuth = getAuthClient(1);
  const downloadId = `download_${Date.now()}`;
  activeDownloads.set(downloadId, { status: 'starting', progress: 0 });

  res.json({ downloadId });

  // Run download in background
  (async () => {
    try {
      // Create download directory
      if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      }

      // Get video metadata first
      let metadata = { videoId, isShort };

      if (sourceAuth) {
        activeDownloads.set(downloadId, { status: 'fetching_metadata', progress: 2 });

        const youtube = google.youtube({ version: 'v3', auth: sourceAuth });
        const videoResponse = await youtube.videos.list({
          part: 'snippet,status,contentDetails',
          id: videoId
        });

        if (videoResponse.data.items && videoResponse.data.items.length > 0) {
          const video = videoResponse.data.items[0];
          const duration = video.contentDetails.duration;
          const durationMatch = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          let totalSeconds = 0;
          if (durationMatch) {
            totalSeconds = (parseInt(durationMatch[1] || 0) * 3600) +
                          (parseInt(durationMatch[2] || 0) * 60) +
                          parseInt(durationMatch[3] || 0);
          }

          metadata = {
            videoId,
            title: video.snippet.title,
            description: video.snippet.description,
            tags: video.snippet.tags || [],
            categoryId: video.snippet.categoryId,
            privacyStatus: video.status.privacyStatus,
            duration: totalSeconds,
            isShort: isShort || totalSeconds <= 60
          };
        }
      }

      activeDownloads.set(downloadId, { status: 'downloading', progress: 5 });

      // Download with original filename
      const downloadedFile = await downloadVideoToFolder(videoId, DOWNLOAD_DIR, (progress) => {
        activeDownloads.set(downloadId, {
          status: 'downloading',
          progress: 5 + Math.floor(progress * 90)
        });
      });

      // Save metadata JSON
      const safeTitle = (metadata.title || videoId).replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s\-_]/g, '').substring(0, 100);
      const metadataPath = path.join(DOWNLOAD_DIR, `${safeTitle}.json`);
      metadata.filePath = path.join(DOWNLOAD_DIR, `${safeTitle}.mp4`);
      metadata.downloaded = new Date().toISOString();
      metadata.uploaded = false;

      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      activeDownloads.set(downloadId, {
        status: 'completed',
        progress: 100,
        folder: DOWNLOAD_DIR,
        metadata
      });

    } catch (err) {
      console.error('Download error:', err);
      activeDownloads.set(downloadId, {
        status: 'error',
        error: err.message
      });
    }
  })();
});

// Get download progress
app.get('/api/download/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const download = activeDownloads.get(downloadId);

  if (!download) {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.json(download);
});

// ================== Extension API ==================

// Get pending uploads (videos downloaded but not yet uploaded)
app.get('/api/pending-uploads', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      return res.json({ videos: [] });
    }

    const files = fs.readdirSync(DOWNLOAD_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const videos = jsonFiles.map(jsonFile => {
      try {
        const content = fs.readFileSync(path.join(DOWNLOAD_DIR, jsonFile), 'utf8');
        return JSON.parse(content);
      } catch (e) {
        return null;
      }
    }).filter(v => v !== null);

    res.json({ videos });
  } catch (err) {
    console.error('Pending uploads error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark video as uploaded
app.post('/api/mark-uploaded/:index', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      return res.status(404).json({ error: 'Download directory not found' });
    }

    const files = fs.readdirSync(DOWNLOAD_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const index = parseInt(req.params.index);

    if (index >= 0 && index < jsonFiles.length) {
      const jsonPath = path.join(DOWNLOAD_DIR, jsonFiles[index]);
      const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      content.uploaded = true;
      content.uploadedAt = new Date().toISOString();
      fs.writeFileSync(jsonPath, JSON.stringify(content, null, 2));
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Video not found' });
    }
  } catch (err) {
    console.error('Mark uploaded error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete downloaded video and metadata
app.delete('/api/pending-upload/:index', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      return res.status(404).json({ error: 'Download directory not found' });
    }

    const files = fs.readdirSync(DOWNLOAD_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const index = parseInt(req.params.index);

    if (index >= 0 && index < jsonFiles.length) {
      const jsonPath = path.join(DOWNLOAD_DIR, jsonFiles[index]);
      const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      // Delete video file
      if (content.filePath && fs.existsSync(content.filePath)) {
        fs.unlinkSync(content.filePath);
      }

      // Delete JSON file
      fs.unlinkSync(jsonPath);

      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Video not found' });
    }
  } catch (err) {
    console.error('Delete pending error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================== yt-dlp Functions ==================

function downloadVideoToFolder(videoId, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(outputDir, '%(title)s.%(ext)s');

    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '-o', outputTemplate,
      '--no-playlist',
      '--progress',
      '--print', 'after_move:filepath',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let lastProgress = 0;
    let downloadedFile = '';

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();

      // Capture final filepath
      if (output.includes('.mp4') && !output.includes('%')) {
        downloadedFile = output.trim();
      }

      const match = output.match(/(\d+\.?\d*)%/);
      if (match) {
        const progress = parseFloat(match[1]);
        if (progress > lastProgress) {
          lastProgress = progress;
          onProgress(progress / 100);
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      console.log('yt-dlp stderr:', data.toString());
    });

    ytdlp.on('close', (code) => {
      if (code === 0) resolve(downloadedFile);
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });

    ytdlp.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

function downloadVideo(videoId, outputPath, isShort, onProgress) {
  return new Promise((resolve, reject) => {
    // For Shorts, use best quality to preserve vertical format
    // For regular videos, use standard format selection
    const formatArg = isShort
      ? 'bestvideo+bestaudio/best'  // Best quality for Shorts
      : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';

    const ytdlp = spawn('yt-dlp', [
      '-f', formatArg,
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      '--progress',
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let lastProgress = 0;

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      // Parse progress from yt-dlp output
      const match = output.match(/(\d+\.?\d*)%/);
      if (match) {
        const progress = parseFloat(match[1]);
        if (progress > lastProgress) {
          lastProgress = progress;
          onProgress(progress / 100);
        }
      }
    });

    ytdlp.stderr.on('data', (data) => {
      console.log('yt-dlp stderr:', data.toString());
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    ytdlp.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });
  });
}

// ================== Start Server ==================

app.listen(PORT, () => {
  console.log(`YouTube Transfer Tool running at http://localhost:${PORT}`);
  console.log('');
  console.log('Make sure you have:');
  console.log('  1. yt-dlp installed (brew install yt-dlp)');
  console.log('  2. .env file with YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET');
  console.log('');
});
