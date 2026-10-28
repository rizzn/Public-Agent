/*
 File Name:     pii-guard.js
 Description:   Keeps personal data and credentials out of requests to the model provider (GDPR safeguard for client projects).
                PreToolUse:       denies file reads, searches and shell commands that touch credentials (.env, wp-config.php,
                                  Rails master key, SSH and TLS keys) without asking; asks before they touch dumps, databases,
                                  uploads, media, logs or exports;
                                  denies Write/Edit that would write a redaction placeholder back into a file.
                PostToolUse:      replaces e-mails, phone numbers, IBANs and public IPv4/IPv6 in tool output with placeholders.
                UserPromptSubmit: blocks prompts that contain such data; the prefix "!pii-ok " lets one through.
                Antigravity gets the PreToolUse guards only: its PostToolUse sees no tool output and it has no
                prompt hook (antigravity.google/docs/hooks), so nothing there can redact or block a prompt.
                Qwen Code gets PreToolUse and UserPromptSubmit, no redaction: its PostToolUse ignores updatedToolOutput
                and a block decision (measured 2026-10-20), so tool output reaches its model in full — acceptable for a
                local model, not for a provider API.
                Pattern based only: names and postal addresses without a fixed shape pass through.
                Registered in the agent's hook config:
                Claude Code: ~/.claude/settings.json · Antigravity: ~/.gemini/config/hooks.json · Qwen Code: ~/.qwen/settings.json
 Author:        Stephan Riedl
 Author URI:    https://stph.so/

 Usage:
   node <hooks-dir>/pii-guard.js claude        # PreToolUse, PostToolUse, UserPromptSubmit (stdin: hook JSON)
   node <hooks-dir>/pii-guard.js antigravity   # Antigravity PreToolUse, matcher view_file|grep_search|run_command
   node <hooks-dir>/pii-guard.js qwen          # Qwen PreToolUse, UserPromptSubmit, shell powershell
*/

// ==================== SWITCHES ====================

// true = part active, false = part passes everything through, for every agent alike.
// Credentials denies reads of credentials without asking, PreToolUse asks before the data paths, and before credentials
// too while Credentials is off. The placeholder deny (a write of [PII:…] back into a file) follows PostToolUse.
// All four false switches the guard off everywhere; the registrations stay as they are.
const ENABLED = {
	PreToolUse: false,
	PostToolUse: true,
	UserPromptSubmit: true,
	Credentials: true,
};

// ==================== CONFIGURATION ====================

const fs = require('fs');
const net = require('net');

// Matched against lower-case paths with forward slashes
// Data files also count with a compression, backup or rotation suffix (dump.sql.bak, debug.log.1)
const SUFFIX = '(\\.(gz|bz2|xz|zip|bak|old|orig|tmp|\\d+))?$';
const DATA_PATHS = [
	new RegExp(`\\.(sql|dump|log|csv|xlsx|sqlite|sqlite3|db)${SUFFIX}`),
	/(^|\/)(wp-content\/uploads|storage\/app)(\/|$)|(^|\/)(uploads|media)\/|(\/)(uploads|media)$/,
	/(\/|^)exports?\/|\/exports?$/,
];
const CREDENTIAL_PATHS = [
	/(^|\/)\.env(\.[^\/]*)?$/,
	/(^|\/)wp-config\.php$/,
	/(^|\/)\.ssh\/|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?(\.(bak|old|orig))?$|\.(pem|key|p12|pfx)$/,
];
// Templates hold variable names only, public keys and known hosts are public by design
const NO_SECRET = /(^|\/)\.env\.(example|sample|dist|template)$|\.pub$|(^|\/)known_hosts(\.\w+)?$/;

// Extensions a wildcard like dump.s?l or kunden.* could stand for
const DATA_EXT = ['sql', 'dump', 'log', 'csv', 'xlsx', 'sqlite', 'sqlite3', 'db'];
const CREDENTIAL_EXT = ['env', 'pem', 'key', 'p12', 'pfx'];

