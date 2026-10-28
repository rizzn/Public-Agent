"""Unit tests for scripts/transcribe.py - no network, no binaries, no key.

Run: py -3.13 -m unittest discover -s skills/transcribe/tests
"""

import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "transcribe.py"
spec = importlib.util.spec_from_file_location("transcribe", SCRIPT)
tx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tx)


def tx_words(spec):
	"""Synthetic tokens from (text, start, end) tuples."""
	return [{"text": text, "start": start, "end": end} for text, start, end in spec]


def tx_speech(seconds, wordLength=0.4, sentenceEvery=12, pauseEvery=0):
	"""Evenly spaced words; every n-th word ends a sentence, optional pauses."""
	tokens = []
	t = 0.0
	i = 0
	while(t < seconds):
		i += 1
		text = f"w{i}." if(i % sentenceEvery == 0) else f"w{i}"
		tokens.append({"text": text, "start": t, "end": t + wordLength})
		t += wordLength
		if(pauseEvery and i % pauseEvery == 0):
			t += 1.0
	return tokens


class TimestampTest(unittest.TestCase):

	def test_minutes_and_hours(self):
		cases = {0: "0:00", 5: "0:05", 5.99: "0:05", 59.999: "0:59", 754: "12:34", 3599: "59:59", 3600: "1:00:00", 3725.7: "1:02:05", 36000: "10:00:00"}
		for seconds, expected in cases.items():
			self.assertEqual(tx.tx_format_timestamp(seconds), expected, seconds)

	def test_negative_clamps_to_zero(self):
		self.assertEqual(tx.tx_format_timestamp(-0.2), "0:00")


class TokensTest(unittest.TestCase):

	def test_words_with_offset(self):
		response = {"words": [{"word": " Hello,", "start": 0.1, "end": 0.5}, {"word": "world.", "start": 0.5, "end": 0.9}], "segments": [{"text": "ignored", "start": 0, "end": 1}]}
		tokens = tx.tx_tokens(response, 600.0)
		self.assertEqual([t["text"] for t in tokens], ["Hello,", "world."])
		self.assertAlmostEqual(tokens[0]["start"], 600.1)

	def test_bare_punctuation_joins_previous_word(self):
		response = {"words": [{"word": "end", "start": 1, "end": 1.4}, {"word": ".", "start": 1.4, "end": 7.1}, {"word": "Next", "start": 7.2, "end": 7.5}]}
		tokens = tx.tx_tokens(response, 0)
		self.assertEqual([t["text"] for t in tokens], ["end.", "Next"])
		self.assertEqual(tokens[0]["end"], 1.4)

	def test_replacement_character_is_dropped(self):
		response = {"words": [{"word": "�", "start": 0, "end": 0.5}, {"word": "again.", "start": 1, "end": 1.4}, {"word": "�", "start": 1.5, "end": 2}, {"word": "101", "start": 2, "end": 2.4}]}
		self.assertEqual([t["text"] for t in tx.tx_tokens(response, 0)], ["again.", "101"])

	def test_segments_fallback_and_empty_text(self):
		response = {"segments": [{"text": " A line.", "start": 1, "end": 3}, {"text": "  ", "start": 3, "end": 4}]}
		self.assertEqual(tx.tx_tokens(response, 0), [{"text": "A line.", "start": 1.0, "end": 3.0}])


