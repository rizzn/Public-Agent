/*
 File Name:     pii-guard.bench.js
 Description:   Benchmark for pii-guard.js: generates a seeded synthetic dataset (SQL dump, CSV export, logs, mails) with
                labelled personal data in German and international formats, writes it to a temp folder, runs the detectors
                and reports recall, precision, false alarms, throughput and how many bypass attempts the path guard catches.
                Also scans this repository as real-world negatives (git-tracked files up to 2 MB) and prints only counts
                and file:line, never a matched value.
                Names and postal addresses are labelled on purpose: the guard does not cover them, the report shows the gap.
 Author:        Stephan Riedl
 Author URI:    https://stph.so/

 Usage:
   node hooks/tests/pii-guard.bench.js            # seed 42, temp dataset deleted afterwards
   node hooks/tests/pii-guard.bench.js --keep     # keep the dataset folder and print its path
   node hooks/tests/pii-guard.bench.js --seed 7
   node hooks/tests/pii-guard.bench.js --scan <dir>   # real-world negatives from another folder instead of this repository
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {redactText, run} = require('../pii-guard.js');

// ==================== CONFIGURATION ====================

const SCRIPT = path.join(__dirname, '..', 'pii-guard.js');
const REPO = path.join(__dirname, '..', '..');
const RECORDS = 2000;
const THROUGHPUT_MB = [1, 10, 50];
const SCAN_EXT = ['.js', '.ps1', '.md', '.json', '.php', '.ts', '.vue', '.html', '.twig', '.yml', '.yaml'];
const SCAN_SKIP = ['node_modules', 'vendor', '.git', 'target', 'dist', 'bin', 'tmp', 'uploads', 'cache'];
const SCAN_MAX_BYTES = 2 * 1048576;

const args = process.argv.slice(2);
const SEED = args.includes('--seed') ? Number(args[args.indexOf('--seed') + 1]) : 42;
const KEEP = args.includes('--keep');
const SCAN_DIR = args.includes('--scan') ? path.resolve(args[args.indexOf('--scan') + 1]) : REPO;

const FIRST = ['Anna', 'Lukas', 'Sophie', 'Maximilian', 'Marie', 'Jonas', 'Lea', 'Felix', 'Hannah', 'Paul', 'Jürgen', 'Özlem'];
const LAST = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Schäfer', 'Yılmaz', 'Nowak'];
const STREETS = ['Hauptstraße', 'Lindwurmstraße', 'Bahnhofstr.', 'Am Anger', 'Goethestraße', 'Schillerplatz'];
const CITIES = [['80337', 'München'], ['10115', 'Berlin'], ['20095', 'Hamburg'], ['50667', 'Köln'], ['70173', 'Stuttgart'], ['1010', 'Wien']];
const DOMAINS = ['web.de', 'gmx.de', 't-online.de', 'gmail.com', 'outlook.com', 'kunde-gmbh.de', 'mail.beispielfirma.com', 'posteo.at'];
const AREAS = ['30', '89', '40', '221', '69', '711', '911', '8031'];
const MOBILE = ['151', '160', '170', '176', '1520'];

// Shell commands that try to get a data file or database past the path guard; the last three cannot be decided statically
const BYPASS = [
	['glob *.sql', 'cat *.sql'],
	['variable', 'f=backup/dump.sql; cat $f'],
	['substitution', 'cat $(ls backup/*.sql | head -1)'],
	['git show', 'git show HEAD:backup/dump.sql'],
	['python open', `python -c "print(open('backup/dump.sql').read())"`],
	['node readFileSync', `node -e "console.log(require('fs').readFileSync('backup/dump.sql','utf8'))"`],
	['cmd type', 'cmd /c type backup\\dump.sql'],
	['upper case', 'cat backup/DUMP.SQL'],
	['quote split', "cat backup/dum''p.sql"],
	['find -exec', 'find . -name "*.sql" -exec cat {} \\;'],
	['zcat', 'zcat backup/dump.sql.gz'],
	['PowerShell gc', 'gc backup\\dump.sql'],
	['Import-Csv', 'Import-Csv export\\kunden.csv'],
	['Select-String', 'Select-String -Path logs\\*.log -Pattern Fehler'],
	['backup suffix', 'head -c 9999 backup/dump.sql.bak'],
	['log rotation', 'tail logs/debug.log.1'],
	['wildcard ext', 'cat backup/dump.s?l'],
	['mysql', 'mysql -u root wp -e "select * from wp_users"'],
	['mysqldump', 'mysqldump -u root wp wp_users'],
	['wp db query', 'wp db query "select user_email from wp_users"'],
	['wp user list', 'wp user list --fields=user_email,display_name'],
	['sqlite3', 'sqlite3 app.db "select * from customers"'],
	['psql', 'psql -c "select * from customers"'],
	['docker exec', 'docker exec -it db mysql -u root wp'],
	['compose exec', 'docker compose exec -T db pg_dump app'],
	['kubectl exec', 'kubectl exec -it pg-0 -- psql'],
	['ddev mysql', 'ddev mysql'],
	['ddev wp', 'ddev wp user list'],
	['wp global flag', 'wp --allow-root user list'],
	['sudo -u wp', 'sudo -u www-data wp user list'],
	['ssh mysql', 'ssh root@prod "mysql -e \'select * from wp_users\'"'],
	['sqlcmd', 'sqlcmd -S . -Q "select * from Customers"'],
	['Invoke-Sqlcmd', 'Invoke-Sqlcmd -Query "select * from Customers"'],
	['mongoexport', 'mongoexport --db shop --collection users'],
	['ssh key', 'cat ~/.ssh/id_rsa'],
	['pem', 'cat certs/server.pem'],
	['folder glob', 'cat backup/*'],
	['base64 path', 'cat "$(echo YmFja3VwL2R1bXAuc3Fs | base64 -d)"'],
	['env var path', 'cat $DUMP_FILE'],
];

const HARMLESS = ['npm test', 'git log --oneline -20', 'ls src/*', 'cp *.js dist/', 'node -e "const a=1, b=2; console.log(a,b)"', 'export NODE_ENV=production',
	'cat README.md', 'npm i mysql2', 'docker compose up -d', 'composer install', 'wp plugin list', 'wp cache flush', 'rg -t js foo', 'git diff --stat',
	'Get-ChildItem -Recurse -Filter *.php', 'git commit -m "fix: log rotation, csv export"', 'grep -rn TODO src/', 'cd C:/xampp/mysql/bin', 'cat package.json',
	'docker compose exec app npm test', 'docker exec -it db bash', 'ddev start', 'ddev composer install', 'ssh prod uptime', 'kubectl exec -it web -- ls /app',
	'wp --allow-root plugin list', 'sudo apt install mysql-client'];

// ==================== GENERATOR ====================

// mulberry32: small seeded PRNG so every run sees the same dataset
function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rnd = prng(SEED);
const pick = list => list[Math.floor(rnd() * list.length)];
const digits = n => Array.from({length: n}, () => Math.floor(rnd() * 10)).join('');
const ascii = s => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/ı/g, 'i');

function email(first, last) {
	const d = pick(DOMAINS);
	const f = ascii(first);
	const l = ascii(last);
	const at = '@';
	return pick([
		() => `${f}.${l}${at}${d}`,
		() => `${f[0]}.${l}${at}${d}`,
		() => `${f}${digits(2)}${at}${d}`,
		() => `${l}+shop${at}${d}`,
		() => `${first[0].toUpperCase()}.${ascii(last).toUpperCase()}${at}${d.toUpperCase()}`,
		() => `info${at}${l}-bau.de`,
	])();
}

function phone() {
	const area = pick(AREAS);
	const mob = pick(MOBILE);
	const num = digits(7);
	const plus = '+';
	return pick([
		() => `${plus}49 ${area} ${num}`,
		() => `${plus}49 (0)${area} ${num}`,
		() => `0${area} ${num}`,
		() => `0${area}/${num}`,
		() => `0${area}-${num}`,
		() => `(0${area}) ${num}`,
		() => `${plus}49${area}${num}`,
		() => `0049 ${area} ${num}`,
		() => `${plus}43 1 ${num}`,
		() => `${plus}41 44 ${num}`,
		() => `0${mob} ${digits(8)}`,
		() => `${plus}49 ${mob} ${digits(3)} ${digits(2)} ${digits(3)}`,
		() => `0${mob}${digits(8)}`,
		() => `0${area}${num}`,
		() => `0${area}-${digits(5)}-${digits(1)}`,
	])();
}

function mod97(numeric) {
	let m = 0;
	for(const d of numeric) m = (m * 10 + Number(d)) % 97;
	return m;
}

// Valid check digits for DE (8+10), AT (5+11) and CH (5+12 numeric)
function iban() {
	const [cc, code, bban] = pick([['DE', '1314', digits(18)], ['AT', '1029', digits(16)], ['CH', '1217', digits(17)]]);
	const check = String(98 - mod97(bban + code + '00')).padStart(2, '0');
	const compact = cc + check + bban;
	return rnd() < 0.6 ? compact.replace(/(.{4})/g, '$1 ').trim() : compact;
}

function publicIp() {
	for(;;) {
		const a = 1 + Math.floor(rnd() * 222);
		const b = Math.floor(rnd() * 256);
		if([10, 127].includes(a) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) continue;
		return [a, b, Math.floor(rnd() * 256), 1 + Math.floor(rnd() * 254)].join('.');
	}
}

// Global unicast as German providers hand it out, compressed or in full
function publicIp6() {
	const hex = () => Math.floor(rnd() * 65536).toString(16);
	const prefix = pick(['2a02', '2003', '2a01', '2001']);
	const groups = [prefix, (0x1000 + Math.floor(rnd() * 0xe000)).toString(16), hex(), hex()];
	return rnd() < 0.5 ? `${groups.join(':')}::${hex()}` : [...groups, hex(), hex(), hex(), hex()].join(':');
}

function person() {
	const first = pick(FIRST);
	const last = pick(LAST);
	const [zip, city] = pick(CITIES);
	return {
		NAME: `${first} ${last}`,
		ADDRESS: `${pick(STREETS)} ${1 + Math.floor(rnd() * 120)}, ${zip} ${city}`,
		EMAIL: email(first, last),
		PHONE: phone(),
		IBAN: iban(),
		IP: publicIp(),
		IP6: publicIp6(),
		first,
		last,
	};
}

// Each container returns {name, text, labels[]}; a label is {type, value}
function sqlDump(people) {
	const lines = ['-- MySQL dump 10.13  Distrib 8.0.36', 'SET NAMES utf8mb4;'];
	const labels = [];
	people.forEach((p, i) => {
		lines.push(`INSERT INTO \`wp_users\` VALUES (${i + 1},'${ascii(p.first)}${i}','$P$B${digits(6)}','${ascii(p.last)}','${p.EMAIL}','','2025-0${1 + (i % 9)}-1${i % 10} 10:00:00','',0,'${p.NAME}');`);
		lines.push(`INSERT INTO \`wp_wc_order_addresses\` VALUES (${i + 1},${5000 + i},'billing','${p.first}','${p.last}','','${p.ADDRESS}','','','DE','${p.EMAIL}','${p.PHONE}');`);
		lines.push(`INSERT INTO \`wp_usermeta\` VALUES (${9000 + i},${i + 1},'sepa_iban','${p.IBAN}');`);
		labels.push({type: 'EMAIL', value: p.EMAIL}, {type: 'EMAIL', value: p.EMAIL}, {type: 'NAME', value: p.NAME}, {type: 'ADDRESS', value: p.ADDRESS}, {type: 'PHONE', value: p.PHONE}, {type: 'IBAN', value: p.IBAN});
	});
	return {name: 'dump.sql', text: lines.join('\n'), labels};
}

function csvExport(people) {
	const lines = ['id;name;email;telefon;iban;adresse'];
	const labels = [];
	people.forEach((p, i) => {
		lines.push([i + 1, p.NAME, p.EMAIL, p.PHONE, p.IBAN, `"${p.ADDRESS}"`].join(';'));
		labels.push({type: 'NAME', value: p.NAME}, {type: 'EMAIL', value: p.EMAIL}, {type: 'PHONE', value: p.PHONE}, {type: 'IBAN', value: p.IBAN}, {type: 'ADDRESS', value: p.ADDRESS});
	});
	return {name: 'export.csv', text: lines.join('\n'), labels};
}

function logs(people) {
	const lines = [];
	const labels = [];
	people.forEach((p, i) => {
		// Every third visitor comes over IPv6, the user agent carries a frozen Chrome version like an IPv4
		const ip = i % 3 ? p.IP : p.IP6;
		lines.push(`${ip} - - [12/Oct/2026:10:${String(i % 60).padStart(2, '0')}:00 +0200] "POST /checkout HTTP/1.1" 200 ${300 + i} "-" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/${120 + (i % 20)}.0.0.0 Safari/537.36"`);
		lines.push(`[2026-10-12 10:00:${String(i % 60).padStart(2, '0')}] production.INFO: order ${5000 + i} placed by ${p.EMAIL} from ${ip}`);
		labels.push({type: 'IP', value: ip}, {type: 'EMAIL', value: p.EMAIL}, {type: 'IP', value: ip});
	});
	return {name: 'access.log', text: lines.join('\n'), labels};
}

function mails(people) {
	const blocks = [];
	const labels = [];
	people.forEach((p, i) => {
		blocks.push([
			`Betreff: Rückfrage zu Bestellung ${5000 + i}`,
			`Hallo ${p.first},`,
			// Half of the numbers end the sentence, the full stop must not hide them
			i % 2 ? `bitte überweise den Betrag auf ${p.IBAN} und ruf mich unter ${p.PHONE} zurück.` : `bitte überweise den Betrag auf ${p.IBAN}. Rückruf gern unter ${p.PHONE}.`,
			`Die Lieferung geht an ${p.NAME}, ${p.ADDRESS}. Rechnung per Mail an ${p.EMAIL}.`,
			'',
		].join('\n'));
		labels.push({type: 'IBAN', value: p.IBAN}, {type: 'PHONE', value: p.PHONE}, {type: 'NAME', value: p.NAME}, {type: 'ADDRESS', value: p.ADDRESS}, {type: 'EMAIL', value: p.EMAIL});
	});
	return {name: 'mails.txt', text: blocks.join('\n'), labels};
}

// Values that look like personal data but are not, built at runtime to keep this file free of matches
function lookalikes() {
	const lines = [];
	for(let i = 0; i < RECORDS; i++) {
		lines.push(pick([
			() => `"version": "${1 + (i % 9)}.${i % 20}.${i % 300}"`,
			() => `server 192.168.${i % 255}.${1 + (i % 250)} and 10.0.${i % 255}.1, gateway 172.${16 + (i % 16)}.0.1`,
			() => `commit ${digits(7)}a${digits(4)}f ${'Merge'} pull request #${100 + i}`,
			() => `color: #${digits(6)}; margin: 0 ${i % 40}px;`,
			() => `Preis ${1 + (i % 9)}.${digits(3)},${digits(2)} € inkl. MwSt.`,
			() => `Termin ${String(1 + (i % 9)).padStart(2, '0')}/${String(1 + (i % 12)).padStart(2, '0')}/2026 und ${String(1 + (i % 9)).padStart(2, '0')}-0${1 + (i % 9)}-2026`,
			() => `Datum ${String(1 + (i % 28)).padStart(2, '0')}.${String(1 + (i % 12)).padStart(2, '0')}.2026, Uhrzeit 0${i % 10}:${String(i % 60).padStart(2, '0')}`,
			() => `uuid ${digits(8)}-${digits(4)}-4${digits(3)}-a${digits(3)}-${digits(12)}`,
			() => `Bestellnr. ${['0815', digits(4)].join('-')}`,
			() => `Kundennummer ${['0', 1 + (i % 9), digits(8)].join('')}`,
			() => `Vorgang ${['00', 1 + (i % 9), digits(7)].join('')}`,
			() => `Artikel ${['0', digits(6)].join('')} Lager ${digits(3)}`,
			() => `remote ${['git', 'github.com'].join('@')}:org/repo-${i}.git`,
			() => `asset img/hero-${i}${['', '2x.webp'].join('@')}`,
			() => `timestamp ${1700000000 + i * 997}, port ${3000 + (i % 5000)}`,
			() => `DFARS ${[252, 204].join('.')}-${7000 + (i % 100)}, FAR ${[52, 204].join('.')}-${21 + (i % 9)}`,
			() => `ISSN ${['0', digits(3)].join('')}-${digits(4)}`,
			() => `Abschnitt ${1 + (i % 9)}.${1 + (i % 9)}.${1 + (i % 5)}.${1 + (i % 4)} der Anforderung`,
			() => `"Mozilla/5.0 (X11; Linux x86_64) Chrome/${100 + (i % 40)}.0.0.0 Safari/537.36"`,
			() => `um ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00, MAC 00:1a:2b:${(i % 256).toString(16)}:4d:5e, std::vector, ports "${3000 + i}:${3000 + i}", fe80::${i.toString(16)}`,
		])());
	}
	return {name: 'lookalikes.txt', text: lines.join('\n'), labels: []};
}

// ==================== EVALUATION ====================

// A label counts as found when a match of the same type overlaps it
function score(doc) {
	const {matches} = redactText(doc.text);
	const used = new Set();
	const rows = {};
	const row = type => (rows[type] = rows[type] || {labels: 0, tp: 0, fp: 0});
	for(const label of doc.labels) {
		const r = row(label.type);
		r.labels++;
		const idx = matches.findIndex((m, k) => !used.has(k) && m.type === label.type && (m.value.includes(label.value) || label.value.includes(m.value)));
		if(idx >= 0) {
			used.add(idx);
			r.tp++;
		}
	}
	matches.forEach((m, k) => {
		if(!used.has(k)) row(m.type).fp++;
	});
	return rows;
}

function merge(total, rows) {
	for(const [type, r] of Object.entries(rows)) {
		const t = total[type] = total[type] || {labels: 0, tp: 0, fp: 0};
		t.labels += r.labels;
		t.tp += r.tp;
		t.fp += r.fp;
	}
	return total;
}

const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + ' %' : '-');

function printTable(total) {
	console.log('Type      Labels     Hits    Missed  False alarm  Recall    Precision');
	for(const type of ['EMAIL', 'PHONE', 'IBAN', 'IP', 'NAME', 'ADDRESS']) {
		const r = total[type] || {labels: 0, tp: 0, fp: 0};
		console.log([type.padEnd(8), String(r.labels).padStart(7), String(r.tp).padStart(8), String(r.labels - r.tp).padStart(9), String(r.fp).padStart(10), pct(r.tp, r.labels).padStart(8), pct(r.tp, r.tp + r.fp).padStart(11)].join('  '));
	}
}

// Versioned files only when the folder is a git repo: untracked client output can run to gigabytes
function scanFiles(dir) {
	const git = spawnSync('git', ['ls-files', '-z', '--', ...SCAN_EXT.map(e => `*${e}`)], {cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1048576});
	const files = git.status === 0 ? git.stdout.split('\0').filter(Boolean).map(f => path.join(dir, f)) : walk(dir);
	return files.filter(f => fs.existsSync(f) && fs.statSync(f).size <= SCAN_MAX_BYTES);
}

function walk(dir, out = []) {
	for(const entry of fs.readdirSync(dir, {withFileTypes: true})) {
		if(SCAN_SKIP.includes(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if(entry.isDirectory()) walk(full, out);
		else if(SCAN_EXT.includes(path.extname(entry.name))) out.push(full);
	}
	return out;
}

function ms(start) {
	return Number(process.hrtime.bigint() - start) / 1e6;
}

// ==================== MAIN EXECUTION ====================

const people = Array.from({length: RECORDS}, person);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-guard-bench-'));

try {
	const docs = [sqlDump(people), csvExport(people), logs(people), mails(people), lookalikes()];
	for(const doc of docs) fs.writeFileSync(path.join(dataDir, doc.name), doc.text);

	console.log(`pii-guard benchmark · seed ${SEED} · ${RECORDS} people · dataset ${KEEP ? dataDir : '(temp, deleted afterwards)'}\n`);

	// Recall and precision on the labelled files, read back from disk as the hook would see them
	const total = {};
	for(const doc of docs.slice(0, 4)) merge(total, score({...doc, text: fs.readFileSync(path.join(dataDir, doc.name), 'utf8')}));
	console.log('1) Labelled data (dump.sql, export.csv, access.log, mails.txt)');
	printTable(total);

	// Phone formats one by one, with and without a phone word before them, to show which shapes slip through
	console.log('\n2) Phone formats one by one       with "Tel:"   no context');
	const formats = {};
	for(let i = 0; i < 700; i++) {
		const value = phone();
		const key = value.replace(/\d+/g, '9…');
		const f = formats[key] = formats[key] || {n: 0, ctx: 0, bare: 0};
		f.n++;
		if(redactText(`Tel: ${value}`).found.has('PHONE')) f.ctx++;
		if(redactText(`; ${value};`).found.has('PHONE')) f.bare++;
	}
	for(const [shape, f] of Object.entries(formats).sort((a, b) => a[1].bare / a[1].n - b[1].bare / b[1].n)) {
		console.log(`   ${shape.padEnd(28)} ${pct(f.ctx, f.n).padStart(8)}  ${pct(f.bare, f.n).padStart(11)}  (${f.n})`);
	}

	// False alarms on lookalikes: every match is wrong here
	const look = docs[4];
	const lookMatches = redactText(look.text).matches;
	const lookLines = look.text.split('\n').length;
	const lookByType = lookMatches.reduce((acc, m) => ({...acc, [m.type]: (acc[m.type] || 0) + 1}), {});
	console.log(`\n3) Lookalikes (${lookLines} lines, none of them personal data)`);
	console.log(`   False alarms: ${lookMatches.length} = ${(1000 * lookMatches.length / lookLines).toFixed(1)} per 1,000 lines  ${JSON.stringify(lookByType)}`);

	// Real files of the scanned folder: matches are either real data or false alarms, review by file:line
	const files = scanFiles(SCAN_DIR);
	let lines = 0;
	let bytes = 0;
	const hits = [];
	for(const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		lines += text.split('\n').length;
		bytes += Buffer.byteLength(text);
		text.split('\n').forEach((line, i) => {
			for(const m of redactText(line).matches) hits.push({file: path.relative(SCAN_DIR, file), line: i + 1, type: m.type});
		});
	}
	const hitTypes = hits.reduce((acc, h) => ({...acc, [h.type]: (acc[h.type] || 0) + 1}), {});
	console.log(`\n4) Real files under ${SCAN_DIR} (${files.length} files, ${(bytes / 1048576).toFixed(1)} MB, ${lines} lines) — values are never printed`);
	console.log(`   Hits: ${hits.length} = ${(1000 * hits.length / lines).toFixed(2)} per 1,000 lines  ${JSON.stringify(hitTypes)}`);
	for(const h of hits.slice(0, 15)) console.log(`   ${h.type.padEnd(6)} ${h.file}:${h.line}`);
	if(hits.length > 15) console.log(`   … ${hits.length - 15} more`);

	// Throughput of the detectors on mixed content
	console.log('\n5) Detection throughput');
	const mixed = docs.map(d => d.text).join('\n');
	for(const mb of THROUGHPUT_MB) {
		const text = mixed.repeat(Math.ceil(mb * 1048576 / mixed.length)).slice(0, mb * 1048576);
		const start = process.hrtime.bigint();
		redactText(text);
		const t = ms(start);
		console.log(`   ${String(mb).padStart(3)} MB: ${t.toFixed(0).padStart(6)} ms = ${(t / mb).toFixed(0)} ms/MB`);
	}
	// Worst case: one long token without "@" (hash, base64, minified bundle)
	const token = 'a1'.repeat(524288);
	const tokenStart = process.hrtime.bigint();
	redactText(token);
	console.log(`     1 MB one token without @: ${ms(tokenStart).toFixed(0)} ms`);

	// End to end: a full hook call with a 2,000-line Read, as Claude Code would run it
	const readText = mixed.split('\n').slice(0, 2000).map((l, i) => `${i + 1}\t${l}`).join('\n');
	const payload = JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {type: 'text', file: {content: readText}}});
	const runs = [];
	for(let i = 0; i < 7; i++) {
		const start = process.hrtime.bigint();
		spawnSync(process.execPath, [SCRIPT, 'claude'], {input: payload, encoding: 'utf8'});
		runs.push(ms(start));
	}
	runs.sort((a, b) => a - b);
	console.log(`\n6) Full hook call (PostToolUse, Read of 2,000 lines, ${(Buffer.byteLength(readText) / 1024).toFixed(0)} KB): median ${runs[3].toFixed(0)} ms, min ${runs[0].toFixed(0)} ms, max ${runs[6].toFixed(0)} ms`);

	// Bypass attempts against the path guard, and harmless commands that must pass
	const on = {PreToolUse: true, PostToolUse: true, UserPromptSubmit: true};
	const asks = command => Boolean(run({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command}}, on));
	const caught = BYPASS.filter(([, command]) => asks(command));
	const missed = BYPASS.filter(([, command]) => !asks(command)).map(([name]) => name);
	const falseAsks = HARMLESS.filter(asks);
	console.log(`\n7) Bypass attempts against the path guard: ${caught.length}/${BYPASS.length} caught${missed.length ? ` · open: ${missed.join(', ')}` : ''}`);
	console.log(`   Harmless commands that ask: ${falseAsks.length}/${HARMLESS.length}${falseAsks.length ? ` (${falseAsks.join(' | ')})` : ''}`);
}
finally {
	if(!KEEP) fs.rmSync(dataDir, {recursive: true, force: true});
}