// Shell segments that read personal data straight from a database, no file path involved
// Only as the program a segment runs, not as a word in an argument. Before it may stand sudo (with options), the
// PowerShell call operator, or a launcher that runs it in a container, a dev environment or on a remote host:
// docker compose exec db mysql, kubectl exec -it pod -- psql, ddev wp user list, ssh prod "mysql -e …"
const SUDO = '(?:sudo\\s+(?:-\\w+\\s+(?:[\\w.-]+\\s+)?)*)?';
const LAUNCHER = `(?:(?:(?:docker|podman)(?:[\\s-]compose)?|kubectl)\\s+exec\\s+(?:-{1,2}[\\w-]+(?:[= ][^\\s-]\\S*)?\\s+)*[\\w./:-]+\\s+(?:--\\s+)?|(?:ddev|lando)\\s+(?:exec\\s+)?|ssh\\s+(?:-\\w+(?:\\s+[^\\s-]\\S*)?\\s+)*[\\w.@-]+\\s+["']?)?`;
const LAUNCH = `^${SUDO}${LAUNCHER}${SUDO}(?:&\\s*)?`;
const DB_CLIENTS = 'mysql|mariadb|mysqlsh|psql|sqlite3|sqlcmd|invoke-sqlcmd|duckdb|mongosh|mongo|redis-cli|clickhouse-client|mysqldump|mariadb-dump|pg_dump|pg_dumpall|mongoexport|mongodump';
const SENSITIVE_COMMANDS = [
	new RegExp(`${LAUNCH}["']?(?:[^\\s"']*[\\/\\\\])?(${DB_CLIENTS})(\\.exe)?["']?(\\s|$)`, 'i'),
	// WordPress CLI: database queries, user/post/comment/meta reads, option exports, WooCommerce
	new RegExp(`${LAUNCH}wp\\s+(?:--[\\w-]+(?:=\\S+)?\\s+)*(db\\s+(query|export|cli|search)|(user|post|comment)\\s+(list|get|meta)|option\\s+(get|list)|wc\\s)`, 'i'),
	// Django: python manage.py dbshell, .\manage.py dbshell
	new RegExp(`${LAUNCH}(?:["']?(?:[^\\s"']*[\\/\\\\])?(?:python(?:\\d+(?:\\.\\d+)?)?|py(?:3)?)(?:\\.exe)?["']?\\s+["']?(?:[^\\s"']*[\\/\\\\])?manage\\.py["']?|["']?(?:\\.[\\/\\\\]|[^\\s"']*[\\/\\\\])?manage\\.py["']?)\\s+(dbshell|dumpdata)(\\s|$)`, 'i'),
	// Laravel Artisan: php artisan tinker, .\artisan db
	new RegExp(`${LAUNCH}(?:["']?(?:[^\\s"']*[\\/\\\\])?php(?:\\.exe)?["']?\\s+)?["']?(?:\\.[\\/\\\\]|[^\\s"']*[\\/\\\\])?artisan["']?\\s+(tinker|db(:\\w+)?)(\\s|$)`, 'i'),
	// Rails: rails dbconsole, bin/rails console, bin\rails console, bundle exec rails console
	new RegExp(`${LAUNCH}(?:bundle(?:\\.exe)?\\s+exec\\s+)?["']?(?:(?:bin|script)[\\/\\\\])?rails(?:\\.exe)?["']?\\s+(dbconsole|db|console|runner)(\\s|$)`, 'i'),
];

// Ripgrep file types that select data files (Grep "type" field)
const SENSITIVE_GREP_TYPES = ['sql', 'csv', 'log'];

const SHELL_TOOLS = ['Bash', 'PowerShell'];
const REDACT_TOOLS = ['Read', 'Grep', 'Edit', ...SHELL_TOOLS];
// Qwen Code sends its runtime tool ids; the fields match Claude's (file_path, path, content, new_string, command)
const QWEN_TOOLS = {read_file: 'Read', grep_search: 'Grep', edit: 'Edit', write_file: 'Write', run_shell_command: 'Bash'};
// "force_ask" ignores Antigravity's cached "Always Allow", so one earlier click never opens the gate for good
const AGY_DECISION = 'force_ask';
const OVERRIDE_PREFIX = '!pii-ok ';

const PLACEHOLDER = /\[PII:(EMAIL|PHONE|IBAN|IP)\]/;
const SEP = '(?:\\s?[\\/-]?\\s?)';
const EXT = '(?:\\s?(?:x|ext\\.?)\\s?\\d{1,6})?';
const EXT_TAIL = /\s?(x|ext\.?)\s?\d+$/i;

// Phone context: a bare digit run counts as a phone number only after one of these words; short words only at a
// word start, so Bestellnr., Hotel or Titel give no context, compounds like Diensttelefon still do
const PHONE_CONTEXT = /(\b(tel|phone|mobil|handy|fax|fon|whatsapp|hotline)|telefon|rufnummer)[^\n]{0,20}$/i;