class NormaliseTest(unittest.TestCase):

	def assertSpans(self, segments, tokens):
		ends = {t["start"]: t["end"] for t in tokens}
		starts = [s for s, _ in segments]
		self.assertEqual(starts, sorted(starts))
		for index, (start, text) in enumerate(segments):
			self.assertTrue(text)
		self.assertEqual(" ".join(text for _, text in segments), " ".join(t["text"] for t in tokens))

	def test_no_segment_exceeds_eight_seconds(self):
		for sentenceEvery in (5, 12, 40, 1000):
			tokens = tx_speech(300, sentenceEvery=sentenceEvery, pauseEvery=7)
			segments = tx.tx_normalise(tokens)
			self.assertSpans(segments, tokens)
			spans = self.spans(tokens, segments)
			self.assertLessEqual(max(spans), tx.SEGMENT_MAX + 1e-9, sentenceEvery)

	def test_most_segments_in_target_window(self):
		tokens = tx_speech(600, sentenceEvery=15, pauseEvery=9)
		spans = self.spans(tokens, tx.tx_normalise(tokens))
		inWindow = sum(1 for s in spans if(tx.SEGMENT_MIN - 1 <= s <= tx.SEGMENT_MAX))
		self.assertGreaterEqual(inWindow / len(spans), 0.9)

	def test_sentence_end_after_five_seconds_closes(self):
		# "Next more" (3.5 s) stays separate: merging would span 9.5 s > 8 s
		tokens = tx_words([("One", 0, 2), ("two", 2, 4), ("three.", 4, 5.5), ("Next", 6, 7), ("more", 7, 9.5)])
		self.assertEqual(tx.tx_normalise(tokens), [(0, "One two three."), (6, "Next more")])

	def test_cut_prefers_clause_end_then_pause(self):
		clause = tx_words([("a", 0, 2), ("b,", 2, 5.2), ("c", 5.3, 6), ("d", 6.1, 7.9), ("e", 8.0, 9)])
		self.assertEqual(tx.tx_normalise(clause)[0], (0, "a b,"))
		pause = tx_words([("a", 0, 2), ("b", 2, 5.2), ("c", 7.0, 7.5), ("d", 7.5, 7.9), ("e", 8.0, 9)])
		self.assertEqual(tx.tx_normalise(pause)[0], (0, "a b"))

	def test_long_pause_splits_short_segment(self):
		tokens = tx_words([("Hi", 0, 0.5), ("there", 20, 20.5)])
		self.assertEqual(tx.tx_normalise(tokens), [(0, "Hi"), (20, "there")])

	def test_short_tail_merges_into_predecessor(self):
		tokens = tx_words([("a", 0, 2), ("b.", 2, 5), ("c", 5.1, 6)])
		self.assertEqual(tx.tx_normalise(tokens), [(0, "a b. c")])

	def spans(self, tokens, segments):
		# span of a segment = its last token end - its start, reconstructed from token order
		spans = []
		remaining = list(tokens)
		for start, text in segments:
			count = len(text.split(" "))
			chunk, remaining = remaining[:count], remaining[count:]
			spans.append(chunk[-1]["end"] - chunk[0]["start"])
		return spans


class RenderTest(unittest.TestCase):

	def test_lines_match_reference_format(self):
		lines = tx.tx_render([(0.4, "Hello."), (6.2, "Next line."), (3605.9, "Late.")])
		self.assertEqual(lines, ["0:00 Hello.", "0:06 Next line.", "1:00:05 Late."])
		for line in lines:
			self.assertRegex(line, tx.LINE_PATTERN)

	def test_same_second_merges(self):
		self.assertEqual(tx.tx_render([(5.1, "a"), (5.9, "b"), (7, "c")]), ["0:05 a b", "0:07 c"])

	def test_empty_text_is_a_bug(self):
		with self.assertRaises(tx.TranscribeError):
			tx.tx_render([(1, "")])

	def test_repeat_flag(self):
		lines = ["0:01 Thanks.", "0:07 Thanks.", "0:13 Thanks.", "0:20 Other."]
		warnings = tx.tx_flag_repeats(lines)
		self.assertEqual(len(warnings), 1)
		self.assertIn("0:01-0:13", warnings[0])
		self.assertEqual(tx.tx_flag_repeats(lines[1:]), [])


