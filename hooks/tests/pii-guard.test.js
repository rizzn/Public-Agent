const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const {ENABLED, run, redactText, placeholder} = require('../pii-guard.js');

const SCRIPT = path.join(__dirname, '..', 'pii-guard.js');
const ALL_ON = {PreToolUse: true, PostToolUse: true, UserPromptSubmit: true};

// Fictitious data only: documentation IBAN, TEST-NET-3 address, invented names and numbers.
// Assembled at runtime so this file holds no detectable value and stays readable through the hook itself.
const EMAIL = ['max.mustermann', 'kunde.de'].join('@');
const IBAN = ['DE89', '3704', '0044', '0532', '0130', '00'].join(' ');
const IP = ['203', '0', '113', '7'].join('.');
const PHONE = ['+49 30', '12345678'].join(' ');

function pre(tool, toolInput, enabled = ALL_ON) {
	const out = run({hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput}, enabled);
	return out && out.hookSpecificOutput.permissionDecision;
}

function post(tool, response, enabled = ALL_ON) {
	const out = run({hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, tool_response: response}, enabled);
	return out && out.hookSpecificOutput.updatedToolOutput;
}

function prompt(text, enabled = ALL_ON) {
	return run({hook_event_name: 'UserPromptSubmit', prompt: text}, enabled);
}

test('path guard asks for Read, Grep and shell access to sensitive paths', () => {
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\backup\\dump.sql'}), 'ask');
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\.env'}), 'ask');
	assert.strictEqual(pre('Read', {file_path: '/srv/site/wp-config.php'}), 'ask');
	assert.strictEqual(pre('Grep', {pattern: 'x', path: 'C:\\proj\\wp-content\\uploads'}), 'ask');
	assert.strictEqual(pre('Grep', {pattern: 'x', glob: '*.csv'}), 'ask');
	assert.strictEqual(pre('Bash', {command: 'cat backup/dump.sql | head -20'}), 'ask');
	assert.strictEqual(pre('Bash', {command: 'ls exports/'}), 'ask');
	assert.strictEqual(pre('PowerShell', {command: 'Get-Content "C:\\proj\\logs\\error.log" -Tail 50'}), 'ask');
});

test('path guard lets ordinary access pass', () => {
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\src\\app.js'}), null);
	assert.strictEqual(pre('Grep', {pattern: 'TODO', glob: '*.ts'}), null);
	assert.strictEqual(pre('Glob', {pattern: '**/*.sql'}), null, 'Glob lists names only');
	assert.strictEqual(pre('Bash', {command: 'npm test'}), null);
	assert.strictEqual(pre('Bash', {command: 'export NODE_ENV=production && git log --oneline'}), null);
	assert.strictEqual(pre('Bash', {command: 'node -e "console.log(process.env.HOME)"'}), null);
});

test('hardened path guard: databases, backups, wildcards, brace globs, keys', () => {
	for(const command of [
		'mysql -u root wp -e "select * from wp_users"',
		'C:\\xampp\\mysql\\bin\\mysqldump.exe -u root wp',
		'wp db query "select user_email from wp_users"',
		'wp user list --fields=user_email',
		'sqlite3 app.db "select * from customers"',
		'psql -c "select 1"',
		'head -c 9999 backup/dump.sql.bak',
		'tail logs/debug.log.1',
		`node -e "console.log(require('fs').readFileSync('backup/dump.sql','utf8'))"`,
		'cat backup/dump.s?l',
		'cat ~/.ssh/id_rsa',
		'cat certs/server.pem',
	]) assert.strictEqual(pre('Bash', {command}), 'ask', command);
	assert.strictEqual(pre('Grep', {pattern: 'x', path: 'C:\\proj', glob: '*.{sql,csv}'}), 'ask');
	assert.strictEqual(pre('Grep', {pattern: 'x', path: 'C:\\proj', type: 'sql'}), 'ask');
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\backup\\dump.sql.bak'}), 'ask');
});

