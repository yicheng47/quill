#!/usr/bin/env python3
"""
Build Quill's read-only offline dictionary SQLite database (`dict.db`) or
the checked-in deterministic test fixture (`dict-test.db`).

Data sources & licenses (open, redistributable):
  - English Wiktionary via kaikki.org wiktextract (CC-BY-SA 4.0)
  - ECDICT (MIT) — English->Chinese brief glosses and word-frequency ranking
  - Chinese Wiktionary via kaikki.org wiktextract (CC-BY-SA 4.0)
  - CC-CEDICT (CC-BY-SA 4.0) — Simplified/Traditional Chinese headwords, pinyin, EN glosses

Usage:
  # Regenerate the checked-in deterministic test fixture (~32 KB):
  python3 scripts/build-dict.py --fixture

  # Download open sources (cached) and build full <= 20 MB dict.db:
  python3 scripts/build-dict.py

  # Build from pre-downloaded local source files:
  python3 scripts/build-dict.py \
      --en-kaikki path/to/kaikki.org-dictionary-English.jsonl \
      --ecdict path/to/ecdict.csv \
      --zh-kaikki path/to/kaikki.org-dictionary-Chinese.jsonl \
      --cedict path/to/cedict_1_0_ts_utf-8_mdbg.txt.gz
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import re
import sqlite3
import sys
import urllib.request
import zipfile
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "crates" / "quill-core" / "resources" / "dict.db"
FIXTURE_OUT = REPO_ROOT / "crates" / "quill-core" / "resources" / "dict-test.db"
DEFAULT_CACHE = REPO_ROOT / ".cache" / "dict-sources"

URLS = {
    "en_kaikki": "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl",
    "zh_kaikki": "https://kaikki.org/dictionary/Chinese/kaikki.org-dictionary-Chinese.jsonl",
    "cedict": "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz",
    "ecdict_zip": "https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-sqlite-28.zip",
    "ecdict_csv": "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.mini.csv",
    "ecdict_full_csv": "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
}

MAX_TARGET_BYTES = 20 * 1024 * 1024  # 20 MB hard cap

# Tone-number pinyin -> tone-marked pinyin converter (for CC-CEDICT)
TONE_VOWELS = {
    "a": "āáǎàa",
    "e": "ēéěèe",
    "i": "īíǐìi",
    "o": "ōóǒòo",
    "u": "ūúǔùu",
    "ü": "ǖǘǚǜü",
}

POS_MAP_EN = {
    "noun": "noun",
    "verb": "verb",
    "adj": "adj.",
    "adv": "adv.",
    "prep": "prep.",
    "conj": "conj.",
    "pron": "pron.",
    "intj": "interj.",
    "det": "det.",
    "num": "num.",
    "article": "article",
    "phrase": "phrase",
    "proverb": "proverb",
    "prep_phrase": "phrase",
}

POS_MAP_ZH = {
    "noun": "名词",
    "verb": "动词",
    "adj": "形容词",
    "adv": "副词",
    "prep": "介词",
    "conj": "连词",
    "pron": "代词",
    "intj": "感叹词",
    "num": "数词",
    "classifier": "量词",
    "particle": "助词",
    "idiom": "成语",
    "proverb": "谚语",
    "phrase": "短语",
    "name": "专有名词",
}

HANZI_RE = re.compile(r"^[\u3400-\u4dbf\u4e00-\u9fff]+$")
ASCII_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'-]{0,39}$")


def convert_pinyin_syllable(syllable: str) -> str:
    s = syllable.strip().replace("u:", "ü").replace("v", "ü")
    if not s:
        return ""
    if s[-1].isdigit():
        tone = int(s[-1])
        body = s[:-1]
    else:
        return s
    if tone < 1 or tone > 5:
        return s
    idx = tone - 1
    lower = body.lower()
    if "a" in lower:
        pos = lower.index("a")
    elif "e" in lower:
        pos = lower.index("e")
    elif "ou" in lower:
        pos = lower.index("o")
    else:
        pos = -1
        for i in range(len(lower) - 1, -1, -1):
            if lower[i] in TONE_VOWELS:
                pos = i
                break
    if pos == -1:
        return body
    ch = body[pos]
    repl = TONE_VOWELS[ch.lower()][idx]
    if ch.isupper():
        repl = repl.upper()
    return body[:pos] + repl + body[pos + 1 :]


def numbered_pinyin_to_marked(raw: str) -> str:
    return " ".join(convert_pinyin_syllable(p) for p in raw.split() if p.strip())


def clean_gloss(text: str, max_len: int = 160) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > max_len:
        cut = text[:max_len].rsplit(" ", 1)[0]
        text = (cut if len(cut) > 40 else text[:max_len]).rstrip(" ,;:") + "…"
    return text


def build_senses_zdict(sample_payloads: list[bytes]) -> bytes:
    """Build a deterministic <= 32 KB preset deflate dictionary from common tokens + samples."""
    seed = (
        '[{"pos":"noun","defs":["'
        '[{"pos":"verb","defs":["'
        '[{"pos":"adj.","defs":["'
        '[{"pos":"adv.","defs":["'
        '[{"pos":"prep.","defs":["'
        '[{"pos":"成语","defs":["'
        '[{"pos":"名词","defs":["'
        '[{"pos":"动词","defs":["'
        '[{"pos":"形容词","defs":["'
        '[{"pos":"副词","defs":["'
        '"]},{"pos":"'
        '","'
        '"]}]'
        "To cause someone or something to "
        "The act or process of "
        "A person who "
        "Relating to or characterized by "
        "In a manner that is "
        "Having the quality of "
        "Used to indicate "
        "比喻 形容 指人的思想、性格 表示 一种 用来 "
    ).encode("utf-8")
    buf = bytearray(seed)
    step = max(1, len(sample_payloads) // 400)
    for payload in sample_payloads[::step]:
        if len(buf) + len(payload) > 32768:
            break
        buf.extend(payload)
    # zlib deflate dictionary uses at most the last 32768 bytes
    return bytes(buf[-32768:])


def compress_senses(raw_json: bytes, zdict: bytes | None) -> bytes:
    if zdict is None:
        return raw_json
    c = zlib.compressobj(level=9, wbits=-15, zdict=zdict)
    compressed = c.compress(raw_json) + c.flush()
    if len(compressed) + 1 < len(raw_json):
        return b"\x02" + compressed
    return raw_json


def write_sqlite_db(
    out_path: Path,
    entries: list[dict[str, Any]],
    forms: list[tuple[str, str, int, int, str | None]],
    *,
    compress: bool,
    built_at: str,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    if tmp_path.exists():
        tmp_path.unlink()

    serialized: list[bytes] = [
        json.dumps(e["senses"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        for e in entries
    ]
    zdict = build_senses_zdict(serialized) if compress else None

    conn = sqlite3.connect(str(tmp_path))
    try:
        conn.execute("PRAGMA page_size = 4096;")
        conn.execute("PRAGMA journal_mode = OFF;")
        conn.execute("PRAGMA synchronous = OFF;")
        conn.execute(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE entries (
                id INTEGER PRIMARY KEY,
                lang TEXT NOT NULL,
                lemma TEXT NOT NULL,
                pron TEXT,
                senses_json BLOB NOT NULL,
                gloss_en TEXT,
                gloss_zh TEXT
            );
            """
        )
        conn.execute(
            """
            CREATE TABLE forms (
                form TEXT NOT NULL,
                lang TEXT NOT NULL,
                entry_id INTEGER NOT NULL,
                is_lemma INTEGER NOT NULL,
                relation TEXT
            );
            """
        )

        meta_rows: list[tuple[str, bytes]] = [
            ("schema_version", b"1"),
            ("senses_codec", b"deflate_dict" if zdict is not None else b"plain"),
            ("entry_count", str(len(entries)).encode("utf-8")),
            ("built_at", built_at.encode("utf-8")),
            (
                "attribution",
                b"Wiktionary (kaikki.org, CC-BY-SA 4.0), ECDICT (MIT), CC-CEDICT (CC-BY-SA 4.0)",
            ),
        ]
        if zdict is not None:
            meta_rows.append(("senses_zdict", zdict))
        conn.executemany("INSERT INTO meta(key, value) VALUES (?, ?)", meta_rows)

        entry_rows = []
        for idx, e in enumerate(entries, start=1):
            payload = compress_senses(serialized[idx - 1], zdict) if compress else serialized[idx - 1].decode("utf-8")
            entry_rows.append(
                (
                    idx,
                    e["lang"],
                    e["lemma"],
                    e.get("pron"),
                    payload,
                    e.get("gloss_en"),
                    e.get("gloss_zh"),
                )
            )
        conn.executemany(
            "INSERT INTO entries(id, lang, lemma, pron, senses_json, gloss_en, gloss_zh) VALUES (?, ?, ?, ?, ?, ?, ?)",
            entry_rows,
        )

        # Deduplicate forms preserving is_lemma=1 first
        seen_forms: set[tuple[str, str, int]] = set()
        deduped_forms: list[tuple[str, str, int, int, str | None]] = []
        for form, lang, entry_id, is_lemma, relation in sorted(
            forms, key=lambda r: (r[1], r[0], -r[3], r[2])
        ):
            k = (form, lang, entry_id)
            if k in seen_forms:
                continue
            seen_forms.add(k)
            deduped_forms.append((form, lang, entry_id, is_lemma, relation))

        conn.executemany(
            "INSERT INTO forms(form, lang, entry_id, is_lemma, relation) VALUES (?, ?, ?, ?, ?)",
            deduped_forms,
        )
        conn.execute("CREATE INDEX idx_forms_form_lang ON forms(form, lang);")
        conn.execute("CREATE INDEX idx_forms_entry_id ON forms(entry_id);")
        conn.execute("CREATE INDEX idx_entries_lang_lemma ON entries(lang, lemma);")
        conn.commit()
        conn.execute("VACUUM;")
    finally:
        conn.close()

    os.replace(tmp_path, out_path)
    size = out_path.stat().st_size
    print(
        f"Wrote {out_path} ({size:,} bytes / {size / (1024 * 1024):.2f} MB, "
        f"{len(entries):,} entries, {len(deduped_forms):,} forms)"
    )