class ChunkPlanTest(unittest.TestCase):

	def test_short_file_is_one_chunk(self):
		self.assertEqual(tx.tx_plan_chunks(200.0, 4 * 1024 * 1024, []), [(0.0, 200.0)])

	def test_chunks_are_short_continuous_and_cut_mid_silence(self):
		duration = 3 * 3600.0
		size = 150 * 1024 * 1024
		silences = [(float(s), float(s) + 1.0) for s in range(30, int(duration), 17)]
		middles = [(a + b) / 2 for a, b in silences]
		chunks = tx.tx_plan_chunks(duration, size, silences)
		bytesPerSecond = size / duration
		self.assertEqual(chunks[0][0], 0.0)
		self.assertEqual(chunks[-1][1], duration)
		for (_, end), (start, _) in zip(chunks, chunks[1:]):
			self.assertEqual(end, start)
			self.assertIn(end, middles)
		for start, end in chunks:
			self.assertLessEqual(end - start, tx.CHUNK_SECONDS)
			self.assertLess((end - start) * bytesPerSecond, tx.MAX_UPLOAD_BYTES)

	def test_size_limit_wins_over_chunk_length(self):
		# 1 MB per second: 24 MB allows only ~23 s per chunk
		chunks = tx.tx_plan_chunks(600.0, 600 * 1024 * 1024, [])
		self.assertTrue(all(end - start < 24 for start, end in chunks))

	def test_hard_cut_without_silence(self):
		chunks = tx.tx_plan_chunks(3600.0, 60 * 1024 * 1024, [])
		self.assertEqual(len(chunks), 15)
		self.assertEqual(chunks[-1][1], 3600.0)


