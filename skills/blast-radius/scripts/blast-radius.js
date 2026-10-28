/*
 File Name:     blast-radius.js
 Description:   Static change-impact, signature-diff and reverse-dependency analyser for JS/TS, Python, PHP and Go
 Author:        Stephan Riedl
 Author URI:    https://stph.so/
*/

const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const USAGE = 'Usage: node blast-radius.js [<file>...] [--diff [<rev>]] [--root <dir>] [--depth <n>] [--json]';
const SUPPORTED_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.php', '.go']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
// Windows ships the py launcher; a bare "python" there is often the Microsoft Store stub
const PY_CMD = process.platform === 'win32' ? 'py -3' : 'python3';
const IGNORED_DIRS = new Set([
	'.git', 'node_modules', 'vendor', 'dist', 'build', 'out', 'coverage',
	'__pycache__', '.next', '.nuxt', '.venv', 'venv', 'bin', 'tmp', 'output'
]);

/*
 * function toPosix
 *
 * Normalises a path to forward slashes
 */
function toPosix(p) {
	return p.replace(/\\/g, '/');
}

/*
 * function parseArgs
 *
 * Reads file targets, --diff [<rev>], --root <dir>, --depth <n> and --json
 */
function parseArgs(argv) {
	const opts = {
		files: [],
		diff: false,
		rev: 'HEAD',
		root: null,
		depth: 3,
		json: false
	};
	for(let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if(arg === '--diff') {
			opts.diff = true;
			if(argv[i + 1] && !argv[i + 1].startsWith('-')) {
				opts.rev = argv[++i];
			}
		}
		else if(arg === '--root') {
			if(!argv[i + 1] || argv[i + 1].startsWith('-')) {
				throw new Error('--root needs a directory');
			}
			opts.root = path.resolve(argv[++i]);
		}
		else if(arg === '--depth') {
			const raw = argv[++i];
			const n = Number.parseInt(raw, 10);
			if(!raw || Number.isNaN(n) || n < 1) {
				throw new Error('--depth needs a positive integer');
			}
			opts.depth = n;
		}
		else if(arg === '--json') {
			opts.json = true;
		}
		else if(arg.startsWith('-')) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		else {
			opts.files.push(arg);
		}
	}
	if(!opts.diff && opts.files.length === 0) {
		throw new Error('Target missing: pass at least one <file> or --diff');
	}
	return opts;
}

/*
 * function resolveRoot
 *
 * Finds the git repository root or falls back to process.cwd()
 */
function resolveRoot(explicitRoot) {
	if(explicitRoot) {
		return explicitRoot;
	}
	const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'});
	if(git.status === 0 && git.stdout.trim()) {
		return path.resolve(git.stdout.trim());
	}
	return process.cwd();
}

/*
 * function isTestFile
 *
 * Returns true if the relative path is a test or spec file
 */
function isTestFile(relPath) {
	const norm = toPosix(relPath);
	const base = path.basename(norm);
	return /\.(test|spec)\.[^.]+$|^test_.*\.py$|.*_test\.(py|go)$|.*Test\.php$/i.test(base);
}

/*
 * function walkRepo
 *
 * Collects all supported source files under rootDir as relative POSIX paths
 */
function walkRepo(rootDir) {
	const results = [];
	function walk(currentDir) {
		const entries = fs.readdirSync(currentDir, {withFileTypes: true});
		for(const entry of entries) {
			if(entry.isDirectory()) {
				if(!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
					walk(path.join(currentDir, entry.name));
				}
			}
			else if(entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if(SUPPORTED_EXT.has(ext)) {
					const rel = toPosix(path.relative(rootDir, path.join(currentDir, entry.name)));
					results.push(rel);
				}
			}
		}
	}
	walk(rootDir);
	return results.sort();
}

/*
 * function scanCode
 *
 * Single-pass lexer that strips comments (and optionally masks string/regex contents) while keeping line breaks
 */