def build_fixture(out_path: Path) -> None:
    """Generate the small deterministic dict-test.db checked into git."""
    fixture_specs = [
        # English entries
        {
            "lang": "en",
            "lemma": "mortify",
            "pron": "/ˈmɔːr.tɪ.faɪ/",
            "gloss_zh": "使难堪；羞辱；克制",
            "senses": [
                {
                    "pos": "verb",
                    "defs": [
                        "Cause someone to feel deeply embarrassed, ashamed, or humiliated.",
                        "Subdue one's bodily passions or appetites by self-denial or discipline.",
                        "(archaic, medicine) Undergo gangrene or necrosis.",
                    ],
                }
            ],
            "forms": [
                ("mortified", "past tense"),
                ("mortifying", "present participle"),
                ("mortifies", "third-person singular"),
            ],
        },
        {
            "lang": "en",
            "lemma": "go",
            "pron": "/ɡoʊ/",
            "gloss_zh": "去；走；进行",
            "senses": [
                {
                    "pos": "verb",
                    "defs": [
                        "Move from one place to another; travel.",
                        "Leave; depart.",
                    ],
                }
            ],
            "forms": [
                ("went", "past tense"),
                ("gone", "past participle"),
                ("going", "present participle"),
                ("goes", "third-person singular"),
            ],
        },
        {
            "lang": "en",
            "lemma": "run",
            "pron": "/rʌn/",
            "gloss_zh": "跑；运行；经营",
            "senses": [
                {
                    "pos": "verb",
                    "defs": [
                        "Move at a speed faster than a walk.",
                        "Operate or function.",
                    ],
                },
                {
                    "pos": "noun",
                    "defs": ["An act or spell of running."],
                },
            ],
            "forms": [
                ("ran", "past tense"),
                ("running", "present participle"),
                ("runs", "third-person singular"),
            ],
        },
        {
            "lang": "en",
            "lemma": "good",
            "pron": "/ɡʊd/",
            "gloss_zh": "好的；善的",
            "senses": [
                {
                    "pos": "adj.",
                    "defs": ["To be desired or approved of; of high quality."],
                }
            ],
            "forms": [
                ("better", "comparative"),
                ("best", "superlative"),
            ],
        },
        {
            "lang": "en",
            "lemma": "child",
            "pron": "/tʃaɪld/",
            "gloss_zh": "孩子；儿童",
            "senses": [
                {
                    "pos": "noun",
                    "defs": ["A young human being below the age of puberty."],
                }
            ],
            "forms": [
                ("children", "plural"),
            ],
        },
        {
            "lang": "en",
            "lemma": "leave",
            "pron": "/liːv/",
            "gloss_zh": "离开；留下",
            "senses": [
                {
                    "pos": "verb",
                    "defs": [
                        "Go away from.",
                        "Allow or cause to remain.",
                    ],
                }
            ],
            "forms": [
                ("left", "past tense"),
                ("leaving", "present participle"),
                ("leaves", "third-person singular"),
            ],
        },
        {
            "lang": "en",
            "lemma": "left",
            "pron": "/lɛft/",
            "gloss_zh": "左边的；左侧",
            "senses": [
                {
                    "pos": "adj.",
                    "defs": ["On, toward, or relating to the side of a human body or of a thing that is to the west when facing north."],
                },
                {
                    "pos": "noun",
                    "defs": ["The left-hand part, side, or direction."],
                },
            ],
            "forms": [],
        },
        {
            "lang": "en",
            "lemma": "see",
            "pron": "/siː/",
            "gloss_zh": "看见；理解",
            "senses": [
                {
                    "pos": "verb",
                    "defs": ["Perceive with the eyes; discern visually."],
                }
            ],
            "forms": [
                ("saw", "past tense"),
                ("seen", "past participle"),
                ("seeing", "present participle"),
                ("sees", "third-person singular"),
            ],
        },
        {
            "lang": "en",
            "lemma": "saw",
            "pron": "/sɔː/",
            "gloss_zh": "锯；锯子",
            "senses": [
                {
                    "pos": "noun",
                    "defs": ["A hand tool for cutting wood or other hard materials, typically with a serrated metal blade."],
                }
            ],
            "forms": [("saws", "plural")],
        },
        {
            # Deliberately omits inflections to exercise suffix-rule fallback (-ied/-ies -> -y)
            "lang": "en",
            "lemma": "study",
            "pron": "/ˈstʌd.i/",
            "gloss_zh": "学习；研究",
            "senses": [
                {
                    "pos": "verb",
                    "defs": ["Devote time and attention to gaining knowledge of a subject."],
                },
                {
                    "pos": "noun",
                    "defs": ["A detailed investigation and analysis of a subject or situation."],
                },
            ],
            "forms": [],
        },
        {
            # Deliberately omits inflections to exercise suffix-rule fallback (-ed/-ing/-s)
            "lang": "en",
            "lemma": "walk",
            "pron": "/wɔːk/",
            "gloss_zh": "走；散步",
            "senses": [
                {
                    "pos": "verb",
                    "defs": ["Move at a regular pace by lifting and setting down each foot in turn."],
                }
            ],
            "forms": [],
        },
        {
            # Deliberately omits -es plural to exercise suffix fallback (-es)
            "lang": "en",
            "lemma": "box",
            "pron": "/bɒks/",
            "gloss_zh": "盒子；箱子",
            "senses": [
                {
                    "pos": "noun",
                    "defs": ["A container with a flat base and sides, typically square or rectangular."],
                }
            ],
            "forms": [],
        },
        {
            "lang": "en",
            "lemma": "palimpsest",
            "pron": "/ˈpæl.ɪmp.sɛst/",
            "gloss_zh": "重写羊皮纸；重层文本",
            "senses": [
                {
                    "pos": "noun",
                    "defs": [
                        "A manuscript or piece of writing material on which later writing has been superimposed on effaced earlier writing.",
                        "Something reused or altered but still bearing visible traces of its earlier form.",
                    ],
                }
            ],
            "forms": [("palimpsests", "plural")],
        },
        {
            "lang": "en",
            "lemma": "ephemeral",
            "pron": "/ɪˈfɛm.ər.əl/",
            "gloss_zh": "短暂的；瞬息的",
            "senses": [
                {
                    "pos": "adj.",
                    "defs": ["Lasting for a very short time."],
                }
            ],
            "forms": [],
        },
        # Chinese entries (Simplified canonical + Traditional mapping)
        {
            "lang": "zh",
            "lemma": "潜移默化",
            "pron": "qián yí mò huà",
            "gloss_en": "subtle, imperceptible influence",
            "senses": [
                {
                    "pos": "成语",
                    "defs": ["指人的思想或性格在不知不觉中受到感染、影响而发生变化。"],
                }
            ],
            "forms": [("潛移默化", "traditional")],
        },
        {
            "lang": "zh",
            "lemma": "悖论",
            "pron": "bèi lùn",
            "gloss_en": "paradox",
            "senses": [
                {
                    "pos": "名词",
                    "defs": ["表面荒谬或自相矛盾，却蕴含深刻逻辑问题的命题。"],
                }
            ],
            "forms": [("悖論", "traditional")],
        },
        {
            "lang": "zh",
            "lemma": "缄默",
            "pron": "jiān mò",
            "gloss_en": "keep silent; reticent",
            "senses": [
                {
                    "pos": "动词",
                    "defs": ["闭口不言，保持沉默。"],
                }
            ],
            "forms": [("緘默", "traditional")],
        },
        {
            "lang": "zh",
            "lemma": "执拗",
            "pron": "zhí niù",
            "gloss_en": "stubborn; obstinate",
            "senses": [
                {
                    "pos": "形容词",
                    "defs": ["固执任性，不听劝告。"],
                }
            ],
            "forms": [("執拗", "traditional")],
        },
        {
            "lang": "zh",
            "lemma": "阅读",
            "pron": "yuè dú",
            "gloss_en": "to read; reading",
            "senses": [
                {
                    "pos": "动词",
                    "defs": ["看书报并领会其内容。"],
                }
            ],
            "forms": [("閱讀", "traditional")],
        },
    ]

    entries: list[dict[str, Any]] = []
    forms: list[tuple[str, str, int, int, str | None]] = []
    for idx, spec in enumerate(fixture_specs, start=1):
        entries.append(spec)
        lang = spec["lang"]
        lemma_key = spec["lemma"].lower() if lang == "en" else spec["lemma"]
        forms.append((lemma_key, lang, idx, 1, None))
        for f, rel in spec["forms"]:
            f_key = f.lower() if lang == "en" else f
            forms.append((f_key, lang, idx, 0, rel))

    write_sqlite_db(out_path, entries, forms, compress=False, built_at="fixture")


