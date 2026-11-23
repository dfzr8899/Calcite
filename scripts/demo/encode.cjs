const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const destination = path.resolve(__dirname, '../../docs/media');
const maxGifBytes = 5_000_000;
const gifCuts = [[0, 3.2], [5.4, 8.8], [13, 17.8], [19.8, 23], [25.6, 29], [33.5, 37.7]];

function ffmpeg(args) {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localEncoder = path.resolve(__dirname, '../../.test-data/demo-tools', name);
  const command = process.env.CALCITE_FFMPEG || (existsSync(localEncoder) ? localEncoder : name);
  try {
    return execFileSync(command, ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8'
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Install FFmpeg or set CALCITE_FFMPEG to its executable path.');
    }
    throw new Error('FFmpeg failed: ' + (error.stderr || error.message).trim());
  }
}

function gifFilter(width, fps) {
  const labels = gifCuts.map((_, index) => '[part' + index + ']');
  const split = '[0:v]split=' + labels.length + labels.join('');
  const trim = gifCuts.map(([start, end], index) =>
    labels[index] + 'trim=start=' + start + ':end=' + end + ',setpts=PTS-STARTPTS[cut' + index + ']');
  const cuts = gifCuts.map((_, index) => '[cut' + index + ']').join('');
  const join = cuts + 'concat=n=' + gifCuts.length + ':v=1:a=0,fps=' + fps +
    ',scale=' + width + ':-2:flags=lanczos,split[video][colors]';
  const palette = '[colors]palettegen=max_colors=144:stats_mode=diff[palette]';
  const mapped = '[video][palette]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[out]';
  return [split, ...trim, join, palette, mapped].join(';');
}

async function encode(raw) {
  const workingDir = path.dirname(raw);
  const video = path.join(workingDir, 'demo.mp4');
  const gif = path.join(workingDir, 'demo.gif');
  const common = ['-loglevel', 'error', '-y'];
  const progress = ffmpeg([...common, '-i', raw, '-t', '38', '-an', '-vf', 'fps=30',
    '-c:v', 'libx264', '-threads', '4', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', video]);
  const timestamps = Array.from(progress.matchAll(/^out_time_us=(\d+)\r?$/gm));
  const videoSeconds = Number(timestamps.at(-1)?.[1]) / 1_000_000;
  assert(videoSeconds >= 37.8 && videoSeconds <= 38.1, 'The recording must cover the full 38-second timeline.');

  let gifBytes = Infinity;
  for (const [width, fps] of [[960, 14], [880, 14], [800, 12], [720, 12]]) {
    ffmpeg([...common, '-i', video, '-filter_complex_threads', '2',
      '-filter_complex', gifFilter(width, fps), '-map', '[out]', '-loop', '0', gif]);
    gifBytes = (await fs.stat(gif)).size;
    if (gifBytes < maxGifBytes) break;
  }
  assert(gifBytes < maxGifBytes, 'The GIF must be smaller than 5 MB.');
  for (const file of [video, gif]) {
    ffmpeg(['-loglevel', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
  }
  await fs.mkdir(destination, { recursive: true });
  await Promise.all([video, gif].map(file => fs.copyFile(file, path.join(destination, path.basename(file)))));
  console.log('Published demo.mp4 (' + (await fs.stat(video)).size + ' bytes) and demo.gif (' + gifBytes + ' bytes).');
}

module.exports = { encode };

if (require.main === module) {
  const [input] = process.argv.slice(2);
  if (!input) {
    console.error('Usage: node scripts/demo/encode.cjs path/to/capture.webm');
    process.exitCode = 1;
  } else {
    encode(path.resolve(input)).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