test('hardened path guard leaves look-alike commands alone', () => {
	for(const command of ['npm i mysql2', 'wp plugin list', 'wp cache flush', 'cd C:/xampp/mysql/bin', 'git commit -m "fix: log rotation, csv export"', 'ls src/*', 'rg -t js foo',
		'echo see mysql config for details', `grep -rn 'see mysql config' notes.txt`, 'echo wp user list is useful']) {
		assert.strictEqual(pre('Bash', {command}), null, command);
	}
	assert.strictEqual(pre('PowerShell', {command: '& "C:\\xampp\\mysql\\bin\\mysql.exe" -u root wp'}), 'ask', 'PowerShell call operator');
});

test('database access through containers, dev environments, ssh and global flags asks', () => {
	for(const command of ['docker exec -it db mysql -u root wp', 'docker compose exec -T db pg_dump app', 'docker-compose exec db mysqldump wp', 'kubectl exec -it pg-0 -- psql',
		'ddev mysql', 'ddev wp user list', 'lando wp db export -', 'wp --allow-root user list', 'wp --path=/srv/www option get admin_email', 'sudo -u www-data wp user list',
		`ssh -p 2222 root@prod "mysql -e 'select 1'"`, 'sqlcmd -S . -Q "select 1"', 'mongoexport --db shop', 'pg_dumpall']) {
		assert.strictEqual(pre('Bash', {command}), 'ask', command);
	}
	assert.strictEqual(pre('PowerShell', {command: 'Invoke-Sqlcmd -Query "select 1"'}), 'ask');
	for(const command of ['docker compose up -d', 'docker compose exec app npm test', 'docker exec -it db bash', 'ddev start', 'ddev composer install', 'ssh prod uptime',
		'kubectl exec -it web -- ls /app', 'wp --allow-root plugin list', 'sudo apt install mysql-client']) {
		assert.strictEqual(pre('Bash', {command}), null, command);
	}
});

