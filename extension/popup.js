const API_URL = 'http://localhost:3000';

let videos = [];
let selectedVideo = null;

// Check connection and load videos
async function init() {
  const statusEl = document.getElementById('status');
  const contentEl = document.getElementById('content');

  try {
    const res = await fetch(`${API_URL}/api/pending-uploads`);
    const data = await res.json();

    if (data.videos) {
      videos = data.videos;
      statusEl.className = 'status connected';
      statusEl.textContent = `${videos.length} videos pending upload`;

      if (videos.length === 0) {
        contentEl.innerHTML = `
          <div class="empty-state">
            <p>No videos to upload</p>
            <p style="margin-top: 10px; font-size: 12px;">
              Download videos from localhost:3000 first
            </p>
          </div>
        `;
      } else {
        renderVideos();
      }
    }
  } catch (err) {
    statusEl.className = 'status disconnected';
    statusEl.textContent = 'Server not connected (localhost:3000)';
    contentEl.innerHTML = `
      <div class="instructions">
        <p><strong>Setup:</strong></p>
        <ol>
          <li>Run: cd youtube-transfer && npm start</li>
          <li>Open localhost:3000</li>
          <li>Download videos using "Download Only"</li>
          <li>Use this extension</li>
        </ol>
      </div>
    `;
  }
}

function renderVideos() {
  const contentEl = document.getElementById('content');

  contentEl.innerHTML = `
    <div class="video-list">
      ${videos.map((video, index) => `
        <div class="video-item ${video.uploaded ? 'uploaded' : ''} ${selectedVideo === index ? 'selected' : ''}"
             data-index="${index}">
          <div class="video-thumb">
            ${video.isShort ? '📱' : '🎬'}
          </div>
          <div class="video-info">
            <div class="video-title">${escapeHtml(video.title)}</div>
            <div class="video-meta">
              ${video.isShort ? '<span class="shorts-badge">SHORTS</span>' : ''}
              ${video.uploaded ? '✓ Uploaded' : formatDuration(video.duration)}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
    <button id="upload-btn" class="btn btn-primary" ${!selectedVideo && selectedVideo !== 0 ? 'disabled' : ''}>
      Open in YouTube Studio
    </button>
    <button id="refresh-btn" class="btn btn-secondary">
      Refresh
    </button>
  `;

  document.querySelectorAll('.video-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.index);
      if (!videos[index].uploaded) {
        selectedVideo = index;
        renderVideos();
      }
    });
  });

  document.getElementById('upload-btn').addEventListener('click', startUpload);
  document.getElementById('refresh-btn').addEventListener('click', init);
}

async function startUpload() {
  if (selectedVideo === null) return;

  const video = videos[selectedVideo];

  await chrome.storage.local.set({
    pendingUpload: video,
    videoIndex: selectedVideo
  });

  chrome.tabs.create({
    url: 'https://studio.youtube.com/'
  });

  window.close();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

init();
