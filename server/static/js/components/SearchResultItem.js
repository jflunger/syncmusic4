/**
 * Search result item component for displaying search results from Spotify/SoundCloud.
 * Usage: <search-result-item></search-result-item>
 * Emits: 'download-track' custom event with { detail: { track } } when download button is clicked
 */

import appState from '../state/appState.js';

class SearchResultItem extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.currentStatus = null;
  }

  static get observedAttributes() {
    return ['title', 'artist', 'source', 'cover', 'url'];
  }

  attributeChangedCallback() {
    this.render();
  }

  connectedCallback() {
    this.render();
    this.subscribeToState();
  }

  disconnectedCallback() {
    if (this.unsubscribeDownloadStatuses) {
      this.unsubscribeDownloadStatuses();
    }
  }

  subscribeToState() {
    // Subscribe to download status changes
    this.unsubscribeDownloadStatuses = appState.subscribe((key, value) => {
      if (key === 'downloadStatuses') {
        const myUrl = this.getAttribute('url');
        if (myUrl && value.hasOwnProperty(myUrl)) {
          const newStatus = value[myUrl];
          if (newStatus !== this.currentStatus) {
            this.currentStatus = newStatus;
            this.updateDownloadButton();
          }
        }
      }
    });
  }

  updateDownloadButton() {
    const downloadBtn = this.shadowRoot.querySelector('.download-btn');
    if (!downloadBtn) return;

    const status = this.currentStatus;

    // Remove all status classes
    downloadBtn.classList.remove('queued', 'downloading', 'completed', 'failed');

    // Update button based on status
    if (status === 'queued') {
      downloadBtn.textContent = '⏳ In Queue';
      downloadBtn.classList.add('queued');
      downloadBtn.disabled = true;
    } else if (status === 'downloading') {
      downloadBtn.textContent = '⏬ Downloading';
      downloadBtn.classList.add('downloading');
      downloadBtn.disabled = true;
    } else if (status === 'completed') {
      downloadBtn.textContent = '✅ Completed';
      downloadBtn.classList.add('completed');
      downloadBtn.disabled = true;
    } else if (status === 'failed') {
      downloadBtn.textContent = '❌ Failed';
      downloadBtn.classList.add('failed');
      downloadBtn.disabled = false;
    } else {
      downloadBtn.textContent = 'Download';
      downloadBtn.disabled = false;
    }
  }

  render() {
    const title = this.getAttribute('title') || 'Unknown';
    const artist = this.getAttribute('artist') || 'Unknown';
    const source = this.getAttribute('source') || 'unknown';
    const cover = this.getAttribute('cover') || '';
    const url = this.getAttribute('url') || '';

    const barColor = source === 'youtube' ? '#f44336' : source === 'spotify' ? '#1db954' : source === 'soundcloud' ? '#ff9800' : '#666';
    const sourceIcon = source === 'spotify' ?
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.6-.12-.421.18-.78.6-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.241 1.081zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.56-11.939-1.38-.479.16-1.02-.12-1.18-.6-.16-.48.12-1.021.6-1.181C9.6 10.88 15 11.541 18.621 13.7c.42.181.72.78.42 1.24zm.959-3.18c-3.68-2.16-9.719-2.36-13.479-1.26-.52.18-1.1-.101-1.28-.64-.18-.521.1-1.1.62-1.281C8.94 5.02 15.48 5.22 19.621 7.54c.559.24.72.901.479 1.4z"/></svg>' :
      source === 'soundcloud' ?
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8.998 16.586c-.566 0-1.029-.463-1.029-1.029 0-.566.463-1.029 1.029-1.029h7.49c-.094-1.253-.381-2.435-.848-3.499-.242-.551-.097-1.194.36-1.605.551-.242 1.194-.097 1.605.36.693 1.571 1.14 3.304 1.325 5.092.041.404-.14.803-.485.994-.23.126-.483.174-.73.122l-.051-.013c-.15-.032-.293-.103-.415-.207-.339-.288-.336-1.06-.377-1.338-.025-.179-.063-.351-.113-.517-.172-.57-.395-1.111-.681-1.631-.44-.801-.851-1.54-1.22-2.26-.379-.739-.702-1.488-.968-2.246-.53-1.51-1.004-3.057-1.426-4.623-.044-.163-.084-.327-.121-.492-.361-1.599-.854-3.041-1.421-4.302-.993.022-1.838.727-1.663 1.722.174.994 1.047 1.706 1.926 1.654.39-.022.747-.232.972-.582.108-.168.21-.348.303-.539.48.37.935.81 1.348 1.31.389.47.715 1.001 1.003 1.57.265.524.484 1.088.652 1.675.157.548.272 1.113.346 1.69.071.56.098 1.136.079 1.724l-.004.141c.001.086-.007.172-.023.257-.098.517-.62.875-1.136.775-.303-.059-.576-.239-.745-.509-.444-.709-.989-1.315-1.62-1.805-.669-.519-1.387-.917-2.127-1.187-.85-.314-1.745-.45-2.647-.403-.902.046-1.807.283-2.658.703-.688.338-1.346.819-1.942 1.417-.145.146-.314.268-.503.361-.185.091-.387.142-.591.151-.516.023-.951-.349-1.024-.861-.08-.562.279-1.083.83-1.215.552-.133 1.139.228 1.279.762.02.077.025.156.016.234-.024.202.143.368.342.384.102.009.203-.019.295-.074.633-.379 1.306-.649 2.004-.786.825-.163 1.686-.135 2.517.08.779.202 1.524.526 2.204.937.655.394 1.286.873 1.864 1.416.222.208.335.511.302.821-.029.27-.195.51-.455.616-.261.107-.56.058-.792-.13-.616-.498-1.282-.9-1.977-1.19-.741-.309-1.523-.505-2.315-.58-.852-.08-1.709-.033-2.547.137-.776.156-1.531.422-2.242.786-.684.351-1.336.804-1.92 1.339-.586.535-1.073 1.131-1.413 1.767-.318.599-.461 1.28-.421 1.96.04.68.289 1.336.707 1.847.261.319.697.441 1.104.261.399-.177.607-.607.459-1.011-.181-.743.083-1.501.595-2.04.51-.54 1.14-1.032 1.77-1.471.62-.433 1.275-.834 1.947-1.187.677-.354 1.378-.65 2.088-.878.726-.232 1.472-.4 2.228-.5.768-.102 1.545-.134 2.322-.097.755.036 1.502.136 2.238.3.727.16 1.44.393 2.122.693.661.29 1.302.647 1.894 1.058.572.394 1.117.841 1.619 1.33.483.471.93 1.002 1.327 1.582h-7.49z"/></svg>' :
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          border-radius: 8px;
          background: #2a2a2a;
          padding: 12px;
          cursor: pointer;
          transition: background 0.2s;
          border-left: 4px solid ${barColor};
          border-bottom: 1px solid #0a0a0a;
        }
        :host:last-child {
          border-bottom: none;
        }
        @media (hover: hover) {
          :host(:hover) {
            background: #333;
          }
        }
        .track-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .cover {
          width: 48px;
          height: 48px;
          background: #444;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          overflow: hidden;
        }
        .cover img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .cover .no-cover {
          color: #666;
          font-size: 24px;
        }
        .track-details {
          flex: 1;
          min-width: 0;
        }
        .track-title {
          font-weight: 600;
          font-size: 14px;
          margin: 0 0 4px 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .track-artist {
          font-size: 12px;
          color: #aaa;
          margin: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .track-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .download-btn {
          background: ${barColor};
          border: none;
          border-radius: 20px;
          padding: 6px 12px;
          color: white;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.2s;
        }
        @media (hover: hover) {
          .download-btn:hover:not(:disabled) {
            background: ${source === 'youtube' ? '#d32f2f' : source === 'spotify' ? '#1aa547' : '#e68900'};
          }
        }
        .download-btn:disabled {
          cursor: not-allowed;
          opacity: 0.7;
        }
        .download-btn.queued {
          background: #ff9800;
        }
        .download-btn.downloading {
          background: #2196f3;
          animation: pulse 1.5s infinite;
        }
        .download-btn.completed {
          background: #4caf50;
        }
        .download-btn.failed {
          background: #f44336;
        }
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.7; }
          100% { opacity: 1; }
        }
        .source-badge {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 10px;
          background: ${barColor};
          color: white;
          text-transform: uppercase;
          font-weight: 500;
        }
      </style>
      <div class="track-info">
        <div class="cover">
          ${cover ?
            `<img src="${cover}" alt="Cover" loading="lazy">` :
            `<div class="no-cover">♪</div>`
          }
        </div>
        <div class="track-details">
          <h4 class="track-title">${title}</h4>
          <p class="track-artist">${artist}</p>
        </div>
        <div class="track-actions">
          <span class="source-badge">${source === 'spotify' ? 'Spotify' : source === 'soundcloud' ? 'SoundCloud' : source}</span>
          ${url ? `<button class="download-btn">Download</button>` : ''}
        </div>
      </div>
    `;

    // Add event listener for download button
    const downloadBtn = this.shadowRoot.querySelector('.download-btn');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('download-track', {
          detail: {
            track: {
              title,
              artist,
              source,
              url,
              cover
            }
          },
          bubbles: true
        }));
      });
    }
  }
}

customElements.define('search-result-item', SearchResultItem);