function scanCode(source, ext, maskLiterals) {
	const out = source.split('');
	let i = 0;
	let prevNonSpace = '';

	while(i < out.length) {
		const ch = out[i];
		const next = i + 1 < out.length ? out[i + 1] : '';

		if(ext === '.py' && (source.startsWith('"""', i) || source.startsWith('\'\'\'', i))) {
			const delim = source.slice(i, i + 3);
			i += 3;
			while(i < out.length && !source.startsWith(delim, i)) {
				if(maskLiterals && out[i] !== '\n') {
					out[i] = ' ';
				}
				i++;
			}
			i += 3;
			prevNonSpace = '"';
			continue;
		}

		if((ext === '.py' || ext === '.php') && ch === '#') {
			while(i < out.length && out[i] !== '\n') {
				out[i] = ' ';
				i++;
			}
			continue;
		}

		if(ext !== '.py' && ch === '/' && next === '/') {
			while(i < out.length && out[i] !== '\n') {
				out[i] = ' ';
				i++;
			}
			continue;
		}

		if(ext !== '.py' && ch === '/' && next === '*') {
			out[i] = ' ';
			out[i + 1] = ' ';
			i += 2;
			while(i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
				if(out[i] !== '\n') {
					out[i] = ' ';
				}
				i++;
			}
			if(i < out.length) {
				out[i] = ' ';
				if(i + 1 < out.length) {
					out[i + 1] = ' ';
				}
				i += 2;
			}
			continue;
		}

		if(ch === '"' || ch === '\'' || (JS_EXT.has(ext) && ch === '`')) {
			const quote = ch;
			i++;
			while(i < out.length) {
				if(out[i] === '\\') {
					if(maskLiterals && out[i] !== '\n') {
						out[i] = ' ';
					}
					if(maskLiterals && i + 1 < out.length && out[i + 1] !== '\n') {
						out[i + 1] = ' ';
					}
					i += 2;
					continue;
				}
				if(out[i] === quote) {
					i++;
					break;
				}
				if(maskLiterals && out[i] !== '\n') {
					out[i] = ' ';
				}
				i++;
			}
			prevNonSpace = quote;
			continue;
		}

		if(JS_EXT.has(ext) && ch === '/' && (prevNonSpace === '' || /[=({[,;:!&|?+-]/.test(prevNonSpace))) {
			i++;
			let inCharClass = false;
			while(i < out.length && out[i] !== '\n') {
				if(out[i] === '\\') {
					if(maskLiterals) {
						out[i] = ' ';
						if(i + 1 < out.length && out[i + 1] !== '\n') {
							out[i + 1] = ' ';
						}
					}
					i += 2;
					continue;
				}
				if(out[i] === '[') {
					inCharClass = true;
				}
				else if(out[i] === ']') {
					inCharClass = false;
				}
				else if(out[i] === '/' && !inCharClass) {
					i++;
					break;
				}
				if(maskLiterals) {
					out[i] = ' ';
				}
				i++;
			}
			prevNonSpace = '/';
			continue;
		}

		if(!/\s/.test(ch)) {
			prevNonSpace = ch;
		}
		i++;
	}
	return out.join('');
}

/*
 * function stripComments
 *
 * Strips comments while keeping string literals intact
 */
function stripComments(source, ext) {
	return scanCode(source, ext, false);
}

/*
 * function maskStringsAndRegex
 *
 * Strips comments and blanks out the inside of string and regex literals
 */
function maskStringsAndRegex(source, ext) {
	return scanCode(source, ext, true);
}

/*
 * function splitTopLevel
 *
 * Splits a parameter or argument list at top-level commas, ignoring nested brackets and quotes
 */
function splitTopLevel(raw) {
	const trimmed = raw.trim();
	if(!trimmed) {
		return [];
	}
	const parts = [];
	let current = '';
	let depthParen = 0;
	let depthBracket = 0;
	let depthBrace = 0;
	let inLambdaParams = false;
	let quote = null;
	for(let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		const prev = i > 0 ? trimmed[i - 1] : '';
		if(quote) {
			current += ch;
			if(ch === quote && prev !== '\\') {
				quote = null;
			}
			continue;
		}
		if(ch === '"' || ch === '\'' || ch === '`') {
			quote = ch;
			current += ch;
			continue;
		}
		if(ch === '(') {
			depthParen++;
		}
		else if(ch === ')') {
			depthParen = Math.max(0, depthParen - 1);
		}
		else if(ch === '[') {
			depthBracket++;
		}
		else if(ch === ']') {
			depthBracket = Math.max(0, depthBracket - 1);
		}
		else if(ch === '{') {
			depthBrace++;
		}
		else if(ch === '}') {
			depthBrace = Math.max(0, depthBrace - 1);
		}
		if(depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
			if(!inLambdaParams && /^lambda\b/.test(trimmed.slice(i)) && (i === 0 || /[\s,([]/.test(prev))) {
				inLambdaParams = true;
			}
			else if(inLambdaParams && ch === ':') {
				inLambdaParams = false;
			}
		}
		if(ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0 && !inLambdaParams) {
			if(current.trim()) {
				parts.push(current.trim());
			}
			current = '';
		}
		else {
			current += ch;
		}
	}
	if(current.trim()) {
		parts.push(current.trim());
	}
	return parts;
}

/*
 * function parseParamCounts
 *
 * Computes minParams and maxParams for a parameter string in the given language
 */
function parseParamCounts(rawParams, ext) {
	const params = splitTopLevel(rawParams);
	let minParams = 0;
	let maxParams = 0;
	for(let i = 0; i < params.length; i++) {
		const p = params[i].trim();
		if(!p) {
			continue;
		}
		if(ext === '.py' && i === 0 && (p === 'self' || p === 'cls' || p.startsWith('self:') || p.startsWith('cls:'))) {
			continue;
		}
		if(JS_EXT.has(ext) && i === 0 && /^this\s*:/.test(p)) {
			continue;
		}
		if(ext === '.py' && (p === '*' || p === '/')) {
			continue;
		}
		if(p.startsWith('...') || p.startsWith('*') || /\.\.\./.test(p)) {
			maxParams = Infinity;
			continue;
		}
		if(p.includes('=') || /^[A-Za-z_$][\w$]*\s*\?:/.test(p)) {
			if(maxParams !== Infinity) {
				maxParams++;
			}
			continue;
		}
		minParams++;
		if(maxParams !== Infinity) {
			maxParams++;
		}
	}
	return {minParams, maxParams};
}

/*
 * function lineNumberAt
 *
 * Returns the 1-based line number for a character index
 */
function lineNumberAt(source, index) {
	let line = 1;
	for(let i = 0; i < index && i < source.length; i++) {
		if(source[i] === '\n') {
			line++;
		}
	}
	return line;
}

/*
 * function extractBalanced
 *
 * Extracts the substring inside balanced delimiters starting at openIndex
 */
function extractBalanced(source, openIndex, openChar, closeChar) {
	let depth = 1;
	let i = openIndex + 1;
	while(i < source.length && depth > 0) {
		if(source[i] === openChar) {
			depth++;
		}
		else if(source[i] === closeChar) {
			depth--;
		}
		i++;
	}
	if(depth !== 0) {
		return null;
	}
	return {
		content: source.slice(openIndex + 1, i - 1),
		endIndex: i
	};
}

/*
 * function extractExports
 *
 * Extracts exported functions, classes and variables with their parameter bounds
 */
function extractExports(source, ext) {
	const clean = maskStringsAndRegex(source, ext);
	const exportsMap = new Map();
	const localDefs = new Map();

	if(JS_EXT.has(ext)) {
		const fnDeclRe = /\b(?:(export)\s+(?:(default)\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
		let m;
		while((m = fnDeclRe.exec(clean)) !== null) {
			const isExport = Boolean(m[1]);
			const isDefault = Boolean(m[2]);
			const name = m[3];
			const bal = extractBalanced(clean, fnDeclRe.lastIndex - 1, '(', ')');
			if(!bal) {
				continue;
			}
			const counts = parseParamCounts(bal.content, ext);
			const info = {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)};
			localDefs.set(name, info);
			if(isExport) {
				exportsMap.set(isDefault ? 'default' : name, info);
				if(isDefault) {
					exportsMap.set(name, info);
				}
			}
		}

		const arrowOrFnVarRe = /\b(?:(export)\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:(\()|([A-Za-z_$][\w$]*)\s*=>|function\s*\*?\s*(\())/g;
		while((m = arrowOrFnVarRe.exec(clean)) !== null) {
			const isExport = Boolean(m[1]);
			const name = m[2];
			let rawParams = '';
			if(m[4] !== undefined) {
				rawParams = m[4];
			}
			else {
				const openIdx = arrowOrFnVarRe.lastIndex - 1;
				const bal = extractBalanced(clean, openIdx, '(', ')');
				if(!bal) {
					continue;
				}
				if(m[3] !== undefined && !/^\s*(?::[^=]+)?=>/.test(clean.slice(bal.endIndex))) {
					continue;
				}
				rawParams = bal.content;
			}
			const counts = parseParamCounts(rawParams, ext);
			const info = {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)};
			localDefs.set(name, info);
			if(isExport) {
				exportsMap.set(name, info);
			}
		}

		const classRe = /\b(?:(export)\s+(?:(default)\s+)?)?class\s+([A-Za-z_$][\w$]*)/g;
		while((m = classRe.exec(clean)) !== null) {
			const isExport = Boolean(m[1]);
			const name = m[3];
			const info = {name, kind: 'class', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)};
			localDefs.set(name, info);
			if(isExport) {
				exportsMap.set(name, info);
			}
		}

		const exportConstRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
		while((m = exportConstRe.exec(clean)) !== null) {
			const name = m[1];
			if(!exportsMap.has(name)) {
				exportsMap.set(name, {name, kind: 'const', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)});
			}
		}

		const namedExportRe = /\bexport\s*\{([^}]+)\}/g;
		while((m = namedExportRe.exec(clean)) !== null) {
			const items = splitTopLevel(m[1]);
			for(const item of items) {
				const parts = item.split(/\s+as\s+/);
				const localName = parts[0].trim();
				const exportedName = (parts[1] || parts[0]).trim();
				if(!localName) {
					continue;
				}
				const base = localDefs.get(localName) || {name: exportedName, kind: 'symbol', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)};
				exportsMap.set(exportedName, {...base, name: exportedName});
			}
		}

		const cjsPropFnRe = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:(\()|([A-Za-z_$][\w$]*)\s*=>|function\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*(\())/g;
		while((m = cjsPropFnRe.exec(clean)) !== null) {
			const name = m[1];
			let rawParams = '';
			if(m[3] !== undefined) {
				rawParams = m[3];
			}
			else {
				const openIdx = cjsPropFnRe.lastIndex - 1;
				const bal = extractBalanced(clean, openIdx, '(', ')');
				if(!bal) {
					continue;
				}
				if(m[2] !== undefined && !/^\s*(?::[^=]+)?=>/.test(clean.slice(bal.endIndex))) {
					continue;
				}
				rawParams = bal.content;
			}
			const counts = parseParamCounts(rawParams, ext);
			exportsMap.set(name, {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)});
		}

		const cjsPropRefRe = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g;
		while((m = cjsPropRefRe.exec(clean)) !== null) {
			const exportedName = m[1];
			const localName = m[2];
			if(!exportsMap.has(exportedName)) {
				const base = localDefs.get(localName) || {name: exportedName, kind: 'symbol', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)};
				exportsMap.set(exportedName, {...base, name: exportedName});
			}
		}

		const cjsObjRe = /\bmodule\.exports\s*=\s*\{/g;
		while((m = cjsObjRe.exec(clean)) !== null) {
			const bal = extractBalanced(clean, cjsObjRe.lastIndex - 1, '{', '}');
			if(!bal) {
				continue;
			}
			const items = splitTopLevel(bal.content);
			for(const item of items) {
				const methodMatch = /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(item);
				if(methodMatch) {
					const name = methodMatch[1];
					const openIdx = item.indexOf('(');
					const paramBal = extractBalanced(item, openIdx, '(', ')');
					const counts = parseParamCounts(paramBal ? paramBal.content : '', ext);
					exportsMap.set(name, {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)});
					continue;
				}
				const colonIdx = item.indexOf(':');
				const exportedName = (colonIdx === -1 ? item : item.slice(0, colonIdx)).trim();
				const localName = (colonIdx === -1 ? item : item.slice(colonIdx + 1)).trim();
				if(!/^[A-Za-z_$][\w$]*$/.test(exportedName)) {
					continue;
				}
				const base = localDefs.get(localName) || {name: exportedName, kind: 'symbol', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)};
				exportsMap.set(exportedName, {...base, name: exportedName});
			}
		}
	}
	else if(ext === '.py') {
		const pyDefRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;
		let m;
		while((m = pyDefRe.exec(clean)) !== null) {
			const name = m[1];
			if(name.startsWith('_')) {
				continue;
			}
			const bal = extractBalanced(clean, pyDefRe.lastIndex - 1, '(', ')');
			if(!bal) {
				continue;
			}
			const counts = parseParamCounts(bal.content, ext);
			exportsMap.set(name, {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)});
		}
		const pyClassRe = /^class\s+([A-Za-z_]\w*)/gm;
		while((m = pyClassRe.exec(clean)) !== null) {
			const name = m[1];
			if(!name.startsWith('_')) {
				exportsMap.set(name, {name, kind: 'class', minParams: 0, maxParams: Infinity, line: lineNumberAt(clean, m.index)});
			}
		}
	}
	else if(ext === '.php') {
		const phpFnRe = /\bfunction\s+([A-Za-z_]\w*)\s*\(/g;
		let m;
		while((m = phpFnRe.exec(clean)) !== null) {
			const name = m[1];
			const bal = extractBalanced(clean, phpFnRe.lastIndex - 1, '(', ')');
			if(!bal) {
				continue;
			}
			const counts = parseParamCounts(bal.content, ext);
			exportsMap.set(name, {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)});
		}
	}
	else if(ext === '.go') {
		const goFnRe = /^func\s+(?:\([^)]+\)\s*)?([A-Z]\w*)\s*\(/gm;
		let m;
		while((m = goFnRe.exec(clean)) !== null) {
			const name = m[1];
			const bal = extractBalanced(clean, goFnRe.lastIndex - 1, '(', ')');
			if(!bal) {
				continue;
			}
			const counts = parseParamCounts(bal.content, ext);
			exportsMap.set(name, {name, kind: 'function', minParams: counts.minParams, maxParams: counts.maxParams, line: lineNumberAt(clean, m.index)});
		}
	}

	return exportsMap;
}

