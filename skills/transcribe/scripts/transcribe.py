"""Transcribes a local audio or video file via Groq into raw `M:SS <text>` lines.

Contract: SKILL.md §3 (pipeline) and §4 (output format). Standard library only.
Usage: py -3.13 scripts/transcribe.py <source> [-o out.txt] [--lang de]
Exit 0 = transcript written (path on stdout) · 1 = transcription error · 2 = setup incomplete.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
BIN_DIR = SKILL_DIR / "bin"
TMP_DIR = SKILL_DIR / "tmp"
CONFIG_FILE = SKILL_DIR / "config.json"

GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
MAX_UPLOAD_BYTES = 24 * 1024 * 1024     # free tier accepts 25 MB per file
MAX_SOURCE_SECONDS = 8 * 3600           # free tier: 28,800 audio seconds per day
MAX_RETRIES = 5
REQUEST_TIMEOUT = 300
SEGMENT_MIN = 5.0
SEGMENT_MAX = 8.0
CHUNK_SECONDS = 240.0                   # longer uploads make Whisper skip whole 30 s windows (SKILL.md §3.1 step 5)
SILENCE_WINDOW = 30.0                   # a chunk cut moves back to a silence at most this far
GAP_MIN = 3.0                           # a word gap this long is checked for lost speech
GAP_SILENT_SHARE = 0.8                  # a gap at least this silent is a real pause, not lost speech
WORD_MAX = 1.5                          # longer word timings are stretched over lost speech (p99 measured: 1.2 s)
REPAIR_PADS = (1.0, 4.0, 8.0)           # context per repair attempt; the same bytes always give the same miss
SENTENCE_END = (".", "?", "!")
CLAUSE_END = (".", "?", "!", ",", ";", ":")
LINE_PATTERN = re.compile(r"^(\d+:)?\d{1,2}:\d{2} \S.*$")


class SetupError(Exception):
	"""Setup incomplete: missing binary, config or key. Exit 2."""


class TranscribeError(Exception):
	"""Transcription, download or quota error. Exit 1."""


# ==================== Format (SKILL.md §4) ====================

def tx_format_timestamp(seconds):
	total = int(max(0.0, seconds))
	hours, rest = divmod(total, 3600)
	minutes, secs = divmod(rest, 60)
	if(hours):
		return f"{hours}:{minutes:02d}:{secs:02d}"
	return f"{minutes}:{secs:02d}"


def tx_tokens(response, offset):
	"""Timed tokens from a verbose_json response; Groq words carry their punctuation."""
	source = response.get("words") or response.get("segments") or []
	tokens = []
	for item in source:
		# U+FFFD shows up where Whisper emits a broken byte sequence - never real text
		text = (item.get("word") or item.get("text") or "").replace("�", "").strip()
		if(not text):
			continue
		if(tokens and re.fullmatch(r"[^\w]+", text)):
			tokens[-1]["text"] += text          # a bare "." or "," belongs to the word before it
			continue
		tokens.append({"text": text, "start": float(item["start"]) + offset, "end": float(item["end"]) + offset})
	return tokens


def tx_find_cut(tokens):
	"""Index to cut before: a clause end after the 5 s mark, else the longest pause there."""
	start = tokens[0]["start"]
	candidates = range(1, len(tokens))
	window = [i for i in candidates if(tokens[i - 1]["end"] - start >= SEGMENT_MIN)] or list(candidates)
	clauses = [i for i in window if(tokens[i - 1]["text"].endswith(CLAUSE_END))]
	if(clauses):
		return clauses[-1]
	return max(window, key=lambda i: (tokens[i]["start"] - tokens[i - 1]["end"], i))


def tx_normalise(tokens):
	"""Groups timed tokens into segments of 5-8 s, closing at sentence ends where possible."""
	segments = []
	current = []
	for token in tokens:
		while(current and token["end"] - current[0]["start"] > SEGMENT_MAX):
			cut = tx_find_cut(current + [token])
			segments.append(current[:cut])
			current = current[cut:]
		current.append(token)
		if(token["end"] - current[0]["start"] >= SEGMENT_MIN and token["text"].endswith(SENTENCE_END)):
			segments.append(current)
			current = []
	if(current):
		segments.append(current)

	# A segment shorter than 5 s joins its predecessor if the result stays within 8 s
	merged = []
	for segment in segments:
		if(merged):
			previous = merged[-1]
			isShort = segment[-1]["end"] - segment[0]["start"] < SEGMENT_MIN
			if(isShort and segment[-1]["end"] - previous[0]["start"] <= SEGMENT_MAX):
				previous.extend(segment)
				continue
		merged.append(list(segment))
	return [(segment[0]["start"], " ".join(t["text"] for t in segment)) for segment in merged]


def tx_render(segments):
	"""Floors starts to whole seconds, merges same-second segments, returns validated lines."""
	rows = []
	for start, text in segments:
		second = int(max(0.0, start))
		if(rows and second <= rows[-1][0]):
			rows[-1][1] += " "+text
		else:
			rows.append([second, text])
	lines = [f"{tx_format_timestamp(second)} {text}" for second, text in rows]
	for line in lines:
		if(not LINE_PATTERN.match(line)):
			raise TranscribeError(f"format violation (bug): {line[:80]!r}")
	return lines


def tx_flag_repeats(lines, minRun=3):
	"""Warnings for runs of identical consecutive texts - a typical Whisper hallucination."""
	warnings = []
	texts = [line.split(" ", 1)[1] for line in lines]
	i = 0
	while(i < len(texts)):
		j = i
		while(j + 1 < len(texts) and texts[j + 1] == texts[i]):
			j += 1
		if(j - i + 1 >= minRun):
			first = lines[i].split(" ", 1)[0]
			last = lines[j].split(" ", 1)[0]
			warnings.append(f"warning: {j - i + 1} identical lines {first}-{last} (possible hallucination, kept)")
		i = j + 1
	return warnings


# ==================== Audio (ffmpeg, ffprobe) ====================

def tx_binary(name):
	path = BIN_DIR / name
	if(not path.is_file()):
		raise SetupError(f"bin/{name} missing - run scripts/setup.ps1")
	return path


def tx_run(args):
	result = subprocess.run([str(a) for a in args], capture_output=True, text=True, encoding="utf-8", errors="replace")
	if(result.returncode != 0):
		raise TranscribeError(f"{Path(args[0]).name} failed: {result.stderr.strip()[-400:]}")
	return result


def tx_has_audio(source):
	result = tx_run([tx_binary("ffprobe.exe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", source])
	return "audio" in result.stdout


def tx_duration(path):
	result = tx_run([tx_binary("ffprobe.exe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
	return float(result.stdout.strip())


def tx_extract(source, dest):
	tx_run([tx_binary("ffmpeg.exe"), "-y", "-v", "error", "-i", source, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "flac", dest])


def tx_silences(path):
	"""(start, end) of every silence >= 0.4 s - chunk cuts and the pause test for gaps."""
	result = tx_run([tx_binary("ffmpeg.exe"), "-v", "info", "-nostats", "-i", path, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"])
	starts = [max(0.0, float(x)) for x in re.findall(r"silence_start: (-?[\d.]+)", result.stderr)]
	ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", result.stderr)]
	if(len(starts) > len(ends)):
		ends.append(float("inf"))       # silence running to the end of the file
	return list(zip(starts, ends))


def tx_plan_chunks(duration, size, silences):
	"""(start, end) pairs of at most CHUNK_SECONDS and under MAX_UPLOAD_BYTES, cut mid-silence where one is near."""
	chunkSeconds = min(CHUNK_SECONDS, MAX_UPLOAD_BYTES / (size / duration) * 0.95)
	middles = [(a + b) / 2 for a, b in silences if(b != float("inf"))]
	chunks = []
	start = 0.0
	while(duration - start > chunkSeconds):
		target = start + chunkSeconds
		near = [s for s in middles if(max(start, target - SILENCE_WINDOW) < s <= target)]
		cut = near[-1] if(near) else target
		chunks.append((start, cut))
		start = cut
	chunks.append((start, duration))
	return chunks


def tx_silent_seconds(start, end, silences):
	return sum(max(0.0, min(end, b) - max(start, a)) for a, b in silences)


def tx_find_gaps(tokens, duration, silences):
	"""Word gaps > GAP_MIN (including before the first and after the last word) that are not mostly silent.

	Each word counts for at most WORD_MAX: Whisper sometimes stretches one word over skipped speech.
	"""
	edges = [0.0] + [x for t in tokens for x in (t["start"], min(t["end"], t["start"] + WORD_MAX))] + [duration]
	gaps = []
	for i in range(0, len(edges), 2):
		start, end = edges[i], edges[i + 1]
		if(end - start > GAP_MIN and tx_silent_seconds(start, end, silences) < GAP_SILENT_SHARE * (end - start)):
			gaps.append((start, end))
	return gaps


def tx_repair(tokens, duration, silences, request):
	"""Re-requests every speech gap with growing context and splices the recovered words in (SKILL.md §3.1 step 7).

	request(start, end) returns timed tokens for that stretch of audio. Returns (tokens, unrecovered gaps).
	"""
	unrecovered = []
	for gapStart, gapEnd in tx_find_gaps(tokens, duration, silences):
		# Insert at the gap's position in Groq's order - never re-sort: its word starts are not monotonic
		index = next((i for i, t in enumerate(tokens) if(t["start"] >= gapEnd - 0.01)), len(tokens))
		before = tokens[:index]
		after = tokens[index:]
		inside = []
		windows = []
		for pad in REPAIR_PADS:
			window = (max(0.0, gapStart - pad), min(duration, gapEnd + pad))
			if(window in windows):
				continue                    # clamped at a file edge: same bytes, same miss
			windows.append(window)
			found = request(*window)
			inside = [t for t in found if(t["start"] >= gapStart - 0.1 and t["end"] <= gapEnd + 0.1)]
			# The context words may come back re-timed just inside the gap - never add them twice
			while(inside and before and tx_word_key(inside[0]["text"]) == tx_word_key(before[-1]["text"])):
				inside.pop(0)
			while(inside and after and tx_word_key(inside[-1]["text"]) == tx_word_key(after[0]["text"])):
				inside.pop()
			if(inside):
				break
		print(f"repair gap {tx_format_timestamp(gapStart)}-{tx_format_timestamp(gapEnd)}: +{len(inside)} words ({len(windows)} requests)", file=sys.stderr)
		if(inside):
			tokens = before + inside + after
			continue
		stretched = before[-1] if(before and before[-1]["end"] - before[-1]["start"] > WORD_MAX) else None
		if(stretched and stretched["end"] >= gapEnd - 0.5):
			# No speech inside a stretched word: its start was wrong (Whisper pulls a first word over intro music)
			stretched["start"] = stretched["end"] - WORD_MAX
			print(f"re-timed {stretched['text']!r} to {tx_format_timestamp(stretched['start'])}: no speech before it", file=sys.stderr)
		else:
			unrecovered.append((gapStart, gapEnd))
	return tokens, unrecovered


def tx_word_key(text):
	return re.sub(r"[^\w]", "", text).lower()


def tx_cut(path, start, end, dest):
	# Rebuffer to fixed frames: a cut can leave a first block under 16 samples, which the FLAC encoder rejects
	tx_run([tx_binary("ffmpeg.exe"), "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", path, "-af", "asetnsamples=n=4096:p=0", "-c:a", "flac", dest])


# ==================== Groq ====================

def tx_read_key():
	if(not CONFIG_FILE.is_file()):
		raise SetupError("config.json missing - copy config.example.json and enter GROQ_API_KEY")
	try:
		key = json.loads(CONFIG_FILE.read_text(encoding="utf-8")).get("GROQ_API_KEY") or ""
	except ValueError:
		raise SetupError("config.json is not valid JSON")
	if(not key.strip() or key.startswith("<")):
		raise SetupError("GROQ_API_KEY in config.json is empty")
	return key.strip()


def tx_multipart(fields, fileName, fileBytes):
	boundary = uuid.uuid4().hex
	parts = []
	for name, value in fields:
		parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8"))
	parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{fileName}\"\r\nContent-Type: audio/flac\r\n\r\n".encode("utf-8"))
	parts.append(fileBytes)
	parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
	return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def tx_retry_wait(error, attempt):
	header = error.headers.get("retry-after") if(getattr(error, "headers", None)) else None
	try:
		return max(1.0, float(header))
	except (TypeError, ValueError):
		return 5.0 * 2 ** attempt


def tx_error_message(error):
	try:
		return json.loads(error.read()).get("error", {}).get("message", "")
	except Exception:
		return ""


def tx_groq_request(path, key, language, opener=urllib.request.urlopen, sleep=time.sleep):
	fields = [
		("model", GROQ_MODEL),
		("response_format", "verbose_json"),
		("timestamp_granularities[]", "word"),
		("timestamp_granularities[]", "segment"),
		("temperature", "0"),
	]
	if(language):
		fields.append(("language", language))
	body, contentType = tx_multipart(fields, path.name, path.read_bytes())
	headers = {"Authorization": f"Bearer {key}", "Content-Type": contentType, "User-Agent": "transcribe-skill/1.0"}

	for attempt in range(MAX_RETRIES + 1):
		request = urllib.request.Request(GROQ_URL, data=body, headers=headers, method="POST")
		try:
			with opener(request, timeout=REQUEST_TIMEOUT) as response:
				return json.loads(response.read())
		except urllib.error.HTTPError as error:
			if(error.code == 401):
				raise SetupError("Groq rejected the key (HTTP 401) - check GROQ_API_KEY in config.json")
			if(error.code != 429 and error.code < 500):
				raise TranscribeError(f"Groq HTTP {error.code}: {tx_error_message(error)}")
			if(attempt == MAX_RETRIES):
				raise TranscribeError(f"Groq HTTP {error.code} after {MAX_RETRIES} retries: {tx_error_message(error)}")
			wait = tx_retry_wait(error, attempt)
		except urllib.error.URLError as error:
			if(attempt == MAX_RETRIES):
				raise TranscribeError(f"network error after {MAX_RETRIES} retries: {error.reason}")
			wait = 5.0 * 2 ** attempt
		print(f"retry {attempt + 1}/{MAX_RETRIES} in {wait:.0f} s", file=sys.stderr)
		sleep(wait)


# ==================== YouTube (yt-dlp) ====================

def tx_is_url(source):
	return re.match(r"^https?://", source) is not None


def tx_video_id(url):
	match = re.search(r"(?:v=|youtu\.be/|shorts/|live/|embed/)([\w-]{11})", url)
	return match.group(1) if(match) else "video"


def tx_ytdlp(args):
	return tx_run([tx_binary("yt-dlp.exe"), "--no-playlist", "--no-progress", "--encoding", "utf-8", "--ffmpeg-location", BIN_DIR] + args)


def tx_video_info(url):
	try:
		info = json.loads(tx_ytdlp(["--dump-single-json", "--skip-download", url]).stdout)
	except ValueError:
		info = None
	# Unavailable, private or age-restricted videos come back as JSON null
	if(not isinstance(info, dict)):
		raise TranscribeError("yt-dlp returned no video metadata (unavailable, private or age-restricted?)")
	return info


def tx_pick_captions(info, language):
	"""(kind, track) of the caption track in the spoken language, or None.

	Order: human subtitles, then YouTube's original speech recognition (`<lang>-orig`).
	Machine translations of captions are never used.
	"""
	auto = info.get("automatic_captions") or {}
	# Without a language in the metadata, YouTube's recognition of the original audio names it
	origin = next((track[:-5] for track in sorted(auto) if(track.endswith("-orig"))), "")
	lang = language or info.get("language") or origin
	if(not lang):
		return None
	lang = lang.split("-")[0].lower()
	manual = info.get("subtitles") or {}
	for track in sorted(manual):
		if(track == lang or track.lower().startswith(lang+"-")):
			return ("manual", track)
	if(lang+"-orig" in auto):
		return ("auto", lang+"-orig")
	# Without a -orig track, the plain track is original only when it is the video's own language
	if(lang in auto and (info.get("language") or "").lower().startswith(lang)):
		return ("auto", lang)
	return None


def tx_download_captions(url, kind, track, workDir):
	flag = "--write-subs" if(kind == "manual") else "--write-auto-subs"
	tx_ytdlp(["--skip-download", flag, "--sub-langs", track, "--sub-format", "json3", "-o", str(workDir / "subs.%(ext)s"), url])
	files = list(workDir.glob("subs.*.json3"))
	if(not files):
		raise TranscribeError(f"caption track {track} could not be downloaded")
	return json.loads(files[0].read_text(encoding="utf-8"))


def tx_caption_tokens(captions):
	"""Timed tokens from a YouTube json3 caption file.

	Auto captions carry one seg per word with tOffsetMs; human subtitles carry one cue per event.
	"""
	tokens = []
	for event in captions.get("events", []):
		segs = [s for s in event.get("segs", []) if(s.get("utf8", "").strip())]
		if(not segs):
			continue
		start = event["tStartMs"] / 1000
		end = start + event.get("dDurationMs", 0) / 1000
		if(len(segs) > 1 or "tOffsetMs" in segs[0]):
			starts = [start + s.get("tOffsetMs", 0) / 1000 for s in segs]
			for i, seg in enumerate(segs):
				wordEnd = starts[i + 1] if(i + 1 < len(segs)) else end
				tokens.append({"text": seg["utf8"].strip(), "start": starts[i], "end": max(starts[i], wordEnd)})
		else:
			text = " ".join(segs[0]["utf8"].split())
			tokens.append({"text": text, "start": start, "end": end})
	# An event stays on screen while the next one runs - its last word must not end after the next word starts
	for token, following in zip(tokens, tokens[1:]):
		token["end"] = max(token["start"], min(token["end"], following["start"]))
	return tokens


def tx_download_audio(url, workDir):
	# The original track, not one of YouTube's AI-dubbed ones
	result = tx_ytdlp(["-f", "bestaudio[format_note*=original]/bestaudio", "-o", str(workDir / "source.%(ext)s"), "--print", "after_move:filepath", url])
	path = Path(result.stdout.strip().splitlines()[-1]) if(result.stdout.strip()) else None
	if(path is None or not path.is_file()):
		raise TranscribeError("yt-dlp did not produce an audio file")
	return path


# ==================== Pipeline (SKILL.md §3.1) ====================

def tx_audio_tokens(sourcePath, language, workDir):
	"""Steps 3-7: audio -> FLAC -> chunks -> Groq -> repaired timed tokens."""
	key = tx_read_key()
	if(not tx_has_audio(sourcePath)):
		raise TranscribeError(f"no audio stream in {sourcePath.name}")
	flac = workDir / "audio.flac"
	tx_extract(sourcePath, flac)
	duration = tx_duration(flac)
	if(duration > MAX_SOURCE_SECONDS):
		raise TranscribeError(f"{duration / 3600:.1f} h exceeds the free daily quota of 8 h - split the source")
	silences = tx_silences(flac)
	chunks = tx_plan_chunks(duration, flac.stat().st_size, silences)

	def tx_request_range(start, end):
		chunkPath = flac
		if(start > 0.0 or end < duration):
			chunkPath = workDir / f"range-{start:.2f}-{end:.2f}.flac"
			tx_cut(flac, start, end, chunkPath)
		return tx_tokens(tx_groq_request(chunkPath, key, language), start)

	tokens = []
	for index, (start, end) in enumerate(chunks):
		print(f"chunk {index + 1}/{len(chunks)} {tx_format_timestamp(start)}-{tx_format_timestamp(end)}", file=sys.stderr)
		tokens += tx_request_range(start, end)

	tokens, unrecovered = tx_repair(tokens, duration, silences, tx_request_range)
	for gapStart, gapEnd in unrecovered:
		print(f"warning: no words for {tx_format_timestamp(gapStart)}-{tx_format_timestamp(gapEnd)} although the audio is not silent - music, applause or lost speech, check by ear (kept as gap)", file=sys.stderr)
	return tokens


def tx_transcribe(source, output, language, forceGroq=False):
	isUrl = tx_is_url(source)
	if(not isUrl and not Path(source).is_file()):
		raise TranscribeError(f"source not found: {source}")
	tx_binary("ffmpeg.exe")
	tx_binary("ffprobe.exe")

	workDir = TMP_DIR / uuid.uuid4().hex[:12]
	workDir.mkdir(parents=True)
	try:
		if(isUrl):
			info = tx_video_info(source)
			track = None if(forceGroq) else tx_pick_captions(info, language)
			if(track):
				print(f"captions {track[0]} {track[1]} (no upload)", file=sys.stderr)
				tokens = tx_caption_tokens(tx_download_captions(source, track[0], track[1], workDir))
			else:
				print("no original captions - transcribing the audio via Groq" if(not forceGroq) else "audio via Groq (--groq)", file=sys.stderr)
				tokens = tx_audio_tokens(tx_download_audio(source, workDir), language, workDir)
		else:
			tokens = tx_audio_tokens(Path(source), language, workDir)

		lines = tx_render(tx_normalise(tokens))
		if(not lines):
			raise TranscribeError("no speech recognised")
		for warning in tx_flag_repeats(lines):
			print(warning, file=sys.stderr)
		output.write_text("\n".join(lines)+"\n", encoding="utf-8", newline="\n")
	finally:
		shutil.rmtree(workDir, ignore_errors=True)


def tx_default_output(source):
	name = tx_video_id(source) if(tx_is_url(source)) else Path(source).stem
	return TMP_DIR / f"{name}.transcript.txt"


def main(argv=None):
	parser = argparse.ArgumentParser(description="Transcribe a local audio/video file or a YouTube URL into M:SS lines.")
	parser.add_argument("source", help="local audio or video file, or a YouTube URL")
	parser.add_argument("-o", "--output", help="output .txt (default: tmp/<source stem or video id>.transcript.txt in the skill folder)")
	parser.add_argument("--lang", help="spoken language, e.g. de or en (default: auto-detect)")
	parser.add_argument("--groq", action="store_true", help="URL only: ignore captions and transcribe the audio via Groq")
	args = parser.parse_args(argv)

	output = Path(args.output) if(args.output) else tx_default_output(args.source)
	try:
		tx_transcribe(args.source, output, args.lang, args.groq)
	except SetupError as error:
		print(f"setup: {error}", file=sys.stderr)
		return 2
	except TranscribeError as error:
		print(f"error: {error}", file=sys.stderr)
		return 1
	print(output)
	return 0


if(__name__ == "__main__"):
	sys.exit(main())