class GapRepairTest(unittest.TestCase):

	def test_finds_speech_gaps_only(self):
		tokens = tx_words([("a", 0.5, 1), ("b", 20, 21), ("c", 40, 41)])
		silences = [(1.2, 19.8)]        # the first gap is a real pause
		self.assertEqual(tx.tx_find_gaps(tokens, 60.0, silences), [(21, 40), (41, 60.0)])

	def test_leading_gap_is_checked(self):
		tokens = tx_words([("a", 10, 11)])
		self.assertEqual(tx.tx_find_gaps(tokens, 11.0, []), [(0.0, 10)])

	def test_repair_splices_words_inside_gap_only(self):
		tokens = tx_words([("a", 0, 1), ("z", 30, 31)])
		calls = []

		def request(start, end):
			calls.append((start, end))
			# context words outside the gap must not be duplicated
			return tx_words([("a", 0.5, 1), ("x", 10, 11), ("y", 20, 21), ("z", 30, 30.5)])

		with mock.patch("sys.stderr", io.StringIO()):
			repaired, unrecovered = tx.tx_repair(tokens, 31.0, [], request)
		self.assertEqual(calls, [(0.0, 31.0)])
		self.assertEqual([t["text"] for t in repaired], ["a", "x", "y", "z"])
		self.assertEqual(unrecovered, [])

	def test_unrecovered_gap_is_reported_after_distinct_windows(self):
		# identical bytes always give the same miss, so every attempt must send a different window
		tokens = tx_words([("a", 0, 1), ("z", 30, 31)])
		calls = []

		def request(start, end):
			calls.append((start, end))
			return []

		with mock.patch("sys.stderr", io.StringIO()):
			repaired, unrecovered = tx.tx_repair(tokens, 100.0, [(31, 100)], request)
		self.assertEqual(repaired, tokens)
		self.assertEqual(unrecovered, [(1, 30)])
		self.assertEqual(len(calls), len(tx.REPAIR_PADS))
		self.assertEqual(len(set(calls)), len(calls))

	def test_clamped_windows_are_not_sent_twice(self):
		tokens = tx_words([("a", 0, 1), ("z", 30, 31)])
		calls = []

		def request(start, end):
			calls.append((start, end))
			return []

		with mock.patch("sys.stderr", io.StringIO()):
			tx.tx_repair(tokens, 31.0, [], request)
		self.assertEqual(calls, [(0.0, 31.0)])

	def test_stretched_word_does_not_hide_a_gap(self):
		# a "word" timed over 6 s covers skipped speech (measured on Groq, SKILL.md §3.1 step 7)
		tokens = tx_words([("a", 0, 1), ("b", 1, 7), ("c", 7, 8)])
		self.assertEqual(tx.tx_find_gaps(tokens, 8.0, []), [(1 + tx.WORD_MAX, 7)])

	def test_first_word_pulled_over_intro_is_retimed(self):
		# measured on a real talk: "Hello," at 0.0-20.9 s over intro music, speech starts at ~20.7 s
		tokens = tx_words([("Hello,", 0.0, 20.9), ("everyone.", 21.0, 21.5), ("z", 22, 23)])
		with mock.patch("sys.stderr", io.StringIO()):
			repaired, unrecovered = tx.tx_repair(tokens, 23.0, [], lambda start, end: [])
		self.assertEqual(unrecovered, [])
		self.assertAlmostEqual(repaired[0]["start"], 20.9 - tx.WORD_MAX)
		self.assertEqual(tx.tx_render(tx.tx_normalise(repaired))[0].split(" ")[0], "0:19")

	def test_retry_until_words_come_back(self):
		tokens = tx_words([("a", 0, 1), ("z", 30, 31)])
		answers = [[], tx_words([("x", 10, 11)])]
		with mock.patch("sys.stderr", io.StringIO()):
			repaired, unrecovered = tx.tx_repair(tokens, 100.0, [(31, 100)], lambda start, end: answers.pop(0))
		self.assertEqual([t["text"] for t in repaired], ["a", "x", "z"])
		self.assertEqual(unrecovered, [])

	def test_repair_keeps_groq_word_order(self):
		# Groq word starts are not monotonic ("6." at 98.28 before "If" at 98.24) - re-sorting swapped them
		tokens = tx_words([("number", 97.5, 98.0), ("6.", 98.28, 98.6), ("If", 98.24, 98.5), ("the", 98.6, 98.8), ("z", 130, 131)])
		with mock.patch("sys.stderr", io.StringIO()):
			repaired, _ = tx.tx_repair(tokens, 131.0, [], lambda start, end: tx_words([("x", 110, 111)]))
		self.assertEqual([t["text"] for t in repaired], ["number", "6.", "If", "the", "x", "z"])

	def test_context_words_are_not_duplicated_at_the_edges(self):
		tokens = tx_words([("hello,", 0, 1), ("world.", 30, 31)])
		retimed = tx_words([("Hello", 1.0, 1.5), ("x", 10, 11), ("world", 29.5, 30.05)])
		with mock.patch("sys.stderr", io.StringIO()):
			repaired, _ = tx.tx_repair(tokens, 31.0, [], lambda start, end: retimed)
		self.assertEqual([t["text"] for t in repaired], ["hello,", "x", "world."])

	def test_silent_seconds(self):
		self.assertEqual(tx.tx_silent_seconds(10, 20, [(0, 12), (15, 16), (19, 30)]), 4)


class OffsetTest(unittest.TestCase):

	def test_chunk_offsets_keep_timestamps_increasing(self):
		chunkResponse = {"words": [{"word": f"w{i}.", "start": i * 2.0, "end": i * 2.0 + 1.5} for i in range(300)]}
		tokens = []
		for start in (0.0, 600.0, 1200.0):
			tokens += tx.tx_tokens(chunkResponse, start)
		lines = tx.tx_render(tx.tx_normalise(tokens))
		seconds = []
		for line in lines:
			parts = [int(p) for p in line.split(" ", 1)[0].split(":")]
			seconds.append(parts[0] * 60 + parts[1] if(len(parts) == 2) else parts[0] * 3600 + parts[1] * 60 + parts[2])
		self.assertEqual(seconds, sorted(set(seconds)))
		self.assertGreaterEqual(seconds[-1], 1200 + 590)


class FakeResponse(io.BytesIO):

	def __enter__(self):
		return self

	def __exit__(self, *args):
		return False