/*
 * function formatParamBounds
 *
 * Formats minParams..maxParams into a concise label like "2 params" or "1..3 params"
 */
function formatParamBounds(info) {
	if(info.kind !== 'function') {
		return info.kind;
	}
	if(info.minParams === info.maxParams) {
		return `${info.minParams} ${info.minParams === 1 ? 'param' : 'params'}`;
	}
	if(info.maxParams === Infinity) {
		return `${info.minParams}+ params`;
	}
	return `${info.minParams}..${info.maxParams} params`;
}

/*
 * function compareSignatures
 *
 * Compares exported symbols between beforeSource and afterSource
 */
function compareSignatures(beforeSource, afterSource, ext) {
	const beforeMap = extractExports(beforeSource, ext);
	const afterMap = extractExports(afterSource, ext);
	const added = [];
	const removed = [];
	const modified = [];
	const breaking = [];

	for(const [name, beforeInfo] of beforeMap.entries()) {
		if(!afterMap.has(name)) {
			const change = {name, type: 'removed', before: beforeInfo, after: null};
			removed.push(change);
			breaking.push(change);
			continue;
		}
		const afterInfo = afterMap.get(name);
		if(beforeInfo.kind === 'function' && afterInfo.kind !== 'function') {
			const change = {
				name,
				type: 'breaking-kind',
				before: beforeInfo,
				after: afterInfo
			};
			modified.push(change);
			breaking.push(change);
			continue;
		}
		if(beforeInfo.minParams !== afterInfo.minParams || beforeInfo.maxParams !== afterInfo.maxParams) {
			const isBreaking = afterInfo.minParams > beforeInfo.minParams || afterInfo.maxParams < beforeInfo.maxParams;
			const change = {
				name,
				type: isBreaking ? 'breaking-arity' : 'compatible-arity',
				before: beforeInfo,
				after: afterInfo
			};
			modified.push(change);
			if(isBreaking) {
				breaking.push(change);
			}
		}
	}

	for(const [name, afterInfo] of afterMap.entries()) {
		if(!beforeMap.has(name)) {
			added.push({name, type: 'added', before: null, after: afterInfo});
		}
	}

	return {added, removed, modified, breaking, beforeMap, afterMap};
}

