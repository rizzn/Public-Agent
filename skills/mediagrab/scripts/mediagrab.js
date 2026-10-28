/*
 File Name:     mediagrab.js
 Description:   Non-interactive video/audio download via the yt-dlp and ffmpeg in ../bin
 Author:        Stephan Riedl
 Author URI:    https://stph.so/
*/

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const TMP_DIR = path.join(__dirname, '..', 'tmp');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const USAGE = 'Usage: node mediagrab.js <url> [--mp3] [--out <dir>]';

/*
 * function parseArgs
 *
 * Reads <url>, --mp3 and --out <dir>; throws on anything else
 */
function parseArgs(argv) {
	const opts = {url: null, mp3: false, out: TMP_DIR};
	for(let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if(arg === '--mp3') {
			opts.mp3 = true;
		}
		else if(arg === '--out') {
			if(!argv[i + 1]) {
				throw new Error('--out needs a directory');
			}
			opts.out = path.resolve(argv[++i]);
		}
		else if(arg.startsWith('-') || opts.url) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		else {
			opts.url = arg;
		}
	}
	if(!opts.url) {
		throw new Error('URL missing');
	}
	return opts;
}

/*
 * function buildArgs
 *
 * yt-dlp arguments: preset mp4 (H.264/AAC) or mp3, one file per URL, final path on stdout
 */
function buildArgs(opts) {
	return [
		'--preset-alias', opts.mp3 ? 'mp3' : 'mp4',
		'--no-playlist',
		'--ffmpeg-location', BIN_DIR,
		// YouTube needs a JS runtime for its signature challenge; reuse the Node running this script
		'--js-runtimes', `node:${process.execPath}`,
		'--paths', opts.out,
		'--output', '%(title)s [%(id)s].%(ext)s',
		'--print', 'after_move:filepath',
		'--encoding', 'utf-8',
		opts.url
	];
}

if(require.main === module) {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	}
	catch(err) {
		console.error(`[mediagrab] ${err.message}\n${USAGE}`);
		process.exit(2);
	}
	if(!fs.existsSync(YTDLP)) {
		console.error(`[mediagrab] yt-dlp missing: ${YTDLP}`);
		process.exit(2);
	}
	const result = spawnSync(YTDLP, buildArgs(opts), {stdio: 'inherit'});
	process.exit(result.status ?? 1);
}

module.exports = {parseArgs, buildArgs, BIN_DIR, TMP_DIR};
