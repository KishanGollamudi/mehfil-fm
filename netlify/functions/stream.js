const ytdl = require('@distube/ytdl-core');

exports.handler = async (event) => {
  const videoId = event.queryStringParameters && event.queryStringParameters.id;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid video ID' }) };
  }

  try {
    const info = await ytdl.getInfo('https://www.youtube.com/watch?v=' + videoId);

    const formats = ytdl.filterFormats(info.formats, 'audioonly');
    // Pick highest quality: opus 160kbps (251) first, then by bitrate
    const sorted = formats.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const best =
      formats.find(f => f.itag === 251) ||
      formats.find(f => f.audioCodec && f.audioCodec.includes('opus')) ||
      sorted[0];

    if (!best) return { statusCode: 404, body: JSON.stringify({ error: 'No audio stream found' }) };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Short cache — YouTube stream URLs expire in ~6 hours, refresh before that
        'Cache-Control': 'private, max-age=18000'
      },
      body: JSON.stringify({
        url: best.url,
        codec: best.audioCodec,
        bitrate: best.audioBitrate,
        mimeType: best.mimeType,
        title: info.videoDetails.title,
        author: info.videoDetails.author.name,
        duration: parseInt(info.videoDetails.lengthSeconds, 10)
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