/*
 * function resolveModulePath
 *
 * Resolves a relative or module specifier from importerRel against allFilesSet
 */
function resolveModulePath(specifier, importerRel, allFilesSet, ext) {
	const importerDir = toPosix(path.dirname(importerRel));

	if(JS_EXT.has(ext)) {
		if(!specifier.startsWith('.')) {
			return null;
		}
		const baseCandidate = toPosix(path.normalize(path.join(importerDir, specifier)));
		const stripped = baseCandidate.replace(/\.(js|mjs|cjs|jsx|ts|tsx)$/, '');
		const candidates = [
			baseCandidate,
			`${stripped}.js`,
			`${stripped}.ts`,
			`${stripped}.tsx`,
			`${stripped}.mjs`,
			`${stripped}.cjs`,
			`${stripped}.jsx`,
			`${baseCandidate}/index.js`,
			`${baseCandidate}/index.ts`,
			`${baseCandidate}/index.tsx`
		];
		for(const c of candidates) {
			if(allFilesSet.has(c)) {
				return c;
			}
		}
		return null;
	}

	if(ext === '.py') {
		let modPath;
		if(specifier.startsWith('.')) {
			const dots = /^\.+/.exec(specifier)[0].length;
			const rest = specifier.slice(dots).replace(/\./g, '/');
			let baseDir = importerDir;
			for(let i = 1; i < dots; i++) {
				baseDir = toPosix(path.dirname(baseDir));
			}
			modPath = toPosix(path.normalize(path.join(baseDir, rest)));
		}
		else {
			modPath = specifier.replace(/\./g, '/');
		}
		const parentDir = toPosix(path.dirname(importerDir));
		const candidates = [
			`${modPath}.py`,
			`${modPath}/__init__.py`,
			toPosix(path.normalize(path.join(importerDir, `${modPath}.py`))),
			toPosix(path.normalize(path.join(parentDir, 'scripts', `${modPath}.py`))),
			toPosix(path.normalize(path.join('src', `${modPath}.py`)))
		];
		for(const c of candidates) {
			if(allFilesSet.has(c)) {
				return c;
			}
		}
		return null;
	}

	if(ext === '.php') {
		const cleaned = specifier.replace(/^[\/\\]+/, '');
		const candidates = [
			toPosix(path.normalize(path.join(importerDir, cleaned))),
			toPosix(path.normalize(cleaned))
		];
		for(const c of candidates) {
			if(allFilesSet.has(c)) {
				return c;
			}
		}
		return null;
	}

	return null;
}