// A value ends before a word character, a dotted or dashed continuation (version, UUID group), but a full stop
// that ends the sentence still counts as the end
const END = '(?!\\w|\\.\\d|-\\w)';

// "need": a character every match contains; text without it skips the detector
const DETECTORS = [
	{ type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, valid: validIban },
	// Bounded local part (RFC limit 64): keeps long tokens without "@" linear instead of quadratic
	{ type: 'EMAIL', need: '@', re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g, valid: realEmail },
	{ type: 'IP', need: '.', re: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, valid: publicIpv4 },
	// Global unicast 2000::/3 as access logs write it; link-local, ULA and loopback never leave the network
	{ type: 'IP', need: ':', re: /(?<![\w:.])[23][0-9a-f]{3}(?::{1,2}[0-9a-f]{1,4}){1,7}(?:::)?(?!\w|:|\.\d)/gi, valid: publicIpv6 },
	// International: single-digit area codes like Vienna (+43 1) are allowed, an extension like x123 too;
	// 00 never after a dot or dash, so UUID groups like -0012-4123 stay untouched, and needs ten digits in all
	{ type: 'PHONE', re: new RegExp(`(?:(?<![\\w+#/])\\+|(?<![\\w+#/.-])00)[1-9]\\d{0,2}(?:${SEP}\\(0\\))?(?:${SEP}\\d{1,6}){1,5}${EXT}${END}`, 'g'), valid: (s, text, offset) => validPhone(s.replace(EXT_TAIL, ''), text, offset, s.startsWith('00') ? 10 : 8) },
	// National: no dash-joined neighbours, so UUID groups stay untouched; short last group for extensions like -0;
	// one-digit area codes only in brackets like Vienna (01), so 02-123456 reference numbers stay untouched;
	// eight digits like 0815-1234 (order number, ISSN) only with a phone word
	{ type: 'PHONE', re: new RegExp(`(?<![\\w#/.-])(?:\\(0[1-9]\\)|\\(?0[1-9]\\d{1,4}\\)?)(?:${SEP}\\d{2,8}){0,3}(?:${SEP}\\d{1,8})${END}`, 'g'), valid: (s, text, offset) => validPhone(s, text, offset, 9) },
	// North American (NNN) NNN-NNNN, NNN.NNN.NNNN, +1-NNN-NNN-NNNN: only with separators, area and exchange never start
	// with 0 or 1 (so 100.100.1234 build numbers stay untouched), a bare 10-digit run stays open; dots never mix with
	// other separators, so clause numbers like 252.204-7012 stay untouched
	{ type: 'PHONE', re: new RegExp(`(?<![\\w.+-])(?:\\+?1[\\s.-]?)?(?:\\([2-9]\\d{2}\\)\\s?[2-9]\\d{2}[\\s.-]|[2-9]\\d{2}\\.[2-9]\\d{2}\\.|[2-9]\\d{2}[\\s-][2-9]\\d{2}[\\s-])\\d{4}${EXT}${END}`, 'g'), valid: s => digitCount(s.replace(EXT_TAIL, ''), 10, 11) },
];

// ==================== HELPERS ====================

function placeholder(type) {
	return `[PII:${type}]`;
}

function validIban(s) {
	const v = s.replace(/ /g, '');
	if(v.length < 15 || v.length > 34) return false;
	let mod = 0;
	for(const ch of v.slice(4) + v.slice(0, 4)) {
		for(const d of /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55)) mod = (mod * 10 + Number(d)) % 97;
	}
	return mod === 1;
}

function realEmail(s) {
	const [local, domain] = s.toLowerCase().split('@');
	if(local === 'git') return false;
	if(/^(example\.(com|org|net)|localhost)$/.test(domain)) return false;
	// logo@2x.png and similar asset names are not addresses
	return !/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|ts|php|json|md|html?)$/.test(domain);
}

// Public DNS resolvers appear in configs and docs and identify no person
const RESOLVERS = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220'];