def tx_http_error(code, retryAfter=None, message="boom"):
	headers = {"retry-after": retryAfter} if(retryAfter) else {}
	body = io.BytesIO(json.dumps({"error": {"message": message}}).encode())
	return urllib.error.HTTPError(tx.GROQ_URL, code, "error", headers, body)


class GroqRequestTest(unittest.TestCase):

	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.audio = Path(self.tmp.name) / "a.flac"
		self.audio.write_bytes(b"fLaC fake")

	def tearDown(self):
		self.tmp.cleanup()

	def test_retries_on_429_then_succeeds(self):
		ok = json.dumps({"words": []}).encode()
		opener = mock.Mock(side_effect=[tx_http_error(429, "3"), tx_http_error(503), FakeResponse(ok)])
		sleep = mock.Mock()
		with mock.patch("sys.stderr", io.StringIO()):
			result = tx.tx_groq_request(self.audio, "k", "de", opener=opener, sleep=sleep)
		self.assertEqual(result, {"words": []})
		self.assertEqual(opener.call_count, 3)
		self.assertEqual(sleep.call_args_list[0].args[0], 3.0)
		request = opener.call_args.args[0]
		self.assertIn(b'name="language"\r\n\r\nde', request.data)
		self.assertIn(b'name="timestamp_granularities[]"\r\n\r\nword', request.data)
		self.assertEqual(request.get_header("Authorization"), "Bearer k")

	def test_gives_up_after_max_retries(self):
		opener = mock.Mock(side_effect=[tx_http_error(429) for _ in range(tx.MAX_RETRIES + 1)])
		with mock.patch("sys.stderr", io.StringIO()):
			with self.assertRaises(tx.TranscribeError):
				tx.tx_groq_request(self.audio, "k", None, opener=opener, sleep=mock.Mock())
		self.assertEqual(opener.call_count, tx.MAX_RETRIES + 1)

	def test_client_error_fails_fast_with_message(self):
		opener = mock.Mock(side_effect=[tx_http_error(400, message="file too large")])
		with self.assertRaisesRegex(tx.TranscribeError, "file too large"):
			tx.tx_groq_request(self.audio, "k", None, opener=opener, sleep=mock.Mock())
		self.assertEqual(opener.call_count, 1)

	def test_bad_key_is_a_setup_error(self):
		opener = mock.Mock(side_effect=[tx_http_error(401)])
		with self.assertRaises(tx.SetupError):
			tx.tx_groq_request(self.audio, "k", None, opener=opener, sleep=mock.Mock())


class ConfigTest(unittest.TestCase):

	def run_with_config(self, content):
		with tempfile.TemporaryDirectory() as tmp:
			config = Path(tmp) / "config.json"
			if(content is not None):
				config.write_text(content, encoding="utf-8")
			with mock.patch.object(tx, "CONFIG_FILE", config):
				return tx.tx_read_key()

	def test_missing_empty_placeholder_invalid(self):
		for content in (None, '{"GROQ_API_KEY": ""}', '{"GROQ_API_KEY": "<your-groq-key>"}', "not json"):
			with self.assertRaises(tx.SetupError, msg=content):
				self.run_with_config(content)

	def test_valid_key(self):
		self.assertEqual(self.run_with_config('{"GROQ_API_KEY": " gsk_test "}'), "gsk_test")


