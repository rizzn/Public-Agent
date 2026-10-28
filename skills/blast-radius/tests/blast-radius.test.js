const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {
	parseArgs,
	extractExports,
	compareSignatures,
	findCallSites,
	detectDynamicHazards,
	analyzeRepo,
	formatReport
} = require('../scripts/blast-radius.js');

test('parseArgs reads file targets, --diff, --root, --depth and --json', () => {
	const a = parseArgs(['src/app.js']);
	assert.deepStrictEqual(a.files, ['src/app.js']);
	assert.strictEqual(a.diff, false);
	assert.strictEqual(a.depth, 3);

	const b = parseArgs(['--diff', 'HEAD~1', '--depth', '5', '--json', '--root', 'my-app']);
	assert.strictEqual(b.diff, true);
	assert.strictEqual(b.rev, 'HEAD~1');
	assert.strictEqual(b.depth, 5);
	assert.strictEqual(b.json, true);
	assert.strictEqual(b.root, path.resolve('my-app'));
});

test('parseArgs rejects missing targets, unknown flags and invalid values', () => {
	assert.throws(() => parseArgs([]), /Target missing/);
	assert.throws(() => parseArgs(['--unknown']), /Unexpected argument/);
	assert.throws(() => parseArgs(['--diff', '--depth', '0']), /positive integer/);
	assert.throws(() => parseArgs(['--diff', '--root']), /needs a directory/);
});

test('extractExports parses JS ESM, CJS (with nested objects), Python, PHP and Go parameter bounds', () => {
	const jsCode = [
		'export function verifyToken(token, secret = (1 + 2), opts = {}) {}',
		'const helper = (a, ...rest) => a;',
		'module.exports = { config: { timeout: 1000 }, verifyToken, helper, inlineMethod(x, y = (2 * 3)) {} };'
	].join('\n');
	const jsExports = extractExports(jsCode, '.js');
	assert.strictEqual(jsExports.get('verifyToken').minParams, 1);
	assert.strictEqual(jsExports.get('verifyToken').maxParams, 3);
	assert.strictEqual(jsExports.get('helper').minParams, 1);
	assert.strictEqual(jsExports.get('helper').maxParams, Infinity);
	assert.strictEqual(jsExports.get('inlineMethod').minParams, 1);
	assert.strictEqual(jsExports.get('inlineMethod').maxParams, 2);

	const pyCode = [
		'def public_fn(self, user_id, retries=(1 + 2)):',
		'    pass',
		'def _private_fn(x):',
		'    pass'
	].join('\n');
	const pyExports = extractExports(pyCode, '.py');
	assert.strictEqual(pyExports.has('_private_fn'), false);
	assert.strictEqual(pyExports.get('public_fn').minParams, 1);
	assert.strictEqual(pyExports.get('public_fn').maxParams, 2);

	const goCode = 'func ParseHeader(cb func(int) bool, strict bool) error { return nil }\nfunc internalHelper(x int) {}';
	const goExports = extractExports(goCode, '.go');
	assert.strictEqual(goExports.has('internalHelper'), false);
	assert.strictEqual(goExports.get('ParseHeader').minParams, 2);
});

test('compareSignatures detects removed exports, breaking parameter changes and function-to-const kind changes', () => {
	const before = [
		'export function verifyToken(token, opts = {}) {}',
		'export function legacyCheck(x) {}',
		'export function becomeConst(a) {}'
	].join('\n');
	const after = [
		'export function verifyToken(token, secret, opts = {}) {}',
		'export const becomeConst = 42;'
	].join('\n');
	const diff = compareSignatures(before, after, '.js');
	assert.strictEqual(diff.removed.length, 1);
	assert.strictEqual(diff.removed[0].name, 'legacyCheck');
	assert.strictEqual(diff.modified.length, 2);
	assert.strictEqual(diff.breaking.length, 3);
});

test('findCallSites counts nested arguments, Python lambdas and ignores strings, comments and generator declarations', () => {
	const code = [
		'// verifyToken(a)',
		'function verifyToken(a, b, c) {}',
		'function* verifyToken(a, b) {}',
		'const sql = "SELECT verifyToken(id) FROM users";',
		'const res = verifyToken(getHeader("x, y"), { a: 1, b: 2 });',
		'const ok = verifyToken(...args);',
		'const py = verifyToken(tokens, 23.0, [], lambda start, end: []);'
	].join('\n');
	const sites = findCallSites(code, 'verifyToken', '.js');
	assert.strictEqual(sites.length, 3);
	assert.strictEqual(sites[0].line, 5);
	assert.strictEqual(sites[0].argCount, 2);
	assert.strictEqual(sites[0].hasSpread, false);
	assert.strictEqual(sites[1].line, 6);
	assert.strictEqual(sites[1].hasSpread, true);
	assert.strictEqual(sites[2].line, 7);
	assert.strictEqual(sites[2].argCount, 4);
});