def download_cached(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"Using cached {dest}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {url} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "Quill-Dict-Builder/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, dest)
    return dest


def load_ecdict(path: Path) -> dict[str, dict[str, Any]]:
    """Load ECDICT CSV or SQLite (inside zip) -> {word_lower: {zh, pron, rank, exchange, defs}}."""
    result: dict[str, dict[str, Any]] = {}
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as zf:
            db_names = [n for n in zf.namelist() if n.endswith(".db")]
            if db_names:
                extracted = path.with_suffix(".db")
                if not extracted.exists():
                    with zf.open(db_names[0]) as src, open(extracted, "wb") as dst:
                        dst.write(src.read())
                conn = sqlite3.connect(str(extracted))
                try:
                    cur = conn.execute(
                        "SELECT word, phonetic, definition, translation, collins, oxford, bnc, frq, exchange FROM stardict"
                    )
                    for word, phonetic, definition, translation, collins, oxford, bnc, frq, exchange in cur:
                        if not word or not ASCII_WORD_RE.match(word):
                            continue
                        low = word.lower()
                        rank = compute_ecdict_rank(collins, oxford, bnc, frq)
                        if low not in result or rank < result[low]["rank"]:
                            result[low] = {
                                "word": word,
                                "phonetic": (phonetic or "").strip(),
                                "definition": (definition or "").strip(),
                                "translation": (translation or "").strip(),
                                "rank": rank,
                                "exchange": (exchange or "").strip(),
                            }
                finally:
                    conn.close()
                return result

    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            word = (row.get("word") or "").strip()
            if not word or not ASCII_WORD_RE.match(word):
                continue
            low = word.lower()
            rank = compute_ecdict_rank(
                row.get("collins"), row.get("oxford"), row.get("bnc"), row.get("frq")
            )
            if low not in result or rank < result[low]["rank"]:
                result[low] = {
                    "word": word,
                    "phonetic": (row.get("phonetic") or "").strip(),
                    "definition": (row.get("definition") or "").strip(),
                    "translation": (row.get("translation") or "").strip(),
                    "rank": rank,
                    "exchange": (row.get("exchange") or "").strip(),
                }
    return result