test('malformed brackets in paths never crash the guard', () => {
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\data.[abc'}), null);
	assert.strictEqual(pre('Bash', {command: 'cat backup/data.[sql'}), null);
	assert.strictEqual(pre('Grep', {pattern: 'x', glob: '*.[sql'}), null);
	assert.strictEqual(pre('Bash', {command: 'cat backup/data.[sql && cat backup/dump.sql'}), 'ask', 'a later target still counts');
});

test('reference, clause, serial and section numbers are no personal data', () => {
	for(const text of [`Bestellnummer ${['02', '123456789'].join('-')} bitte prüfen`, `Ref ${['01', '2345678'].join('-')} im System`, `Build ${['100', '100', '1234'].join('.')} deployed`,
		`DFARS ${['252', '204'].join('.')}-7012`, `ISSN ${['0317', '8471'].join('-')}`, `Bestellnr. ${['0815', '1234'].join('-')}`, `uuid 01234567-${['0012', '4123'].join('-')}-a123-012345678901`,
		`Chrome/${['120', '0', '0', '0'].join('.')} Safari`, `Chrome/${['126', '0', '6478', '127'].join('.')}`, `Req ${['3', '1', '2', '4'].join('.')}`, `Netz ${['46', '0', '0', '0'].join('.')}`]) {
		assert.strictEqual(redactText(text).found.size, 0, text);
	}
	assert.deepStrictEqual([...redactText(`Tel: ${['0815', '1234'].join('-')}`).found], ['PHONE'], 'short number with a phone word');
	assert.strictEqual(redactText(`ISSN ${['0012', '3456'].join('-')}`).found.size, 0, '00 with eight digits');
	assert.strictEqual(redactText(`Hotel ${['0912', '345678'].join('')}`).found.size, 0, 'tel inside a word is no context');
	assert.deepStrictEqual([...redactText(`Diensttelefon ${['0912', '345678'].join('')}`).found], ['PHONE'], 'compound with telefon');
});

test('phone numbers at the end of a sentence are found', () => {
	for(const phone of [PHONE, ['089', '1234567'].join(' '), ['(555)', '234-5678'].join(' '), ['555', '234', '5678'].join('.')]) {
		assert.deepStrictEqual([...redactText(`Rückruf gern unter ${phone}.`).found], ['PHONE'], phone);
	}
});

test('public IPv6 is redacted, local and look-alike notations are not', () => {
	const ip6 = ['2a02', '810d', '4b40', '1e00', '', '1'].join(':');
	assert.strictEqual(redactText(`client ${ip6} GET /`).text, `client ${placeholder('IP')} GET /`);
	assert.deepStrictEqual([...redactText(`[${['2003', 'e1', 'af0f', '5400', '1d2c', '9a4b', 'c3e2', '7f10'].join(':')}]:443`).found], ['IP']);
	const host = ['46', '4', '1', '2'].join('.');
	assert.deepStrictEqual([...redactText(`server ${host} und ::ffff:${host}`).found], ['IP'], 'small trailing octets are still hosts');
	const harmless = ['fe80::1', '::1', ['2606', '4700', '4700', '', '1111'].join(':'), `doc ${['2001', 'db8', '', '1'].join(':')}`, 'MAC 00:1a:2b:3c:4d:5e', 'um 20:15:30', 'std::vector', 'ports "3000:3000"', '2026-10-12T20:15:30'];
	assert.strictEqual(redactText(harmless.join('\n')).found.size, 0);
});

test('path guard follows junctions to their target', () => {
	const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pii-guard-'));
	try {
		fs.mkdirSync(path.join(tmp, 'wp-content', 'uploads'), {recursive: true});
		fs.writeFileSync(path.join(tmp, 'wp-content', 'uploads', 'kunden.txt'), 'x');
		fs.symlinkSync(path.join(tmp, 'wp-content', 'uploads'), path.join(tmp, 'data'), 'junction');
		assert.strictEqual(pre('Read', {file_path: path.join(tmp, 'data', 'kunden.txt')}), 'ask');
	}
	finally {
		fs.rmSync(tmp, {recursive: true, force: true});
	}
});

test('console.log counts as code only when called', () => {
	assert.strictEqual(pre('Bash', {command: 'node -e "console.log(process.env.HOME)"'}), null);
	assert.strictEqual(pre('Bash', {command: 'cat console.log'}), 'ask');
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\console.log'}), 'ask');
});

test('ask reason names the path without quotes', () => {
	const out = run({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'cat "backup/my dump.sql"'}}, ALL_ON);
	assert.match(out.hookSpecificOutput.permissionDecisionReason, /pii-guard: dump\.sql may contain/);
});

test('placeholder guard denies Write and Edit that would write a placeholder back', () => {
	const text = `admin = '${placeholder('EMAIL')}';`;
	assert.strictEqual(pre('Write', {file_path: 'C:\\proj\\config.php', content: text}), 'deny');
	assert.strictEqual(pre('Edit', {file_path: 'C:\\proj\\config.php', old_string: 'a', new_string: text}), 'deny');
	assert.strictEqual(pre('Write', {file_path: 'C:\\proj\\config.php', content: 'admin = null;'}), null);
	assert.strictEqual(pre('Edit', {file_path: 'C:\\proj\\a.js', old_string: text, new_string: 'x'}), null, 'only new text counts');
});

test('placeholder guard denies shell commands that would write a placeholder', () => {
	const ph = placeholder('EMAIL');
	assert.strictEqual(pre('Bash', {command: `sed -i 's/admin = .*/admin = ${ph}/' config.php`}), 'deny');
	assert.strictEqual(pre('PowerShell', {command: `Add-Content notes.txt "${ph}"`}), 'deny');
	assert.strictEqual(pre('Bash', {command: `sed -i 's/a/b/' config.php`}, ALL_ON), null);
	assert.strictEqual(pre('Bash', {command: `echo ${ph} >> x.txt`}, {...ALL_ON, PostToolUse: false}), null, 'follows the redaction switch');
	const agyOut = run({toolCall: {name: 'run_command', args: {CommandLine: `echo ${ph} >> notes.txt`}}}, ALL_ON, 'antigravity');
	assert.strictEqual(agyOut && agyOut.decision, 'deny');
});