function publicIpv4(s, text, offset) {
	const octets = s.split('.').map(Number);
	const [a, b] = octets;
	if(octets.some(o => o > 255) || RESOLVERS.includes(s)) return false;
	// Version and section numbers: Chrome/120.0.0.0 after a product name, x.0.0.0, or four single digits like 3.1.2.4
	if(/[A-Za-z]\/$/.test(text.slice(Math.max(0, offset - 2), offset))) return false;
	if(octets.slice(1).every(o => o === 0) || octets.every(o => o < 10)) return false;
	if(a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if(a === 169 && b === 254) return false;
	if(a === 172 && b >= 16 && b <= 31) return false;
	if(a === 192 && b === 168) return false;
	if(a === 100 && b >= 64 && b <= 127) return false;
	return true;
}

const RESOLVERS6 = ['2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888', '2001:4860:4860::8844', '2620:fe::fe', '2620:fe::9'];

// 2001:db8::/32 is the documentation prefix
function publicIpv6(s) {
	return net.isIPv6(s) && !/^2001:0?db8:/i.test(s) && !RESOLVERS6.includes(s.toLowerCase());
}

function digitCount(s, min, max) {
	const n = s.replace(/\D/g, '').length;
	return n >= min && n <= max;
}

// Written with +, separators or a German mobile prefix and at least min digits it is a phone number; a bare digit run
// (customer, contract or article number) or a shorter one only with a phone word right before it
function validPhone(s, text, offset, min = 8) {
	if(!digitCount(s, 8, 15)) return false;
	// 01/12/2026 or 01-12-2026 is a date
	if(/^\d{1,2}([\/.-])\d{1,2}\1\d{2,4}$/.test(s)) return false;
	if(digitCount(s, min, 15) && (s.startsWith('+') || /[\s\/()-]/.test(s) || /^01[5-7]\d{8,9}$/.test(s))) return true;
	return PHONE_CONTEXT.test(text.slice(Math.max(0, offset - 30), offset));
}

// Returns the redacted text, the types found and every replaced value
function redactText(text) {
	const found = new Set();
	const matches = [];
	let out = text;
	for(const { type, need, re, valid } of DETECTORS) {
		if(need && !out.includes(need)) continue;
		out = out.replace(re, (m, ...rest) => {
			const offset = rest[rest.length - 2];
			if(!valid(m, rest[rest.length - 1], offset)) return m;
			found.add(type);
			matches.push({ type, value: m });
			return placeholder(type);
		});
	}
	return { text: out, found, matches };
}

// Redacts every string inside the tool response, so the output keeps its shape
function redactValue(value, found) {
	if(typeof value === 'string') {
		const r = redactText(value);
		r.found.forEach(t => found.add(t));
		return r.text;
	}
	if(Array.isArray(value)) return value.map(v => redactValue(v, found));
	if(value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, found)]));
	}
	return value;
}

// 'credential', 'data' or null
function pathKind(p) {
	if(typeof p !== 'string' || !p) return null;
	const variants = expandBraces(p.replace(/\\/g, '/').toLowerCase());
	// A deny must hit: an ambiguous wildcard like *.p* or kunden.* stays with the data paths
	if(variants.some(v => !NO_SECRET.test(v) && (CREDENTIAL_PATHS.some(re => re.test(v)) || wildcardExtension(v, CREDENTIAL_EXT, true)))) return 'credential';
	if(variants.some(v => DATA_PATHS.some(re => re.test(v)) || wildcardExtension(v, [...DATA_EXT, ...CREDENTIAL_EXT]))) return 'data';
	return null;
}

function pathTargets(paths) {
	return paths.map(p => ({ kind: pathKind(p), label: p })).filter(t => t.kind);
}

// A path and its link target name the same file: report it once, a credential first
function firstTarget(targets) {
	const first = targets.find(t => t.kind === 'credential') || targets[0];
	return first ? [first] : [];
}

