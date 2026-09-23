"""
Spotify downloader server - placeholder for alternative implementation.
Downloads Spotify tracks given a link.
"""

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
import os

app = Flask(__name__)
CORS(app)

@app.route('/api/spotify/download', methods=['POST'])
def download_spotify():
    """
    Download a Spotify track given its URL using votify.

    Request body:
        url: Spotify track URL

    Returns:
        Downloaded file or error
    """
    data = request.get_json()
    url = data.get('url')
    if not url:
        return jsonify({'error': 'Missing url parameter'}), 400

    try:
        # Ensure downloads directory exists
        os.makedirs('downloads', exist_ok=True)

        import subprocess

        # Run votify command with cookies
        result = subprocess.run(['votify', '--cookies-path', '../cookies.txt', url], cwd='downloads', capture_output=True, text=True)

        if result.returncode == 0:
            # Find all downloaded files recursively
            download_files = []
            for root, dirs, files in os.walk('downloads'):
                rel_root = os.path.relpath(root, 'downloads')
                if rel_root == '.':
                    rel_root = ''
                for file in files:
                    if file.endswith(('.mp3', '.m4a', '.webm')):
                        download_files.append(os.path.join(rel_root, file) if rel_root else file)
            if download_files:
                import shutil
                static_audio_dir = os.path.join('..', 'server', 'static', 'audio')
                os.makedirs(static_audio_dir, exist_ok=True)
                converted_files = []
                for file in download_files:
                    src_path = os.path.join('downloads', file)
                    dest_path = os.path.join(static_audio_dir, file)
                    if file.endswith('.m4a'):
                        # Convert M4A to MP3
                        mp3_path = dest_path.replace('.m4a', '.mp3')
                        convert_result = subprocess.run(['ffmpeg', '-i', src_path, '-acodec', 'libmp3lame', '-ab', '192k', mp3_path], capture_output=True, text=True)
                        if convert_result.returncode == 0:
                            converted_files.append(mp3_path.split('/')[-1])
                            os.remove(src_path)  # Remove original M4A
                        else:
                            # Fallback to moving M4A
                            shutil.move(src_path, dest_path)
                            converted_files.append(file)
                    else:
                        shutil.move(src_path, dest_path)
                        converted_files.append(file)
                return jsonify({'success': True, 'files': converted_files})
            else:
                return jsonify({'success': True, 'message': 'Download completed but no audio files found'})
        else:
            return jsonify({'error': 'Download failed', 'details': result.stderr}), 500

    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Ensure downloads directory exists
    os.makedirs('downloads', exist_ok=True)
    app.run(debug=True, host='0.0.0.0', port=5002)