test('switches: PreToolUse off keeps the placeholder guard while redaction is on', () => {
	const preOff = {...ALL_ON, PreToolUse: false};
	assert.strictEqual(pre('Read', {file_path: 'C:\\proj\\dump.sql'}, preOff), null);
	assert.strictEqual(pre('Write', {file_path: 'C:\\a.php', content: placeholder('IBAN')}, preOff), 'deny');
	assert.strictEqual(pre('Write', {file_path: 'C:\\a.php', content: placeholder('IBAN')}, {...preOff, PostToolUse: false}), null);
});

test('redaction replaces personal data and keeps the output shape', () => {
	const read = post('Read', {type: 'text', file: {filePath: 'C:\\proj\\notes.txt', content: `Kontakt: ${EMAIL}, Tel. ${PHONE}`, numLines: 1}});
	assert.deepStrictEqual(read, {type: 'text', file: {filePath: 'C:\\proj\\notes.txt', content: `Kontakt: ${placeholder('EMAIL')}, Tel. ${placeholder('PHONE')}`, numLines: 1}});
	const bash = post('Bash', {stdout: `IBAN ${IBAN} from ${IP}`, stderr: '', interrupted: false, isImage: false});
	assert.deepStrictEqual(bash, {stdout: `IBAN ${placeholder('IBAN')} from ${placeholder('IP')}`, stderr: '', interrupted: false, isImage: false});
	assert.match(JSON.stringify(post('Grep', {mode: 'content', content: `a.txt:3:${EMAIL}`})), /\[PII:EMAIL\]/);
	assert.match(JSON.stringify(post('Edit', {filePath: 'a.txt', originalFile: `mail ${EMAIL}`})), /\[PII:EMAIL\]/);
	assert.match(JSON.stringify(post('PowerShell', {stdout: `Tel. ${['089', '1234567'].join(' ')}`, stderr: ''})), /\[PII:PHONE\]/);
});

test('redaction leaves clean output, other tools and switched-off redaction untouched', () => {
	assert.strictEqual(post('Read', {type: 'text', file: {content: 'const x = 1;'}}), null);
	assert.strictEqual(post('Write', {filePath: 'a.txt', content: EMAIL}), null, 'Write output is not sent back as content');
	assert.strictEqual(post('Bash', {stdout: EMAIL}, {...ALL_ON, PostToolUse: false}), null);
});

test('detectors skip values that only look like personal data', () => {
	const harmless = [
		'git@github.com:example/repo.git',
		'img/logo@2x.png',
		'info@example.com',
		'192.168.1.10 10.0.0.1 127.0.0.1 172.20.0.5, DNS 1.1.1.1 und 8.8.8.8',
		'uuid 01234567-0123-4123-a123-012345678901, Artikel 0123456',
		'v2.1.274 and 10.0.19045.1234',
		'color: #0f0f0f; z-index: 1000000',
		'DE12 3456 7890 1234 5678 90',
		'Datum 2026-10-12 und 12.10.2026, Port 8080, Timestamp 1760000000',
		'Termin 01/12/2026 und 03-04-2026',
	].join('\n');
	assert.strictEqual(redactText(harmless).found.size, 0, redactText(harmless).text);
});

test('detectors find national and international phone formats', () => {
	const phones = [['+49 30', ' 12345678'], ['0049 89', ' 1234567'], ['+49 (0) 89', ' 123 456'], ['0151', ' 23456789'], ['089', '/1234567'], ['+49 1520', ' - 123 4567'],
		['(01)', ' 912 3456'], ['(555)', ' 234-5678'], ['555.234', '.5678'], ['+1-555', '-123-4567x89'], ['001-555', '-123-4567x890']];
	for(const phone of phones.map(parts => parts.join(''))) {
		assert.deepStrictEqual([...redactText(`Tel: ${phone}`).found], ['PHONE'], phone);
	}
});