// *.{sql,csv} -> *.sql, *.csv
function expandBraces(glob) {
	const m = /\{([^{}]*)\}/.exec(glob);
	if(!m) return [glob];
	return m[1].split(',').flatMap(alt => expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

// dump.s?l or kunden.* could match a data file; a bare * without extension stays open.
// literal: the extension must stand in the wildcard as written, so .env* and *.pem* count but *.p?m does not
function wildcardExtension(p, exts, literal = false) {
	const base = p.split('/').pop();
	const dot = base.lastIndexOf('.');
	const ext = dot >= 0 ? base.slice(dot + 1) : '';
	if(!/[*?]/.test(ext)) return false;
	// Brackets count literally: a typo like data.[sql must never crash the guard into failing open
	const re = new RegExp(`^${ext.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
	return exts.some(e => re.test(e) && (!literal || ext.includes(e)));
}

// A symlink or junction with a harmless name may point at a dump
// UNC paths are skipped: resolving an unreachable share would block until the network timeout
function withRealPath(p) {
	if(typeof p !== 'string' || !p) return [];
	if(/^(\\\\|\/\/)/.test(p)) return [p];
	try {
		return [p, fs.realpathSync.native(p)];
	}
	catch {
		return [p];
	}
}

function commandTargets(command) {
	if(typeof command !== 'string') return [];
	const segments = command.split(/;|&&|\|\||\||\r?\n/).map(segment => segment.trim());
	const databases = segments.filter(segment => SENSITIVE_COMMANDS.some(re => re.test(segment))).map(segment => ({ kind: 'data', label: `database access "${segment.split(/\s+/).slice(0, 6).join(' ')}"` }));
	const paths = pathTargets(segments
		// console.log( in inline scripts (node -e) is a call, not a log file
		.flatMap(segment => segment.replace(/console\.log\s*\(/gi, '(').split(/[\s<>()'"`,;=]+/)));
	return [...databases, ...paths];
}

// Every target as { kind: 'credential' | 'data', label }
function sensitiveTargets(tool, ti) {
	if(tool === 'Read') return firstTarget(pathTargets(withRealPath(ti.file_path)));
	if(tool === 'Grep') {
		const types = SENSITIVE_GREP_TYPES.includes(ti.type) ? [{ kind: 'data', label: `type ${ti.type}` }] : [];
		return pathTargets([...withRealPath(ti.path), ti.glob]).concat(types);
	}
	if(SHELL_TOOLS.includes(tool)) return commandTargets(ti.command);
	return [];
}

// Antigravity tool names and arguments (antigravity.google/docs/hooks, "Supported tools")
function agyTargets(name, args) {
	if(name === 'view_file') return firstTarget(pathTargets(withRealPath(args.AbsolutePath)));
	if(name === 'grep_search') return pathTargets([...withRealPath(args.SearchPath), ...[].concat(args.Includes || [])]);
	if(name === 'run_command') return commandTargets(args.CommandLine);
	return [];
}

function labels(targets) {
	return targets.map(t => t.label).join(', ');
}

function targetReason(targets, provider) {
	return `pii-guard: ${labels(targets)} may contain personal data or credentials that would be sent to the ${provider} API.`;
}

function credentialReason(targets, provider) {
	return `pii-guard: ${labels(targets)} may hold credentials that would be sent to the ${provider} API, so the call is blocked. Ask the user for the one value you need, or ask the user to run the command.`;
}

// Credentials are denied without asking, the other targets asked for; returns [kind, reason] or null
function pathDecision(targets, enabled, provider) {
	const credentials = enabled.Credentials ? targets.filter(t => t.kind === 'credential') : [];
	if(credentials.length) return ['deny', credentialReason(credentials, provider)];
	if(!enabled.PreToolUse || !targets.length) return null;
	return ['ask', targetReason(targets, provider)];
}

function decision(kind, reason) {
	return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason } };
}

// ==================== HOOK EVENTS ====================

const PLACEHOLDER_REASON = 'pii-guard: this would write a redaction placeholder like [PII:…]. It stands for a value hidden from you and would overwrite the real data. Leave those values untouched or ask the user for the value.';
// A shell command cannot be told apart as read or write, so any placeholder in it is denied
const PLACEHOLDER_SHELL_REASON = 'pii-guard: the command contains a redaction placeholder like [PII:…]. Run in a shell it could write that placeholder over real data. Leave those values untouched or ask the user for the value; to only search for a placeholder, use the Grep tool.';

// Text a call would write: file content, the replacement of an edit, or a shell command (sed -i, echo >>, sql replace -r)
function writtenText(tool, ti) {
	if(tool === 'Write') return ti.content;
	if(tool === 'Edit') return ti.new_string;
	if(SHELL_TOOLS.includes(tool)) return ti.command;
	return null;
}

function preToolUse(input, enabled, provider = 'Anthropic') {
	const tool = input.tool_name;
	const ti = input.tool_input || {};
	// Placeholder guard follows the redaction switch: without it a redacted file could be written back over real data
	const text = writtenText(tool, ti);
	if(enabled.PostToolUse && typeof text === 'string' && PLACEHOLDER.test(text)) {
		return decision('deny', SHELL_TOOLS.includes(tool) ? PLACEHOLDER_SHELL_REASON : PLACEHOLDER_REASON);
	}
	if(!enabled.Credentials && !enabled.PreToolUse) return null;
	const verdict = pathDecision(sensitiveTargets(tool, ti), enabled, provider);
	return verdict && decision(...verdict);
}