/*
 * function extractImports
 *
 * Extracts resolved static imports and imported symbol names from source
 */
function extractImports(source, importerRel, allFilesSet) {
	const ext = path.extname(importerRel).toLowerCase();
	const clean = stripComments(source, ext);
	const imports = new Map();

	function addImport(resolvedPath, symbols) {
		if(!resolvedPath || resolvedPath === importerRel) {
			return;
		}
		if(!imports.has(resolvedPath)) {
			imports.set(resolvedPath, new Set());
		}
		const set = imports.get(resolvedPath);
		for(const s of symbols) {
			set.add(s);
		}
	}

	if(JS_EXT.has(ext)) {
		const esmImportRe = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
		let m;
		while((m = esmImportRe.exec(clean)) !== null) {
			const clause = m[1].trim();
			const spec = m[2];
			const resolved = resolveModulePath(spec, importerRel, allFilesSet, ext);
			const syms = [];
			const braceMatch = /\{([^}]+)\}/.exec(clause);
			if(braceMatch) {
				for(const part of splitTopLevel(braceMatch[1])) {
					const orig = part.split(/\s+as\s+/)[0].trim();
					if(orig) {
						syms.push(orig);
					}
				}
			}
			if(clause.includes('* as') || !braceMatch) {
				syms.push('*');
			}
			addImport(resolved, syms);
		}

		const sideEffectImportRe = /\bimport\s+['"]([^'"]+)['"]/g;
		while((m = sideEffectImportRe.exec(clean)) !== null) {
			const resolved = resolveModulePath(m[1], importerRel, allFilesSet, ext);
			addImport(resolved, ['*']);
		}

		const reExportRe = /\bexport\s+(?:\*|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g;
		while((m = reExportRe.exec(clean)) !== null) {
			const resolved = resolveModulePath(m[2], importerRel, allFilesSet, ext);
			const syms = m[1] ? splitTopLevel(m[1]).map(s => s.split(/\s+as\s+/)[0].trim()) : ['*'];
			addImport(resolved, syms);
		}

		const cjsDestructuredSpans = [];
		const cjsDestructuredRe = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while((m = cjsDestructuredRe.exec(clean)) !== null) {
			cjsDestructuredSpans.push([m.index, m.index + m[0].length]);
			const resolved = resolveModulePath(m[2], importerRel, allFilesSet, ext);
			const syms = splitTopLevel(m[1]).map(s => s.split(':')[0].trim()).filter(Boolean);
			addImport(resolved, syms);
		}

		const cjsPlainRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while((m = cjsPlainRe.exec(clean)) !== null) {
			const idx = m.index;
			if(cjsDestructuredSpans.some(([start, end]) => idx >= start && idx < end)) {
				continue;
			}
			const resolved = resolveModulePath(m[1], importerRel, allFilesSet, ext);
			addImport(resolved, ['*']);
		}
	}
	else if(ext === '.py') {
		const pyFromRe = /^\s*from\s+(\.*[\w.]*)\s+import\s+([^\n]+)/gm;
		let m;
		while((m = pyFromRe.exec(clean)) !== null) {
			const spec = m[1];
			const namesRaw = m[2].replace(/[()]/g, '');
			const syms = splitTopLevel(namesRaw).map(s => s.split(/\s+as\s+/)[0].trim()).filter(Boolean);
			const resolved = resolveModulePath(spec, importerRel, allFilesSet, ext);
			if(resolved) {
				addImport(resolved, syms);
			}
			else {
				for(const sym of syms) {
					const subSpec = spec.endsWith('.') ? `${spec}${sym}` : `${spec}.${sym}`;
					const subResolved = resolveModulePath(subSpec, importerRel, allFilesSet, ext);
					if(subResolved) {
						addImport(subResolved, ['*']);
					}
				}
			}
		}

		const pyImportRe = /^\s*import\s+([\w.,\s]+)$/gm;
		while((m = pyImportRe.exec(clean)) !== null) {
			for(const part of splitTopLevel(m[1])) {
				const modName = part.split(/\s+as\s+/)[0].trim();
				const resolved = resolveModulePath(modName, importerRel, allFilesSet, ext);
				addImport(resolved, ['*']);
			}
		}

		const pySpecRe = /\bspec_from_file_location\s*\(\s*['"]([\w.]+)['"]/g;
		while((m = pySpecRe.exec(clean)) !== null) {
			const resolved = resolveModulePath(m[1], importerRel, allFilesSet, ext);
			addImport(resolved, ['*']);
		}
	}
	else if(ext === '.php') {
		const phpIncRe = /\b(?:require|require_once|include|include_once)\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]\s*\)?/g;
		let m;
		while((m = phpIncRe.exec(clean)) !== null) {
			const resolved = resolveModulePath(m[1], importerRel, allFilesSet, ext);
			addImport(resolved, ['*']);
		}
	}

	return imports;
}