test('bare digit runs need a phone word, separators or a mobile prefix', () => {
	const bare = ['0912', '345678'].join('');
	assert.strictEqual(redactText(`Kundennummer ${bare}`).found.size, 0);
	assert.strictEqual(redactText(`Vorgang ${['0049', '223344'].join('')}`).found.size, 0);
	assert.deepStrictEqual([...redactText(`Telefon ${bare}`).found], ['PHONE']);
	assert.deepStrictEqual([...redactText(`mobil: ${['0151', '23456789'].join('')}`).found], ['PHONE']);
	assert.deepStrictEqual([...redactText(`${['0151', '23456789'].join('')};`).found], ['PHONE'], 'mobile prefix without context');
	assert.deepStrictEqual([...redactText(`Zentrale ${['0211', '38795', '0'].join('-')}`).found], ['PHONE'], 'extension -0');
});

test('long tokens without @ stay linear', () => {
	const start = Date.now();
	redactText('a1'.repeat(100000));
	assert.ok(Date.now() - start < 1000, `${Date.now() - start} ms`);
});

test('long launcher option chains stay fast', () => {
	const start = Date.now();
	pre('Bash', {command: `docker exec ${'-a b '.repeat(2000)}x`});
	assert.ok(Date.now() - start < 500, `${Date.now() - start} ms`);
});

test('hook source and tests contain nothing the detectors would redact', () => {
	for(const file of [SCRIPT, __filename, path.join(__dirname, 'pii-guard.bench.js')]) {
		assert.strictEqual(redactText(fs.readFileSync(file, 'utf8')).found.size, 0, file);
	}
});

test('prompt guard blocks personal data unless the override prefix is set', () => {
	const blocked = prompt(`Ruf an unter ${PHONE}`);
	assert.strictEqual(blocked.decision, 'block');
	assert.strictEqual(blocked.hookSpecificOutput.suppressOriginalPrompt, true);
	assert.match(blocked.reason, /PHONE/);
	assert.strictEqual(prompt(`!pii-ok Ruf an unter ${PHONE}`), null);
	assert.strictEqual(prompt('Schreib einen Test für die Login-Seite'), null);
	assert.strictEqual(prompt(`Mail an ${EMAIL}`, {...ALL_ON, UserPromptSubmit: false}), null);
});

// The CLI runs with the shipped switches: the path guard may be off, the placeholder guard follows redaction (on)
test('CLI prints the decision, fails open and ignores other agents', () => {
	assert.strictEqual(ENABLED.PostToolUse, true, 'CLI tests assume the shipped switches: redaction on');
	const input = JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {file_path: 'C:\\proj\\a.php', content: placeholder('IBAN')}});
	const ok = spawnSync(process.execPath, [SCRIPT, 'claude'], {input, encoding: 'utf8'});
	assert.strictEqual(ok.status, 0);
	assert.strictEqual(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'deny');
	const broken = spawnSync(process.execPath, [SCRIPT, 'claude'], {input: '{not json', encoding: 'utf8'});
	assert.strictEqual(broken.status, 0);
	assert.strictEqual(broken.stdout, '');
	assert.match(broken.stderr, /^pii-guard: /);
	const other = spawnSync(process.execPath, [SCRIPT, 'gemini'], {input, encoding: 'utf8'});
	assert.strictEqual(other.stdout, '');
});

function qwen(input, enabled = ALL_ON) {
	return run(input, enabled, 'qwen');
}

test('Qwen Code: placeholder and path guard work on its tool ids', () => {
	const pre = (tool, toolInput) => {
		const out = qwen({hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput});
		return out && out.hookSpecificOutput.permissionDecision;
	};
	assert.strictEqual(pre('write_file', {file_path: 'a.txt', content: `Mail: ${placeholder('EMAIL')}`}), 'deny');
	assert.strictEqual(pre('edit', {file_path: 'a.txt', old_string: 'x', new_string: placeholder('IBAN')}), 'deny');
	assert.strictEqual(pre('run_shell_command', {command: `echo ${placeholder('IP')} >> hosts`}), 'deny');
	assert.strictEqual(pre('read_file', {file_path: 'C:\\proj\\backup\\dump.sql'}), 'ask');
	assert.match(qwen({hook_event_name: 'PreToolUse', tool_name: 'grep_search', tool_input: {pattern: 'x', path: 'C:\\proj\\.env'}}).hookSpecificOutput.permissionDecisionReason, /Qwen API/);
	assert.strictEqual(pre('read_file', {file_path: 'C:\\proj\\src\\app.js'}), null);
	assert.strictEqual(pre('glob', {pattern: '*.sql'}), null, 'tools without a mapping pass');
});

