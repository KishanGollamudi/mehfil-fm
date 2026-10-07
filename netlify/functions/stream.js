const ytdl = require('@distube/ytdl-core');

exports.handler = async (event) => {
  const videoId = event.queryStringParameters && event.queryStringParameters.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid video ID' }) };
  }

  try {
    const info = await ytdl.getInfo('https://www.youtube.com/watch?v=' + videoId);

    // Priority: opus 160kbps (format 251) > webm audio > mp4 audio > any audio
    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    const best =
      formats.find(f => f.itag === 251) ||           // opus 160kbps — best
      formats.find(f => f.audioCodec && f.audioCodec.includes('opus')) ||
      formats.find(f => f.audioBitrate >= 128) ||
      formats[0];

    if (!best) return { statusCode: 404, body: JSON.stringify({ error: 'No audio stream found' }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=300' },
      body: JSON.stringify({
        url: best.url,
        codec: best.audioCodec,
        bitrate: best.audioBitrate,
        title: info.videoDetails.title,
        author: info.videoDetails.author.name,
        duration: info.videoDetails.lengthSeconds
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