// Antigravity output for an allowed call is empty: "allow" would skip its own permission prompts
function agyPreToolUse(input, enabled) {
	const call = input.toolCall || {};
	const command = call.name === 'run_command' && call.args ? call.args.CommandLine : null;
	if(enabled.PostToolUse && typeof command === 'string' && PLACEHOLDER.test(command)) return { decision: 'deny', reason: PLACEHOLDER_SHELL_REASON };
	if(!enabled.Credentials && !enabled.PreToolUse) return null;
	const verdict = pathDecision(agyTargets(call.name, call.args || {}), enabled, 'Google');
	return verdict && { decision: verdict[0] === 'ask' ? AGY_DECISION : 'deny', reason: verdict[1] };
}

function postToolUse(input, enabled) {
	if(!enabled.PostToolUse || !REDACT_TOOLS.includes(input.tool_name) || input.tool_response === undefined) return null;
	const found = new Set();
	const redacted = redactValue(input.tool_response, found);
	if(!found.size) return null;
	return {
		hookSpecificOutput: {
			hookEventName: 'PostToolUse',
			updatedToolOutput: redacted,
			additionalContext: `pii-guard replaced ${[...found].join(', ')} values with [PII:…] placeholders. Never write a placeholder into a file.`,
		},
	};
}

function userPromptSubmit(input, enabled) {
	const prompt = typeof input.prompt === 'string' ? input.prompt : '';
	if(!enabled.UserPromptSubmit || prompt.trimStart().startsWith(OVERRIDE_PREFIX)) return null;
	const { found } = redactText(prompt);
	if(!found.size) return null;
	return {
		decision: 'block',
		reason: `pii-guard: the prompt contains ${[...found].join(', ')} and was not sent. Remove the data, or start the prompt with "${OVERRIDE_PREFIX.trim()}" to send it anyway.`,
		hookSpecificOutput: { hookEventName: 'UserPromptSubmit', suppressOriginalPrompt: true },
	};
}

// Qwen Code: Claude's protocol with its own tool ids. PostToolUse passes, Qwen cannot take a redacted output;
// its panel turns "ask" into deny (ACP), which for a gate that asks is the safer side anyway
function qwenRun(input, enabled) {
	switch(input.hook_event_name) {
		case 'PreToolUse': return preToolUse({...input, tool_name: QWEN_TOOLS[input.tool_name]}, enabled, 'Qwen');
		// prompt is already expanded: an address arrives with a space before its @ (@ marks a file reference);
		// submitted_prompt keeps the typed text (hooks.md "submitted_prompt"), so both are checked, the typed one first
		// for the override prefix
		case 'UserPromptSubmit': return userPromptSubmit({...input, prompt: [input.submitted_prompt, input.prompt].filter(s => typeof s === 'string').join('\n')}, enabled);
		default: return null;
	}
}

// Returns the hook JSON to print, or null to let the event pass unchanged.
// Antigravity payloads carry no event name; the guard is registered there for PreToolUse only.
function run(input, enabled = ENABLED, agent = 'claude') {
	if(agent === 'antigravity') return agyPreToolUse(input || {}, enabled);
	if(agent === 'qwen') return qwenRun(input || {}, enabled);
	switch(input && input.hook_event_name) {
		case 'PreToolUse': return preToolUse(input, enabled);
		case 'PostToolUse': return postToolUse(input, enabled);
		case 'UserPromptSubmit': return userPromptSubmit(input, enabled);
		default: return null;
	}
}

module.exports = { ENABLED, run, redactText, placeholder };

// ==================== MAIN EXECUTION ====================

if(require.main === module) {
	// Fail open: a broken hook must never block all work
	try {
		const agent = process.argv[2];
		if(agent === 'claude' || agent === 'antigravity' || agent === 'qwen') {
			const result = run(JSON.parse(fs.readFileSync(0, 'utf8') || '{}'), ENABLED, agent);
			if(result) process.stdout.write(JSON.stringify(result));
		}
	}
	catch(err) {
		process.stderr.write(`pii-guard: ${err.message}`);
	}
	process.exit(0);
}