test('Qwen Code: no redaction, prompt guard only on the round that carries the prompt', () => {
	const post = qwen({hook_event_name: 'PostToolUse', tool_name: 'read_file', tool_input: {}, tool_response: {llmContent: `Mail an ${EMAIL}`, returnDisplay: ''}});
	assert.strictEqual(post, null, 'Qwen ignores updatedToolOutput, so the hook writes none');
	assert.strictEqual(qwen({hook_event_name: 'UserPromptSubmit', prompt: `Mail an ${EMAIL}`, submitted_prompt: `Mail an ${EMAIL}`}).decision, 'block');
	assert.strictEqual(qwen({hook_event_name: 'UserPromptSubmit', prompt: ''}), null, 'model rounds carry an empty prompt');
	// Qwen expands "@" as a file reference before the hook: only submitted_prompt still holds the address
	const typed = `Mail an ${EMAIL}`;
	assert.strictEqual(qwen({hook_event_name: 'UserPromptSubmit', prompt: typed.replace('@', ' @'), submitted_prompt: typed}).decision, 'block');
	assert.strictEqual(qwen({hook_event_name: 'UserPromptSubmit', prompt: `!pii-ok ${typed}`.replace('@', ' @'), submitted_prompt: `!pii-ok ${typed}`}), null);
	const cli = spawnSync(process.execPath, [SCRIPT, 'qwen'], {input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'write_file', tool_input: {content: placeholder('PHONE')}}), encoding: 'utf8'});
	assert.strictEqual(JSON.parse(cli.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

function agy(name, args, enabled = ALL_ON) {
	const out = run({toolCall: {name, args}, stepIdx: 3, conversationId: 'c1'}, enabled, 'antigravity');
	return out && out.decision;
}

test('Antigravity: path guard forces a prompt for view_file, grep_search and run_command', () => {
	assert.strictEqual(agy('view_file', {AbsolutePath: 'C:\\proj\\backup\\dump.sql'}), 'force_ask');
	assert.strictEqual(agy('grep_search', {SearchPath: 'C:\\proj', Query: 'x', Includes: ['*.csv']}), 'force_ask');
	assert.strictEqual(agy('grep_search', {SearchPath: 'C:\\proj\\wp-content\\uploads', Query: 'x'}), 'force_ask');
	assert.strictEqual(agy('run_command', {CommandLine: 'Get-Content .env', Cwd: 'C:\\proj'}), 'force_ask');
});

test('Antigravity: ordinary calls, other tools and the switch pass without output', () => {
	assert.strictEqual(agy('view_file', {AbsolutePath: 'C:\\proj\\src\\app.js'}), null);
	assert.strictEqual(agy('run_command', {CommandLine: 'npm test', Cwd: 'C:\\proj'}), null);
	assert.strictEqual(agy('find_by_name', {SearchDirectory: 'C:\\proj', Pattern: '*.sql'}), null, 'names only');
	assert.strictEqual(agy('view_file', {AbsolutePath: 'C:\\proj\\dump.sql'}, {...ALL_ON, PreToolUse: false}), null);
	// CLI with the shipped switches: the placeholder deny follows redaction, so it answers even with the path guard off
	const input = JSON.stringify({toolCall: {name: 'run_command', args: {CommandLine: `echo ${placeholder('EMAIL')} >> notes.txt`}}});
	const cli = spawnSync(process.execPath, [SCRIPT, 'antigravity'], {input, encoding: 'utf8'});
	assert.strictEqual(cli.status, 0);
	assert.strictEqual(JSON.parse(cli.stdout).decision, 'deny');
});