def compute_ecdict_rank(collins: Any, oxford: Any, bnc: Any, frq: Any) -> int:
    def to_int(v: Any) -> int:
        try:
            return int(v) if v not in (None, "") else 0
        except (ValueError, TypeError):
            return 0

    c = to_int(collins)
    o = to_int(oxford)
    b = to_int(bnc)
    f = to_int(frq)
    score = 1_000_000
    if o:
        score -= 400_000
    if c > 0:
        score -= c * 50_000
    freqs = [x for x in (b, f) if x > 0]
    if freqs:
        score = min(score, min(freqs))
    return score


def compact_zh_gloss_from_ecdict(raw: str) -> str | None:
    if not raw:
        return None
    parts: list[str] = []
    for line in raw.replace("\\n", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        # Strip leading POS tag like "vt. " / "n. "
        cleaned = re.sub(r"^[a-z]+\.\s*", "", line)
        for piece in re.split(r"[,，;；]", cleaned):
            p = piece.strip()
            if p and p not in parts:
                parts.append(p)
            if len(parts) >= 3:
                break
        if len(parts) >= 3:
            break
    return "；".join(parts)[:64] if parts else None


def parse_ecdict_exchange(exchange: str) -> list[tuple[str, str]]:
    """Parse ECDICT exchange field like 'p:mortified/d:mortified/i:mortifying/3:mortifies'."""
    tag_map = {
        "p": "past tense",
        "d": "past participle",
        "i": "present participle",
        "3": "third-person singular",
        "s": "plural",
        "r": "comparative",
        "t": "superlative",
    }
    out: list[tuple[str, str]] = []
    for seg in exchange.split("/"):
        if ":" not in seg:
            continue
        k, v = seg.split(":", 1)
        rel = tag_map.get(k.strip())
        val = v.strip().lower()
        if rel and val and ASCII_WORD_RE.match(val):
            out.append((val, rel))
    return out


def parse_ecdict_senses(raw_def: str) -> list[dict[str, Any]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for line in raw_def.replace("\\n", "\n").splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^([a-z]+)\.\s+(.*)$", line)
        if m:
            pos_raw, text = m.group(1), m.group(2)
            pos = {"n": "noun", "v": "verb", "vt": "verb", "vi": "verb", "a": "adj.", "adj": "adj.", "r": "adv.", "adv": "adv.", "s": "adj."}.get(
                pos_raw, pos_raw + "."
            )
        else:
            pos, text = "def", line
        text = clean_gloss(text, 150)
        if text and len(groups[pos]) < 3 and text not in groups[pos]:
            groups[pos].append(text)
    return [{"pos": p, "defs": d} for p, d in list(groups.items())[:3]]


def load_cedict(path: Path) -> list[dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    entries: list[dict[str, Any]] = []
    line_re = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+/(.+)/\s*$")
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line or line.startswith("#"):
                continue
            m = line_re.match(line.strip())
            if not m:
                continue
            trad, simp, pinyin_num, glosses = m.groups()
            if not HANZI_RE.match(simp) or len(simp) > 6:
                continue
            defs = [
                clean_gloss(g, 120)
                for g in glosses.split("/")
                if g.strip() and not g.strip().startswith("CL:") and not g.strip().startswith("variant of")
            ]
            if not defs:
                continue
            entries.append(
                {
                    "simp": simp,
                    "trad": trad,
                    "pron": numbered_pinyin_to_marked(pinyin_num),
                    "gloss_en": "; ".join(defs[:2])[:96],
                    "defs": defs[:3],
                }
            )
    return entries


def open_text_or_gz(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def parse_en_kaikki(
    path: Path,
    ecdict: dict[str, dict[str, Any]],
    max_lemmas: int = 85_000,
) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]]]:
    """Stream Kaikki EN JSONL and collect ranked canonical lemmas + form_of links."""
    by_lemma: dict[str, dict[str, Any]] = {}
    inflection_links: list[tuple[str, str, str]] = []  # (form_lower, target_lemma_lower, relation)

    with open_text_or_gz(path) as f:
        for line in f:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            word = (obj.get("word") or "").strip()
            if not word or not ASCII_WORD_RE.match(word):
                continue
            low = word.lower()
            pos_raw = obj.get("pos") or ""
            pos = POS_MAP_EN.get(pos_raw)
            if not pos:
                continue

            senses = obj.get("senses") or []
            glosses: list[str] = []
            for s in senses:
                form_of = s.get("form_of") or []
                if form_of:
                    rel = infer_inflection_relation(s.get("tags") or [])
                    for target in form_of:
                        tw = (target.get("word") or "").strip().lower()
                        if tw and tw != low and ASCII_WORD_RE.match(tw):
                            inflection_links.append((low, tw, rel))
                    continue
                for g in s.get("glosses") or []:
                    g = clean_gloss(g, 150)
                    if g and g not in glosses:
                        glosses.append(g)
                    if len(glosses) >= 4:
                        break
                if len(glosses) >= 4:
                    break

            # Also pull explicit forms table on the lemma entry itself
            for fobj in obj.get("forms") or []:
                fw = (fobj.get("form") or "").strip().lower()
                tags = fobj.get("tags") or []
                if (
                    fw
                    and fw != low
                    and ASCII_WORD_RE.match(fw)
                    and "table-tags" not in tags
                    and "inflection-template" not in tags
                    and any(
                        t in tags
                        for t in ("past", "participle", "plural", "third-person", "comparative", "superlative")
                    )
                ):
                    inflection_links.append((fw, low, infer_inflection_relation(tags)))

            if not glosses:
                continue

            ipa = None
            for snd in obj.get("sounds") or []:
                if snd.get("ipa"):
                    ipa = snd["ipa"].strip()
                    break

            rec = by_lemma.get(low)
            if rec is None:
                ec = ecdict.get(low)
                rec = {
                    "lang": "en",
                    "lemma": word if word.islower() else low if ec else word,
                    "pron": ipa or (f"/{ec['phonetic']}/" if ec and ec["phonetic"] else None),
                    "gloss_zh": compact_zh_gloss_from_ecdict(ec["translation"]) if ec else None,
                    "senses_map": defaultdict(list),
                    "rank": ec["rank"] if ec else 9_000_000,
                }
                by_lemma[low] = rec
            if not rec["pron"] and ipa:
                rec["pron"] = ipa
            for g in glosses:
                if len(rec["senses_map"][pos]) < 4 and g not in rec["senses_map"][pos]:
                    rec["senses_map"][pos].append(g)

    # Supplement from ECDICT for frequent lemmas absent from Kaikki
    for low, ec in ecdict.items():
        if low in by_lemma or ec["rank"] > 80_000:
            continue
        senses = parse_ecdict_senses(ec["definition"])
        if not senses:
            continue
        by_lemma[low] = {
            "lang": "en",
            "lemma": ec["word"],
            "pron": f"/{ec['phonetic']}/" if ec["phonetic"] else None,
            "gloss_zh": compact_zh_gloss_from_ecdict(ec["translation"]),
            "senses_map": {s["pos"]: s["defs"] for s in senses},
            "rank": ec["rank"],
        }

    ranked = sorted(by_lemma.items(), key=lambda kv: (kv[1]["rank"], kv[0]))[:max_lemmas]
    kept_keys = {k for k, _ in ranked}
    en_entries: list[dict[str, Any]] = []
    for k, rec in ranked:
        senses_list = [
            {"pos": p, "defs": d[:3]} for p, d in list(rec["senses_map"].items())[:3] if d
        ]
        if not senses_list:
            continue
        en_entries.append(
            {
                "lang": "en",
                "lemma": rec["lemma"],
                "pron": rec["pron"],
                "gloss_en": None,
                "gloss_zh": rec["gloss_zh"],
                "senses": senses_list,
            }
        )
        ec = ecdict.get(k)
        if ec and ec["exchange"]:
            for fw, rel in parse_ecdict_exchange(ec["exchange"]):
                inflection_links.append((fw, k, rel))

    filtered_links = [
        (fw, tw, rel) for fw, tw, rel in inflection_links if tw in kept_keys and fw != tw
    ]
    return en_entries, filtered_links


def infer_inflection_relation(tags: list[str]) -> str:
    tset = set(tags)
    if "past" in tset and "participle" in tset:
        return "past participle"
    if "past" in tset:
        return "past tense"
    if "present" in tset and "participle" in tset:
        return "present participle"
    if "third-person" in tset:
        return "third-person singular"
    if "plural" in tset:
        return "plural"
    if "comparative" in tset:
        return "comparative"
    if "superlative" in tset:
        return "superlative"
    return "inflected form"


def parse_zh_entries(
    zh_kaikki_path: Path | None,
    cedict_path: Path,
    max_entries: int = 75_000,
) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """Merge CC-CEDICT + optional Chinese Kaikki Wiktionary into Simplified canonical ZH entries."""
    cedict_rows = load_cedict(cedict_path)
    by_simp: dict[str, dict[str, Any]] = {}
    trad_map: dict[str, set[str]] = defaultdict(set)

    for row in cedict_rows:
        simp = row["simp"]
        trad = row["trad"]
        if trad != simp:
            trad_map[simp].add(trad)
        if simp not in by_simp:
            pos = "成语" if len(simp) == 4 else "词"
            by_simp[simp] = {
                "lang": "zh",
                "lemma": simp,
                "pron": row["pron"],
                "gloss_en": row["gloss_en"],
                "gloss_zh": None,
                "senses_map": defaultdict(list),
                "cedict_defs": row["defs"],
                "priority": 1 if len(simp) == 4 else (0 if len(simp) == 2 else 2),
            }

    if zh_kaikki_path and zh_kaikki_path.exists():
        with open_text_or_gz(zh_kaikki_path) as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                word = (obj.get("word") or "").strip()
                if not word or not HANZI_RE.match(word) or len(word) > 6:
                    continue
                pos = POS_MAP_ZH.get(obj.get("pos") or "")
                if not pos:
                    continue
                glosses: list[str] = []
                for s in obj.get("senses") or []:
                    for g in s.get("glosses") or []:
                        g = clean_gloss(g, 140)
                        if g and g not in glosses:
                            glosses.append(g)
                        if len(glosses) >= 3:
                            break
                    if len(glosses) >= 3:
                        break
                if not glosses:
                    continue
                rec = by_simp.get(word)
                if rec is None:
                    # Try mapping traditional headword to simplified if forms specify it
                    simp_target = None
                    for fm in obj.get("forms") or []:
                        if "Simplified" in (fm.get("tags") or []):
                            cand = (fm.get("form") or "").strip()
                            if cand in by_simp:
                                simp_target = cand
                                trad_map[cand].add(word)
                                break
                    if simp_target:
                        rec = by_simp[simp_target]
                if rec is not None:
                    rec["priority"] = -1  # boost entries with real definitions
                    for g in glosses:
                        if len(rec["senses_map"][pos]) < 3 and g not in rec["senses_map"][pos]:
                            rec["senses_map"][pos].append(g)

    ranked = sorted(by_simp.items(), key=lambda kv: (kv[1]["priority"], len(kv[0]), kv[0]))[:max_entries]
    zh_entries: list[dict[str, Any]] = []
    trad_links: list[tuple[str, str]] = []
    for simp, rec in ranked:
        senses_list = [
            {"pos": p, "defs": d[:3]} for p, d in list(rec["senses_map"].items())[:2] if d
        ]
        if not senses_list:
            fallback_pos = "成语" if len(simp) == 4 else "词语"
            senses_list = [{"pos": fallback_pos, "defs": rec["cedict_defs"][:2]}]
        zh_entries.append(
            {
                "lang": "zh",
                "lemma": simp,
                "pron": rec["pron"],
                "gloss_en": rec["gloss_en"],
                "gloss_zh": None,
                "senses": senses_list,
            }
        )
        for trad in trad_map.get(simp, ()):
            trad_links.append((trad, simp))

    return zh_entries, trad_links


def build_full(args: argparse.Namespace) -> None:
    cache_dir = Path(args.cache_dir)
    cedict_path = Path(args.cedict) if args.cedict else download_cached(
        URLS["cedict"], cache_dir / "cedict_1_0_ts_utf-8_mdbg.txt.gz"
    )
    if args.ecdict:
        ecdict_path = Path(args.ecdict)
    else:
        try:
            ecdict_path = download_cached(URLS["ecdict_zip"], cache_dir / "ecdict-sqlite-28.zip")
        except Exception as err:
            print(f"Warning: ECDICT release zip unavailable ({err}), falling back to ecdict.csv")
            ecdict_path = download_cached(URLS["ecdict_csv"], cache_dir / "ecdict.mini.csv")

    en_kaikki_path = Path(args.en_kaikki) if args.en_kaikki else None
    if en_kaikki_path is None and not args.skip_kaikki:
        try:
            en_kaikki_path = download_cached(
                URLS["en_kaikki"], cache_dir / "kaikki.org-dictionary-English.jsonl"
            )
        except Exception as err:
            print(f"Warning: EN Kaikki unavailable ({err}), falling back to ECDICT-only English")

    zh_kaikki_path = Path(args.zh_kaikki) if args.zh_kaikki else None
    if zh_kaikki_path is None and not args.skip_kaikki:
        try:
            zh_kaikki_path = download_cached(
                URLS["zh_kaikki"], cache_dir / "kaikki.org-dictionary-Chinese.jsonl"
            )
        except Exception as err:
            print(f"Warning: ZH Kaikki unavailable ({err}), falling back to CC-CEDICT Chinese")

    print("Loading ECDICT…")
    ecdict = load_ecdict(ecdict_path)
    print(f"Loaded {len(ecdict):,} ECDICT headwords")

    en_limit = args.max_en
    zh_limit = args.max_zh

    if en_kaikki_path and en_kaikki_path.exists():
        print(f"Parsing EN Kaikki ({en_kaikki_path})…")
        en_entries, en_links = parse_en_kaikki(en_kaikki_path, ecdict, max_lemmas=en_limit)
    else:
        print("Building EN entries from ECDICT…")
        ranked_ec = sorted(ecdict.items(), key=lambda kv: (kv[1]["rank"], kv[0]))[:en_limit]
        kept = {k for k, _ in ranked_ec}
        en_entries = []
        en_links = []
        for k, ec in ranked_ec:
            senses = parse_ecdict_senses(ec["definition"])
            if not senses:
                continue
            en_entries.append(
                {
                    "lang": "en",
                    "lemma": ec["word"],
                    "pron": f"/{ec['phonetic']}/" if ec["phonetic"] else None,
                    "gloss_en": None,
                    "gloss_zh": compact_zh_gloss_from_ecdict(ec["translation"]),
                    "senses": senses,
                }
            )
            for fw, rel in parse_ecdict_exchange(ec["exchange"]):
                if fw != k:
                    en_links.append((fw, k, rel))
        en_links = [(fw, tw, rel) for fw, tw, rel in en_links if tw in kept]

    print(f"Prepared {len(en_entries):,} EN entries and {len(en_links):,} EN form links")

    print(f"Parsing ZH entries ({cedict_path})…")
    zh_entries, zh_trad_links = parse_zh_entries(zh_kaikki_path, cedict_path, max_entries=zh_limit)
    print(f"Prepared {len(zh_entries):,} ZH entries and {len(zh_trad_links):,} traditional mappings")

    # Assemble entries + forms with automatic trim loop if > 20 MB
    out_path = Path(args.output)
    scale = 1.0
    for attempt in range(4):
        cur_en = en_entries[: int(len(en_entries) * scale)]
        cur_zh = zh_entries[: int(len(zh_entries) * scale)]
        all_entries = cur_en + cur_zh
        en_id_by_lower: dict[str, int] = {}
        zh_id_by_lemma: dict[str, int] = {}
        forms: list[tuple[str, str, int, int, str | None]] = []

        for idx, e in enumerate(all_entries, start=1):
            if e["lang"] == "en":
                low = e["lemma"].lower()
                en_id_by_lower[low] = idx
                forms.append((low, "en", idx, 1, None))
            else:
                zh_id_by_lemma[e["lemma"]] = idx
                forms.append((e["lemma"], "zh", idx, 1, None))

        for fw, tw, rel in en_links:
            eid = en_id_by_lower.get(tw)
            if eid is not None:
                forms.append((fw, "en", eid, 0, rel))
        for trad, simp in zh_trad_links:
            eid = zh_id_by_lemma.get(simp)
            if eid is not None:
                forms.append((trad, "zh", eid, 0, "traditional"))

        write_sqlite_db(
            out_path,
            all_entries,
            forms,
            compress=True,
            built_at="open-build-v1",
        )
        size = out_path.stat().st_size
        if size <= MAX_TARGET_BYTES:
            return
        scale *= (MAX_TARGET_BYTES * 0.92) / size
        print(f"Output {size / (1024 * 1024):.2f} MB exceeds 20 MB cap; scaling to {scale:.2f} (attempt {attempt + 2})")

    if out_path.stat().st_size > MAX_TARGET_BYTES:
        sys.exit(f"Error: dict.db ({out_path.stat().st_size} bytes) still exceeds 20 MB cap")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Quill offline dictionary SQLite DB")
    parser.add_argument("--fixture", action="store_true", help="Build deterministic dict-test.db fixture")
    parser.add_argument("--output", "-o", type=str, default=None, help="Output SQLite file path")
    parser.add_argument("--cache-dir", type=str, default=str(DEFAULT_CACHE))
    parser.add_argument("--en-kaikki", type=str, default=None)
    parser.add_argument("--ecdict", type=str, default=None)
    parser.add_argument("--zh-kaikki", type=str, default=None)
    parser.add_argument("--cedict", type=str, default=None)
    parser.add_argument("--skip-kaikki", action="store_true", help="Skip large Kaikki downloads (use ECDICT + CC-CEDICT)")
    parser.add_argument("--max-en", type=int, default=85_000)
    parser.add_argument("--max-zh", type=int, default=70_000)
    args = parser.parse_args()

    if args.fixture:
        out = Path(args.output) if args.output else FIXTURE_OUT
        build_fixture(out)
    else:
        if args.output is None:
            args.output = str(DEFAULT_OUT)
        build_full(args)


if __name__ == "__main__":
    main()