class YoutubeTest(unittest.TestCase):

	def test_video_id(self):
		for url in ("https://www.youtube.com/watch?v=abcDEF12345&t=3", "https://youtu.be/abcDEF12345", "https://www.youtube.com/shorts/abcDEF12345"):
			self.assertEqual(tx.tx_video_id(url), "abcDEF12345", url)
		self.assertEqual(tx.tx_video_id("https://example.com/talk"), "video")

	def test_pick_prefers_manual_then_original_asr(self):
		info = {"language": "en", "subtitles": {"en-GB": [], "de": []}, "automatic_captions": {"en-orig": [], "en": [], "de": []}}
		self.assertEqual(tx.tx_pick_captions(info, None), ("manual", "en-GB"))
		info["subtitles"] = {}
		self.assertEqual(tx.tx_pick_captions(info, None), ("auto", "en-orig"))

	def test_pick_never_uses_a_translation(self):
		# "de" auto captions of an English video are machine translations
		info = {"language": "en", "subtitles": {}, "automatic_captions": {"en-orig": [], "de": []}}
		self.assertIsNone(tx.tx_pick_captions(info, "de"))

	def test_pick_plain_track_only_in_own_language(self):
		info = {"language": "de", "subtitles": {}, "automatic_captions": {"de": []}}
		self.assertEqual(tx.tx_pick_captions(info, None), ("auto", "de"))
		self.assertIsNone(tx.tx_pick_captions({"subtitles": {}, "automatic_captions": {"de": []}}, None))

	def test_pick_derives_language_from_orig_track(self):
		# measured: a video without "language" in its metadata, human en subtitles and an en-orig track
		info = {"language": None, "subtitles": {"en": [], "en-GB": []}, "automatic_captions": {"en-orig": [], "de": []}}
		self.assertEqual(tx.tx_pick_captions(info, None), ("manual", "en"))
		self.assertIsNone(tx.tx_pick_captions({"subtitles": {"en": []}, "automatic_captions": {}}, None))

	def test_null_metadata_is_a_transcribe_error(self):
		with mock.patch.object(tx, "tx_ytdlp", return_value=mock.Mock(stdout="null")):
			with self.assertRaisesRegex(tx.TranscribeError, "no video metadata"):
				tx.tx_video_info("https://youtu.be/abcDEF12345")

	def test_auto_caption_words(self):
		captions = {"events": [
			{"tStartMs": 0, "dDurationMs": 90000, "id": 1},
			{"tStartMs": 20680, "dDurationMs": 4000, "segs": [{"utf8": "Good"}, {"utf8": " morning,", "tOffsetMs": 400}, {"utf8": " all.", "tOffsetMs": 1100}]},
			{"tStartMs": 22900, "dDurationMs": 1800, "aAppend": 1, "segs": [{"utf8": "\n"}]},
			{"tStartMs": 23000, "dDurationMs": 2000, "segs": [{"utf8": "Next"}]},
		]}
		tokens = tx.tx_caption_tokens(captions)
		self.assertEqual([t["text"] for t in tokens], ["Good", "morning,", "all.", "Next"])
		self.assertAlmostEqual(tokens[0]["start"], 20.68)
		self.assertAlmostEqual(tokens[0]["end"], 21.08)
		self.assertAlmostEqual(tokens[2]["end"], 23.0)     # event end 24.68 capped at the next word
		self.assertEqual(tx.tx_render(tx.tx_normalise(tokens))[0], "0:20 Good morning, all. Next")

	def test_manual_cues(self):
		captions = {"events": [
			{"tStartMs": 1000, "dDurationMs": 3000, "segs": [{"utf8": "First cue,\nsecond line."}]},
			{"tStartMs": 9000, "dDurationMs": 2000, "segs": [{"utf8": "Later cue."}]},
		]}
		tokens = tx.tx_caption_tokens(captions)
		self.assertEqual(tokens, [{"text": "First cue, second line.", "start": 1.0, "end": 4.0}, {"text": "Later cue.", "start": 9.0, "end": 11.0}])


class CliTest(unittest.TestCase):

	def test_default_output(self):
		self.assertEqual(tx.tx_default_output("https://youtu.be/abcDEF12345"), tx.TMP_DIR / "abcDEF12345.transcript.txt")
		self.assertEqual(tx.tx_default_output("talks/intro.mp4"), tx.TMP_DIR / "intro.transcript.txt")

	def test_missing_file(self):
		with mock.patch("sys.stderr", io.StringIO()):
			self.assertEqual(tx.main(["does-not-exist.mp3"]), 1)


if(__name__ == "__main__"):
	unittest.main()