/*
 * function detectDynamicHazards
 *
 * Detects dynamic import, require or eval calls that static analysis cannot resolve
 */
function detectDynamicHazards(source, ext) {
	const clean = maskStringsAndRegex(source, ext);
	const hazards = [];

	if(JS_EXT.has(ext)) {
		const patterns = [
			{re: /\bimport\s*\(\s*(?!['"`])([^)]+)\)/g, label: 'dynamic import()'},
			{re: /\brequire\s*\(\s*(?!['"`])([^)]+)\)/g, label: 'dynamic require()'},
			{re: /\beval\s*\(/g, label: 'eval()'},
			{re: /\bnew\s+Function\s*\(/g, label: 'new Function()'}
		];
		for(const {re, label} of patterns) {
			let m;
			while((m = re.exec(clean)) !== null) {
				hazards.push({line: lineNumberAt(clean, m.index), label});
			}
		}
	}
	else if(ext === '.py') {
		const patterns = [
			{re: /\bimportlib\.import_module\s*\(/g, label: 'importlib.import_module()'},
			{re: /\b__import__\s*\(/g, label: '__import__()'},
			{re: /\beval\s*\(/g, label: 'eval()'}
		];
		for(const {re, label} of patterns) {
			let m;
			while((m = re.exec(clean)) !== null) {
				hazards.push({line: lineNumberAt(clean, m.index), label});
			}
		}
	}
	else if(ext === '.php') {
		const patterns = [
			{re: /\bcall_user_func(?:_array)?\s*\(/g, label: 'call_user_func()'},
			{re: /\beval\s*\(/g, label: 'eval()'}
		];
		for(const {re, label} of patterns) {
			let m;
			while((m = re.exec(clean)) !== null) {
				hazards.push({line: lineNumberAt(clean, m.index), label});
			}
		}
	}

	return hazards.sort((a, b) => a.line - b.line);
}

/*
 * function findCallSites
 *
 * Finds call sites of symbolName in source and counts passed arguments
 */
function findCallSites(source, symbolName, ext) {
	const clean = maskStringsAndRegex(source, ext);
	const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const callRe = new RegExp(`\\b(${escaped})\\s*\\(`, 'g');
	const sites = [];
	let m;

	while((m = callRe.exec(clean)) !== null) {
		const matchStart = m.index;
		const beforeSlice = clean.slice(Math.max(0, matchStart - 25), matchStart);
		if(/\b(function\s*\*?|def|func|class)\s+$/.test(beforeSlice)) {
			continue;
		}
		const openParenIndex = callRe.lastIndex - 1;
		const bal = extractBalanced(clean, openParenIndex, '(', ')');
		if(bal) {
			const args = splitTopLevel(bal.content);
			const hasSpread = args.some(a => a.startsWith('...') || a.startsWith('*'));
			sites.push({
				line: lineNumberAt(clean, matchStart),
				argCount: args.length,
				hasSpread
			});
		}
	}

	return sites;
}

/*
 * function isUnittestFile
 *
 * Returns true if a Python test file subclasses unittest.TestCase and so runs without pytest
 */
function isUnittestFile(source) {
	const clean = stripComments(source || '', '.py');
	return /\bunittest\.TestCase\b|^[ \t]*from[ \t]+unittest[ \t]+import[ \t][^\n]*\bTestCase\b/m.test(clean);
}

/*
 * function buildTestCommand
 *
 * Builds the test runner command for a list of test files
 */
function buildTestCommand(testFiles, fileContents) {
	if(testFiles.length === 0) {
		return null;
	}
	const quotePath = f => (f.includes(' ') ? `"${f}"` : f);
	const jsTests = testFiles.filter(f => JS_EXT.has(path.extname(f).toLowerCase())).map(quotePath);
	const pyTests = testFiles.filter(f => f.endsWith('.py'));
	const pyUnittests = pyTests.filter(f => isUnittestFile(fileContents.get(f)));
	const pyPytests = pyTests.filter(f => !pyUnittests.includes(f)).map(quotePath);
	const goTests = testFiles.filter(f => f.endsWith('.go')).map(quotePath);
	const phpTests = testFiles.filter(f => f.endsWith('.php')).map(quotePath);
	const cmds = [];
	if(jsTests.length > 0) {
		cmds.push(`node --test ${jsTests.join(' ')}`);
	}
	for(const f of pyUnittests) {
		cmds.push(`${PY_CMD} -m unittest discover -s ${quotePath(path.posix.dirname(f))} -p ${quotePath(path.posix.basename(f))}`);
	}
	if(pyPytests.length > 0) {
		cmds.push(`pytest ${pyPytests.join(' ')}`);
	}
	if(goTests.length > 0) {
		cmds.push(`go test ${goTests.join(' ')}`);
	}
	if(phpTests.length > 0) {
		cmds.push(`phpunit ${phpTests.join(' ')}`);
	}
	return cmds.join(' && ');
}

/*
 * function getDiffChangedFiles
 *
 * Returns relative POSIX paths of modified/added files from git diff against rev
 */
function getDiffChangedFiles(rootDir, rev) {
	const res = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', rev], {
		cwd: rootDir,
		encoding: 'utf8'
	});
	if(res.status !== 0) {
		throw new Error(`git diff failed: ${(res.stderr || '').trim() || 'not a git repository'}`);
	}
	const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
		cwd: rootDir,
		encoding: 'utf8'
	});
	const combined = new Set();
	for(const line of (res.stdout || '').split(/\r?\n/)) {
		if(line.trim()) {
			combined.add(toPosix(line.trim()));
		}
	}
	if(untracked.status === 0) {
		for(const line of (untracked.stdout || '').split(/\r?\n/)) {
			if(line.trim()) {
				combined.add(toPosix(line.trim()));
			}
		}
	}
	return Array.from(combined).filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase())).sort();
}

/*
 * function getGitBaselineContent
 *
 * Reads the committed version of relPath at rev, or null if the file is new
 */
function getGitBaselineContent(rootDir, rev, relPath) {
	const res = spawnSync('git', ['show', `${rev}:${toPosix(relPath)}`], {
		cwd: rootDir,
		encoding: 'utf8'
	});
	if(res.status !== 0) {
		return null;
	}
	return res.stdout;
}

/*
 * function analyzeRepo
 *
 * Runs the full reverse-dependency, signature-diff, call-site and test-gap analysis
 */
function analyzeRepo(opts) {
	const rootDir = resolveRoot(opts.root);
	const allFiles = walkRepo(rootDir);
	const allFilesSet = new Set(allFiles);

	const targetSet = new Set();
	for(const f of opts.files) {
		const abs = path.isAbsolute(f) ? f : path.resolve(rootDir, f);
		if(!fs.existsSync(abs)) {
			throw new Error(`Target file not found: ${f}`);
		}
		const rel = toPosix(path.relative(rootDir, abs));
		targetSet.add(rel);
		allFilesSet.add(rel);
	}
	if(opts.diff) {
		for(const rel of getDiffChangedFiles(rootDir, opts.rev)) {
			if(fs.existsSync(path.join(rootDir, rel))) {
				targetSet.add(rel);
				allFilesSet.add(rel);
			}
		}
	}

	const targets = Array.from(targetSet).sort();
	const fileContents = new Map();
	const reverseGraph = new Map();

	for(const rel of allFilesSet) {
		const fullPath = path.join(rootDir, rel);
		if(!fs.existsSync(fullPath)) {
			continue;
		}
		const content = fs.readFileSync(fullPath, 'utf8');
		fileContents.set(rel, content);
	}

	for(const [rel, content] of fileContents.entries()) {
		const imports = extractImports(content, rel, allFilesSet);
		for(const [importedRel, symbols] of imports.entries()) {
			if(!reverseGraph.has(importedRel)) {
				reverseGraph.set(importedRel, new Map());
			}
			reverseGraph.get(importedRel).set(rel, symbols);
		}
	}

	const changed = [];
	const breaking = [];
	const impactedByDepth = new Map();
	const affectedTests = new Set();
	const untested = [];
	const dynamicWarnings = [];
	const seenDynamicFiles = new Set();

	for(const target of targets) {
		const content = fileContents.get(target) || '';
		const ext = path.extname(target).toLowerCase();
		const afterExports = extractExports(content, ext);

		let sigDiff = null;
		if(opts.diff) {
			const beforeContent = getGitBaselineContent(rootDir, opts.rev, target);
			if(beforeContent !== null) {
				sigDiff = compareSignatures(beforeContent, content, ext);
			}
		}

		const changeDetails = [];
		if(sigDiff) {
			for(const rem of sigDiff.removed) {
				changeDetails.push(`removed export ${rem.name}`);
			}
			for(const mod of sigDiff.modified) {
				changeDetails.push(`export ${mod.name}: ${formatParamBounds(mod.before)} -> ${formatParamBounds(mod.after)}`);
			}
			for(const add of sigDiff.added) {
				changeDetails.push(`added export ${add.name} (${formatParamBounds(add.after)})`);
			}
		}
		else {
			const exportList = Array.from(afterExports.values()).map(e => `${e.name} (${formatParamBounds(e)})`);
			if(exportList.length > 0) {
				changeDetails.push(`exports: ${exportList.join(', ')}`);
			}
		}
		changed.push({
			file: target,
			details: changeDetails.length > 0 ? changeDetails.join('; ') : 'modified'
		});

		const directCallers = reverseGraph.get(target) || new Map();
		for(const [callerFile, importedSymbols] of directCallers.entries()) {
			const callerContent = fileContents.get(callerFile) || '';
			const callerExt = path.extname(callerFile).toLowerCase();

			if(sigDiff) {
				for(const rem of sigDiff.removed) {
					if(!importedSymbols.has('*') && !importedSymbols.has(rem.name)) {
						continue;
					}
					const sites = findCallSites(callerContent, rem.name, callerExt);
					if(sites.length > 0) {
						for(const site of sites) {
							breaking.push({
								caller: callerFile,
								line: site.line,
								symbol: rem.name,
								reason: `calls removed export ${rem.name}`
							});
						}
					}
					else if(importedSymbols.has(rem.name)) {
						breaking.push({
							caller: callerFile,
							line: 1,
							symbol: rem.name,
							reason: `imports removed export ${rem.name}`
						});
					}
				}
				for(const brk of sigDiff.breaking) {
					if(brk.type !== 'breaking-kind') {
						continue;
					}
					if(!importedSymbols.has('*') && !importedSymbols.has(brk.name)) {
						continue;
					}
					const sites = findCallSites(callerContent, brk.name, callerExt);
					for(const site of sites) {
						breaking.push({
							caller: callerFile,
							line: site.line,
							symbol: brk.name,
							reason: `calls non-function export ${brk.name}`
						});
					}
				}
			}

			for(const [symName, expInfo] of afterExports.entries()) {
				if(expInfo.kind !== 'function') {
					continue;
				}
				if(!importedSymbols.has('*') && !importedSymbols.has(symName)) {
					continue;
				}
				const sites = findCallSites(callerContent, symName, callerExt);
				for(const site of sites) {
					if(site.hasSpread) {
						continue;
					}
					if(site.argCount < expInfo.minParams || site.argCount > expInfo.maxParams) {
						breaking.push({
							caller: callerFile,
							line: site.line,
							symbol: symName,
							reason: `calls ${symName} with ${site.argCount} ${site.argCount === 1 ? 'arg' : 'args'} (expects ${formatParamBounds(expInfo)})`
						});
					}
				}
			}
		}

		const visited = new Set([target]);
		let frontier = [target];
		let targetHasTest = isTestFile(target);

		for(let d = 1; d <= opts.depth && frontier.length > 0; d++) {
			const nextFrontier = [];
			for(const curr of frontier) {
				const callers = reverseGraph.get(curr);
				if(!callers) {
					continue;
				}
				for(const callerFile of callers.keys()) {
					if(visited.has(callerFile)) {
						continue;
					}
					visited.add(callerFile);
					nextFrontier.push(callerFile);

					if(isTestFile(callerFile)) {
						affectedTests.add(callerFile);
						targetHasTest = true;
					}
					else if(!targetSet.has(callerFile)) {
						const prevDepth = impactedByDepth.get(callerFile);
						if(prevDepth === undefined || d < prevDepth) {
							impactedByDepth.set(callerFile, d);
						}
					}
				}
			}
			frontier = nextFrontier;
		}

		if(isTestFile(target)) {
			affectedTests.add(target);
		}
		else if(!targetHasTest) {
			untested.push(target);
		}

		for(const f of visited) {
			if(seenDynamicFiles.has(f)) {
				continue;
			}
			seenDynamicFiles.add(f);
			const fContent = fileContents.get(f) || '';
			const fExt = path.extname(f).toLowerCase();
			for(const h of detectDynamicHazards(fContent, fExt)) {
				dynamicWarnings.push({file: f, line: h.line, label: h.label});
			}
		}
	}

	const impactedList = Array.from(impactedByDepth.entries())
		.map(([file, depth]) => ({file, depth}))
		.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));

	const testsList = Array.from(affectedTests).sort();
	const testCommand = buildTestCommand(testsList, fileContents);

	return {
		root: toPosix(rootDir),
		changed,
		breaking,
		impacted: impactedList,
		tests: testsList,
		testCommand,
		untested,
		dynamic: dynamicWarnings
	};
}

/*
 * function formatReport
 *
 * Formats the analysis result into a compact multi-line CLI report
 */
function formatReport(report) {
	const lines = [];

	if(report.changed.length === 0) {
		lines.push('CHANGED:   none');
	}
	else {
		const items = report.changed.map(c => `${c.file} (${c.details})`);
		lines.push(`CHANGED:   ${items.join(', ')}`);
	}

	if(report.breaking.length === 0) {
		lines.push('BREAKING:  none');
	}
	else {
		const items = report.breaking.map(b => `${b.caller}:${b.line} (${b.reason})`);
		lines.push(`BREAKING:  ${items.join(', ')}`);
	}

	if(report.impacted.length === 0) {
		lines.push('IMPACTED:  0 files');
	}
	else {
		const countsByDepth = new Map();
		for(const item of report.impacted) {
			countsByDepth.set(item.depth, (countsByDepth.get(item.depth) || 0) + 1);
		}
		const depthSummary = Array.from(countsByDepth.entries())
			.map(([d, c]) => `depth ${d}: ${c}`)
			.join(', ');
		const fileNames = report.impacted.map(i => `${i.file} [d${i.depth}]`).join(', ');
		lines.push(`IMPACTED:  ${report.impacted.length} ${report.impacted.length === 1 ? 'file' : 'files'} (${depthSummary}) -> ${fileNames}`);
	}

	if(report.tests.length === 0) {
		lines.push('TESTS:     none');
	}
	else {
		lines.push(`TESTS:     ${report.testCommand}`);
	}

	if(report.untested.length === 0) {
		lines.push('UNTESTED:  none');
	}
	else {
		lines.push(`UNTESTED:  ${report.untested.join(', ')} (no test imports this path)`);
	}

	if(report.dynamic.length > 0) {
		const items = report.dynamic.map(d => `${d.file}:${d.line} (${d.label})`);
		lines.push(`DYNAMIC:   ${items.join(', ')}`);
	}

	return lines.join('\n');
}

if(require.main === module) {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	}
	catch(err) {
		console.error(`[blast-radius] ${err.message}\n${USAGE}`);
		process.exit(2);
	}
	let report;
	try {
		report = analyzeRepo(opts);
	}
	catch(err) {
		console.error(`[blast-radius] ${err.message}`);
		process.exit(2);
	}
	if(opts.json) {
		console.log(JSON.stringify(report, null, '\t'));
	}
	else {
		console.log(formatReport(report));
	}
	process.exit(report.breaking.length > 0 ? 1 : 0);
}

module.exports = {
	parseArgs,
	extractExports,
	compareSignatures,
	extractImports,
	detectDynamicHazards,
	findCallSites,
	analyzeRepo,
	formatReport
};