test('detectDynamicHazards flags dynamic import(), require() and eval() while ignoring strings and regexes', () => {
	const code = [
		'const a = require("./static.js");',
		'const b = await import(pluginPath);',
		'eval("1 + 1");',
		'const fake = "eval(notReal) export function notExported() {}";',
		'const re = /\\beval\\s*\\(/g;'
	].join('\n');
	const hazards = detectDynamicHazards(code, '.js');
	assert.strictEqual(hazards.length, 2);
	assert.strictEqual(hazards[0].line, 2);
	assert.strictEqual(hazards[0].label, 'dynamic import()');
	assert.strictEqual(hazards[1].line, 3);
	assert.strictEqual(hazards[1].label, 'eval()');
	const exps = extractExports(code, '.js');
	assert.strictEqual(exps.size, 0);
});

test('analyzeRepo maps reverse graph, breaking callers, tests, untested paths and git diff', () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blast-radius-test-'));
	try {
		fs.mkdirSync(path.join(tmpDir, 'src', 'auth'), {recursive: true});
		fs.mkdirSync(path.join(tmpDir, 'src', 'api'), {recursive: true});
		fs.mkdirSync(path.join(tmpDir, 'src', 'cli'), {recursive: true});
		fs.mkdirSync(path.join(tmpDir, 'tests'), {recursive: true});

		const tokenFile = path.join(tmpDir, 'src', 'auth', 'token.js');
		fs.writeFileSync(tokenFile, [
			'function verifyToken(token, opts = {}) {',
			'\treturn Boolean(token);',
			'}',
			'function parse(a, b, c) {',
			'\treturn a;',
			'}',
			'module.exports = {verifyToken, parse};'
		].join('\n'));

		fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'middleware.js'), [
			'const {verifyToken} = require("../auth/token.js");',
			'async function authMiddleware(req) {',
			'\tconst mod = await import(req.dynamicPlugin);',
			'\tJSON.parse("{}");',
			'\treturn verifyToken(req.token);',
			'}',
			'module.exports = {authMiddleware};'
		].join('\n'));

		fs.writeFileSync(path.join(tmpDir, 'src', 'api', 'server.js'), [
			'const {authMiddleware} = require("./middleware.js");',
			'function startServer(req) {',
			'\treturn authMiddleware(req);',
			'}',
			'module.exports = {startServer};'
		].join('\n'));

		fs.writeFileSync(path.join(tmpDir, 'src', 'cli', 'orphan.js'), [
			'function runOrphan() { return 42; }',
			'module.exports = {runOrphan};'
		].join('\n'));

		fs.writeFileSync(path.join(tmpDir, 'tests', 'server.test.js'), [
			'const {startServer} = require("../src/api/server.js");',
			'startServer({token: "abc"});'
		].join('\n'));

		spawnSync('git', ['init'], {cwd: tmpDir});
		spawnSync('git', ['config', 'user.email', 'test@example.com'], {cwd: tmpDir});
		spawnSync('git', ['config', 'user.name', 'Test'], {cwd: tmpDir});
		spawnSync('git', ['add', '.'], {cwd: tmpDir});
		spawnSync('git', ['commit', '-m', 'init'], {cwd: tmpDir});

		// Change verifyToken from 1..2 params to 2..3 params (breaking caller in middleware.js:5) and keep parse(a, b, c) unimported
		fs.writeFileSync(tokenFile, [
			'function verifyToken(token, secret, opts = {}) {',
			'\treturn Boolean(token && secret);',
			'}',
			'function parse(a, b, c) {',
			'\treturn a;',
			'}',
			'module.exports = {verifyToken, parse};'
		].join('\n'));

		const report = analyzeRepo({
			files: ['src/cli/orphan.js'],
			diff: true,
			rev: 'HEAD',
			root: tmpDir,
			depth: 3,
			json: false
		});

		assert.strictEqual(report.breaking.length, 1);
		assert.strictEqual(report.breaking[0].caller, 'src/api/middleware.js');
		assert.strictEqual(report.breaking[0].line, 5);
		assert.deepStrictEqual(report.impacted, [
			{file: 'src/api/middleware.js', depth: 1},
			{file: 'src/api/server.js', depth: 2}
		]);
		assert.deepStrictEqual(report.tests, ['tests/server.test.js']);
		assert.strictEqual(report.testCommand, 'node --test tests/server.test.js');
		assert.deepStrictEqual(report.untested, ['src/cli/orphan.js']);
		assert.strictEqual(report.dynamic.length, 1);
		assert.strictEqual(report.dynamic[0].file, 'src/api/middleware.js');

		const text = formatReport(report);
		assert.match(text, /CHANGED:\s+src\/auth\/token\.js \(export verifyToken: 1\.\.2 params -> 2\.\.3 params\)/);
		assert.match(text, /BREAKING:\s+src\/api\/middleware\.js:5 \(calls verifyToken with 1 arg \(expects 2\.\.3 params\)\)/);
		assert.match(text, /IMPACTED:\s+2 files \(depth 1: 1, depth 2: 1\)/);
		assert.match(text, /TESTS:\s+node --test tests\/server\.test\.js/);
		assert.match(text, /UNTESTED:\s+src\/cli\/orphan\.js/);
		assert.match(text, /DYNAMIC:\s+src\/api\/middleware\.js:3 \(dynamic import\(\)\)/);
	}
	finally {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	}
});
