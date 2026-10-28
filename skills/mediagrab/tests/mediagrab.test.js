const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {parseArgs, buildArgs, BIN_DIR, TMP_DIR} = require('../scripts/mediagrab.js');

const URL = 'https://youtu.be/dQw4w9WgXcQ';

test('BIN_DIR holds the own binaries of the skill', () => {
	for(const exe of ['yt-dlp.exe', 'ffmpeg.exe']) {
		assert.ok(fs.existsSync(path.join(BIN_DIR, exe)), `${exe} missing in ${BIN_DIR}`);
	}
});

test('parseArgs defaults to mp4 into the tmp/ of the skill', () => {
	const opts = parseArgs([URL]);
	assert.strictEqual(opts.url, URL);
	assert.strictEqual(opts.mp3, false);
	assert.strictEqual(opts.out, TMP_DIR);
	assert.strictEqual(TMP_DIR, path.resolve(__dirname, '..', 'tmp'));
});

test('parseArgs reads --mp3 and --out in any order', () => {
	const opts = parseArgs(['--out', 'clips', URL, '--mp3']);
	assert.strictEqual(opts.mp3, true);
	assert.strictEqual(opts.out, path.resolve('clips'));
});

test('parseArgs rejects missing URL, unknown flags, a second URL and --out without value', () => {
	assert.throws(() => parseArgs([]), /URL missing/);
	assert.throws(() => parseArgs([URL, '--best']), /Unexpected argument/);
	assert.throws(() => parseArgs([URL, URL]), /Unexpected argument/);
	assert.throws(() => parseArgs([URL, '--out']), /needs a directory/);
});

test('buildArgs picks the preset, pins ffmpeg and prints the final path', () => {
	const args = buildArgs({url: URL, mp3: true, out: 'x'});
	assert.deepStrictEqual(args.slice(0, 2), ['--preset-alias', 'mp3']);
	assert.strictEqual(args[args.indexOf('--ffmpeg-location') + 1], BIN_DIR);
	assert.strictEqual(args[args.indexOf('--print') + 1], 'after_move:filepath');
	assert.ok(args.includes('--no-playlist'));
	assert.strictEqual(args.at(-1), URL);
	assert.strictEqual(buildArgs({url: URL, mp3: false, out: 'x'})[1], 'mp4');
});
