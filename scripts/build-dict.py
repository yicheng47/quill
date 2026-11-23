#!/usr/bin/env python3
"""
Build Quill's read-only offline dictionary SQLite database (`dict.db`) or
the checked-in deterministic test fixture (`dict-test.db`).

Data sources & licenses (open, redistributable, checksummed in scripts/dict-sources.json):
  - English Wiktionary via kaikki.org wiktextract (CC-BY-SA 4.0)
  - ECDICT 1.0.28 (MIT) — English->Chinese brief glosses and word-frequency ranking
  - Chinese-edition Wiktionary via kaikki.org/zhwiktionary wiktextract (CC-BY-SA 4.0)
  - CC-CEDICT (CC-BY-SA 4.0) — Simplified/Traditional headwords, pinyin, EN glosses

Usage:
  # Regenerate the checked-in deterministic test fixture (~32 KB):
  python3 scripts/build-dict.py --fixture

  # Download verified sources (cached) and build full <= 20 MB dict.db:
  python3 scripts/build-dict.py

  # Verify an existing production dict.db:
  python3 scripts/build-dict.py --verify crates/quill-core/resources/dict.db
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
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
SOURCES_MANIFEST = Path(__file__).resolve().parent / "dict-sources.json"

MAX_TARGET_BYTES = 20 * 1024 * 1024  # 20 MB hard cap
PARTICIPIAL_ADJ_RELATION = "participial adjective"
PARTICIPIAL_ADJ_CODE = "a"

RELATION_TO_CODE = {
    "traditional": "t",
    "past tense": "p",
    "past participle": "d",
    "present participle": "i",
    "third-person singular": "3",
    "plural": "s",
    "comparative": "r",
    "superlative": "u",
    "participial adjective": "a",
    "inflected form": "f",
}

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
    "character": "字",
}

HANZI_RE = re.compile(r"^[\u3400-\u4dbf\u4e00-\u9fff]+$")
HANZI_ANY_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
HANZI_TOKEN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]{1,6}")
ASCII_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'-]{0,39}$")
ASCII_LETTER_RE = re.compile(r"[A-Za-z]")


def load_sources_manifest() -> dict[str, Any]:
    with open(SOURCES_MANIFEST, "r", encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


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
        '{"p":"/","gz":"'
        '","s":[["noun",["'
        '","s":[["verb",["'
        '","s":[["adj.",["'
        '","s":[["adv.",["'
        '","s":[["prep.",["'
        '","s":[["成语",["'
        '","s":[["名词",["'
        '","s":[["动词",["'
        '","s":[["形容词",["'
        '","s":[["副词",["'
        '"]]],'
        '"],"f":["'
        '","ge":"'
        '","cw":1}'
        '","ci":1}'
        '","cw":1,"f":["'
        '","ci":1,"f":["'
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
    step = max(1, len(sample_payloads) // 450)
    for payload in sample_payloads[::step]:
        if len(buf) + len(payload) > 32768:
            break
        buf.extend(payload)
    return bytes(buf[-32768:])


def compress_senses(raw_json: bytes, zdict: bytes | None) -> bytes:
    if zdict is None:
        return raw_json
    c = zlib.compressobj(level=9, wbits=-15, zdict=zdict)
    compressed = c.compress(raw_json) + c.flush()
    if len(compressed) + 1 < len(raw_json):
        return b"\x02" + compressed
    return raw_json


def decompress_entry_payload(
    raw: bytes | str,
    zdict: bytes | None,
    col_pron: str | None = None,
    col_gloss_en: str | None = None,
    col_gloss_zh: str | None = None,
) -> dict[str, Any]:
    if isinstance(raw, str):
        parsed = json.loads(raw)
    elif not raw:
        parsed = []
    elif raw[0] in (ord("["), ord("{")):
        parsed = json.loads(raw.decode("utf-8"))
    elif raw[0] == 0x02:
        if zdict is None:
            raise ValueError("Missing senses_zdict metadata")
        d = zlib.decompressobj(wbits=-15, zdict=zdict)
        parsed = json.loads((d.decompress(raw[1:]) + d.flush()).decode("utf-8"))
    elif raw[0] == 0x01:
        d = zlib.decompressobj(wbits=-15)
        parsed = json.loads((d.decompress(raw[1:]) + d.flush()).decode("utf-8"))
    else:
        parsed = json.loads(zlib.decompress(raw).decode("utf-8"))

    if isinstance(parsed, dict):
        ge = parsed.get("ge", col_gloss_en)
        gz = parsed.get("gz", col_gloss_zh)
        pron = parsed.get("p", col_pron)
        if "s" in parsed:
            senses = [{"pos": g[0], "defs": g[1]} for g in parsed["s"]]
        elif parsed.get("ci") == 1 or parsed.get("cw") == 1:
            pos = "成语" if parsed.get("ci") == 1 else "词语"
            senses = [{"pos": pos, "defs": [ge]}] if ge else []
        else:
            senses = []
        return {
            "pron": pron,
            "senses": senses,
            "gloss_en": ge,
            "gloss_zh": gz,
            "forms": parsed.get("f") or [],
        }

    return {
        "pron": col_pron,
        "senses": parsed,
        "gloss_en": col_gloss_en,
        "gloss_zh": col_gloss_zh,
        "forms": [],
    }


def decompress_senses(raw: bytes | str, zdict: bytes | None) -> list[dict[str, Any]]:
    return decompress_entry_payload(raw, zdict)["senses"]


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

    # Deduplicate forms preserving is_lemma=1 first
    seen_forms: set[tuple[str, str, int]] = set()
    deduped_forms: list[tuple[str, str, int, int, str | None]] = []
    extra_forms_by_eid: dict[int, list[str]] = defaultdict(list)
    for form, lang, entry_id, is_lemma, relation in sorted(
        forms, key=lambda r: (r[1], r[0], -r[3], r[2])
    ):
        k = (form, lang, entry_id)
        if k in seen_forms:
            continue
        seen_forms.add(k)
        stored_rel = (
            RELATION_TO_CODE.get(relation, relation) if (compress and relation) else relation
        )
        deduped_forms.append((form, lang, entry_id, is_lemma, stored_rel))
        if compress and is_lemma == 0:
            lemma_str = entries[entry_id - 1]["lemma"]
            if lang == "zh" or not is_regular_suffix_form(form, lemma_str.lower()):
                if form not in extra_forms_by_eid[entry_id]:
                    extra_forms_by_eid[entry_id].append(form)

    serialized: list[bytes] = []
    for idx, e in enumerate(entries, start=1):
        if compress:
            obj: dict[str, Any] = {}
            if e.get("pron"):
                obj["p"] = e["pron"]
            if e.get("gloss_en"):
                obj["ge"] = e["gloss_en"]
            if e.get("gloss_zh"):
                obj["gz"] = e["gloss_zh"]
            senses = e["senses"]
            if (
                e["lang"] == "zh"
                and len(senses) == 1
                and senses[0]["pos"] in ("词语", "成语")
                and len(senses[0]["defs"]) == 1
                and e.get("gloss_en")
                and senses[0]["defs"][0] == e["gloss_en"]
            ):
                obj["ci" if senses[0]["pos"] == "成语" else "cw"] = 1
            else:
                obj["s"] = [[g["pos"], g["defs"]] for g in senses]
            xf = extra_forms_by_eid.get(idx)
            if xf:
                obj["f"] = xf
            serialized.append(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        else:
            serialized.append(
                json.dumps(e["senses"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            )

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
                relation TEXT,
                PRIMARY KEY (form, lang, entry_id)
            ) WITHOUT ROWID;
            """
        )

        meta_rows: list[tuple[str, bytes]] = [
            ("schema_version", b"2" if compress else b"1"),
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
            if compress:
                payload = compress_senses(serialized[idx - 1], zdict)
                entry_rows.append((idx, e["lang"], e["lemma"], None, payload, None, None))
            else:
                entry_rows.append(
                    (
                        idx,
                        e["lang"],
                        e["lemma"],
                        e.get("pron"),
                        serialized[idx - 1].decode("utf-8"),
                        e.get("gloss_en"),
                        e.get("gloss_zh"),
                    )
                )
        conn.executemany(
            "INSERT INTO entries(id, lang, lemma, pron, senses_json, gloss_en, gloss_zh) VALUES (?, ?, ?, ?, ?, ?, ?)",
            entry_rows,
        )

        conn.executemany(
            "INSERT INTO forms(form, lang, entry_id, is_lemma, relation) VALUES (?, ?, ?, ?, ?)",
            deduped_forms,
        )
        if not compress:
            conn.execute("CREATE INDEX idx_forms_entry_id ON forms(entry_id);")
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
                    "defs": [
                        "On, toward, or relating to the side of a human body or of a thing that is to the west when facing north."
                    ],
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
                    "defs": [
                        "A hand tool for cutting wood or other hard materials, typically with a serrated metal blade."
                    ],
                }
            ],
            "forms": [("saws", "plural")],
        },
        {
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


def download_verified(
    url: str,
    dest: Path,
    expected_sha256: str | None,
    *,
    verify_checksum: bool = True,
) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        if verify_checksum and expected_sha256:
            actual = sha256_file(dest)
            if actual == expected_sha256:
                print(f"Using verified cached {dest}")
                return dest
            print(
                f"Cached {dest} checksum mismatch ({actual[:12]} != {expected_sha256[:12]}); re-downloading"
            )
        else:
            print(f"Using cached {dest}")
            return dest

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"Downloading {url} -> {dest}")
    req = urllib.request.Request(url, headers={"User-Agent": "Quill-Dict-Builder/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, dest)

    if verify_checksum and expected_sha256:
        actual = sha256_file(dest)
        if actual != expected_sha256:
            raise RuntimeError(
                f"Checksum mismatch for {dest.name}: expected {expected_sha256}, got {actual}. "
                f"Upstream file may have changed; update scripts/dict-sources.json after reviewing the new dump."
            )
    return dest


def load_ecdict(path: Path) -> dict[str, dict[str, Any]]:
    """Load ECDICT CSV or SQLite (inside zip) -> {word_lower: {zh, pron, rank, exchange, defs}}."""
    result: dict[str, dict[str, Any]] = {}
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as zf:
            db_names = [n for n in zf.namelist() if n.endswith(".db")]
            if not db_names:
                raise RuntimeError(f"No .db file found inside ECDICT zip {path}")
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
            pos = {
                "n": "noun",
                "v": "verb",
                "vt": "verb",
                "vi": "verb",
                "a": "adj.",
                "adj": "adj.",
                "r": "adv.",
                "adv": "adv.",
                "s": "adj.",
            }.get(pos_raw, pos_raw + ".")
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
            raw_parts = [g.strip() for g in glosses.split("/") if g.strip()]
            is_idiom = any("(idiom)" in g.lower() for g in raw_parts)
            defs = [
                clean_gloss(g, 120)
                for g in raw_parts
                if not g.startswith("CL:") and not g.startswith("variant of")
            ]
            if not defs:
                continue
            entries.append(
                {
                    "simp": simp,
                    "trad": trad,
                    "pron": numbered_pinyin_to_marked(pinyin_num),
                    "gloss_en": "; ".join(defs[:2])[:64],
                    "defs": defs[:2],
                    "is_idiom": is_idiom,
                }
            )
    return entries


def open_text_or_gz(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


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


def parse_en_kaikki(
    path: Path,
    ecdict: dict[str, dict[str, Any]],
    max_lemmas: int = 85_000,
) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]], set[str]]:
    """
    Stream Kaikki EN JSONL and collect ranked canonical lemmas, form_of links,
    and participial-only adjective headwords whose canonical lemma is a kept verb.
    """
    by_lemma: dict[str, dict[str, Any]] = {}
    inflection_links: list[tuple[str, str, str]] = []
    verb_participle_targets: dict[str, set[str]] = defaultdict(set)

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
            modern_glosses: list[str] = []
            dated_glosses: list[str] = []
            for s in senses:
                tags = s.get("tags") or []
                form_of = s.get("form_of") or []
                if form_of:
                    rel = infer_inflection_relation(tags)
                    for target in form_of:
                        tw = (target.get("word") or "").strip().lower()
                        if tw and tw != low and ASCII_WORD_RE.match(tw):
                            inflection_links.append((low, tw, rel))
                            if pos_raw == "verb" or "participle" in tags or "past" in tags:
                                verb_participle_targets[low].add(tw)
                    continue
                is_dated = any(t in tags for t in ("obsolete", "archaic", "historical"))
                bucket = dated_glosses if is_dated else modern_glosses
                for g in s.get("glosses") or []:
                    g = clean_gloss(g, 120)
                    if g and g not in modern_glosses and g not in dated_glosses:
                        bucket.append(g)
                    if len(modern_glosses) >= 4:
                        break
            glosses = (modern_glosses + dated_glosses)[:4]

            # Pull explicit forms table on the lemma entry itself
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
                        for t in (
                            "past",
                            "participle",
                            "plural",
                            "third-person",
                            "comparative",
                            "superlative",
                        )
                    )
                ):
                    rel = infer_inflection_relation(tags)
                    inflection_links.append((fw, low, rel))
                    if pos_raw == "verb" and ("participle" in tags or "past" in tags):
                        verb_participle_targets[fw].add(low)

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

    # Supplement from ECDICT for frequent lemmas absent from Kaikki, skipping
    # forms that Kaikki already linked as inflections or that ECDICT marks with
    # a `0:<lemma>` inflection pointer (e.g. `children` -> `0:child`).
    inflected_forms_set = {fw for fw, _, _ in inflection_links}
    for low, ec in ecdict.items():
        if low in by_lemma or ec["rank"] > 80_000:
            continue
        if low in inflected_forms_set:
            continue
        if any(seg.startswith("0:") for seg in ec["exchange"].split("/")):
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
    participial_adjs: set[str] = set()

    for idx_rank, (k, rec) in enumerate(ranked):
        max_pos = 3 if idx_rank < 12_000 else 2
        max_defs = 3 if idx_rank < 12_000 else (2 if idx_rank < 25_000 else 1)
        senses_list = [
            {"pos": p, "defs": d[:max_defs]}
            for p, d in list(rec["senses_map"].items())[:max_pos]
            if d
        ]
        if not senses_list:
            continue
        pos_set = {s["pos"] for s in senses_list}
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
                if rel in ("past tense", "past participle", "present participle"):
                    verb_participle_targets[fw].add(k)

        # Participial -ed/-ing adjectives (including those with a secondary
        # verbal-noun/gerund sense like `mortifying`) whose base verb (`mortify`)
        # is in the kept lemma set resolve to the verb lemma first, while true
        # independent homographs (`left` adj/adv/noun, `saw` noun/verb,
        # `building` noun, `meeting` noun) keep primary lemma priority.
        if (
            k.endswith(("ed", "ing"))
            and "adj." in pos_set
            and pos_set <= {"adj.", "noun"}
            and any(t in kept_keys and t != k for t in verb_participle_targets.get(k, ()))
        ):
            participial_adjs.add(k)

    # Keep all explicit inflections for the top 15k English lemmas, all irregular
    # forms, and every inflection whose surface form is itself a kept lemma
    # (homographs & participial adjectives). For rare long-tail lemmas (>15k),
    # omit trivial regular -s/-ed/-ing/-es suffixes that builtin.rs's indexed
    # suffix fallback already resolves.
    top_en_keys = {k for k, _ in ranked[:15_000]}
    filtered_links = []
    for fw, tw, rel in inflection_links:
        if tw not in kept_keys or fw == tw:
            continue
        if tw not in top_en_keys and fw not in kept_keys and is_regular_suffix_form(fw, tw):
            continue
        filtered_links.append((fw, tw, rel))
    return en_entries, filtered_links, participial_adjs


def is_regular_suffix_form(form: str, lemma: str) -> bool:
    if form == lemma + "s" or form == lemma + "es" or form == lemma + "ed" or form == lemma + "ing":
        return True
    if lemma.endswith("e") and (form == lemma + "d" or form == lemma[:-1] + "ing"):
        return True
    if lemma.endswith("y") and (form == lemma[:-1] + "ies" or form == lemma[:-1] + "ied"):
        return True
    return False


def extract_zh_categories(obj: dict[str, Any], senses: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for raw in obj.get("categories") or []:
        if isinstance(raw, str):
            names.append(raw)
        elif isinstance(raw, dict) and raw.get("name"):
            names.append(str(raw["name"]))
    for s in senses:
        for raw in s.get("categories") or []:
            if isinstance(raw, str):
                names.append(raw)
            elif isinstance(raw, dict) and raw.get("name"):
                names.append(str(raw["name"]))
    return names


def infer_zh_pos(
    pos_raw: str,
    entry_tags: list[str],
    sense_tags: list[str],
    categories: list[str],
) -> str | None:
    if (
        pos_raw == "idiom"
        or "idiomatic" in entry_tags
        or "idiomatic" in sense_tags
        or any("成語" in c or "成语" in c for c in categories)
    ):
        return "成语"
    return POS_MAP_ZH.get(pos_raw)


def is_cedict_proper_or_variant(gloss_en: str) -> bool:
    low = gloss_en.lower()
    return (
        low.startswith(
            (
                "surname ",
                "variant of ",
                "old variant of ",
                "see ",
                "abbr. for ",
                "also written ",
            )
        )
        or "county in " in low
        or "district in " in low
        or "township in " in low
        or "prefecture" in low
        or "autonomous region" in low
    )


def extract_ecdict_zh_ranks(ecdict: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Derive modern Chinese usage-frequency ranks from ECDICT's EN->ZH translations."""
    zh_ranks: dict[str, int] = {}
    for rec in ecdict.values():
        trans = rec.get("translation")
        if not trans:
            continue
        rank = rec["rank"]
        for tok in HANZI_TOKEN_RE.findall(trans):
            prev = zh_ranks.get(tok)
            if prev is None or rank < prev:
                zh_ranks[tok] = rank
    return zh_ranks


def parse_zh_entries(
    zh_kaikki_path: Path,
    cedict_path: Path,
    max_entries: int = 63_000,
    zh_freq_ranks: dict[str, int] | None = None,
) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """
    Merge CC-CEDICT + Chinese-edition Kaikki Wiktionary (zhwiktionary) into
    Simplified canonical ZH entries with Chinese definitions, upstream idiom
    metadata, Traditional->Simplified links, and separate English glosses.
    """
    cedict_rows = load_cedict(cedict_path)
    zh_freq_ranks = zh_freq_ranks or {}
    by_simp: dict[str, dict[str, Any]] = {}
    trad_to_simp: dict[str, str] = {}
    trad_map: dict[str, set[str]] = defaultdict(set)
    char_freq: dict[str, int] = defaultdict(int)

    for row in cedict_rows:
        simp = row["simp"]
        trad = row["trad"]
        for ch in simp:
            char_freq[ch] += 1
        if trad != simp:
            trad_map[simp].add(trad)
            trad_to_simp.setdefault(trad, simp)
        if simp not in by_simp:
            is_proper = is_cedict_proper_or_variant(row["gloss_en"])
            ec_rank = zh_freq_ranks.get(simp, 10_000_000)
            if row["is_idiom"]:
                prio = 1
            elif not is_proper and len(simp) <= 4 and ec_rank < 10_000_000:
                prio = 2
            elif not is_proper and len(simp) <= 4:
                prio = 3
            else:
                prio = 4
            by_simp[simp] = {
                "lang": "zh",
                "lemma": simp,
                "pron": row["pron"],
                "gloss_en": row["gloss_en"],
                "gloss_zh": None,
                "senses_map": defaultdict(list),
                "cedict_defs": row["defs"],
                "cedict_is_idiom": row["is_idiom"],
                "priority": prio,
                "ec_rank": ec_rank,
            }
        elif row["is_idiom"]:
            by_simp[simp]["cedict_is_idiom"] = True
            if by_simp[simp]["priority"] > 1:
                by_simp[simp]["priority"] = 1

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

            senses = obj.get("senses") or []
            entry_tags = [str(t) for t in (obj.get("tags") or [])]
            sense_tags: list[str] = []
            glosses: list[str] = []
            for s in senses:
                if s.get("form_of") or s.get("alt_of"):
                    continue
                st = [str(t) for t in (s.get("tags") or [])]
                sense_tags.extend(st)
                for g in s.get("glosses") or []:
                    g = clean_gloss(g, 110)
                    # Require Chinese-edition definitions (must contain Hanzi)
                    if g and HANZI_ANY_RE.search(g) and g not in glosses:
                        glosses.append(g)
                    if len(glosses) >= 3:
                        break
                if len(glosses) >= 3:
                    break
            if not glosses:
                continue

            categories = extract_zh_categories(obj, senses)
            pos = infer_zh_pos(
                (obj.get("pos") or "").strip().lower(),
                entry_tags,
                sense_tags,
                categories,
            )
            if not pos:
                continue

            # Resolve Traditional or Simplified headword to canonical Simplified entry
            rec = by_simp.get(word)
            if rec is None:
                mapped_simp = trad_to_simp.get(word)
                if mapped_simp and mapped_simp in by_simp:
                    rec = by_simp[mapped_simp]
                    trad_map[mapped_simp].add(word)

            if rec is None:
                for fm in obj.get("forms") or []:
                    ftags = [str(t).lower() for t in (fm.get("tags") or [])]
                    if any("simplified" in t for t in ftags):
                        cand = (fm.get("form") or "").strip()
                        if cand in by_simp:
                            rec = by_simp[cand]
                            if word != cand:
                                trad_map[cand].add(word)
                            break

            if rec is not None:
                # Prioritize entries backed by real Chinese Wiktionary senses
                rec["priority"] = -2 if pos == "成语" else (-1 if len(rec["lemma"]) <= 4 else 0)
                for g in glosses:
                    if len(rec["senses_map"][pos]) < 3 and g not in rec["senses_map"][pos]:
                        rec["senses_map"][pos].append(g)

    def zh_sort_key(kv: tuple[str, dict[str, Any]]) -> tuple[int, int, int, int, str]:
        simp, rec = kv
        avg_char_freq = sum(char_freq.get(ch, 0) for ch in simp) // max(1, len(simp))
        return (rec["priority"], rec["ec_rank"], -avg_char_freq, len(simp), simp)

    ranked = sorted(by_simp.items(), key=zh_sort_key)[:max_entries]
    zh_entries: list[dict[str, Any]] = []
    trad_links: list[tuple[str, str]] = []
    for idx_rank, (simp, rec) in enumerate(ranked):
        max_defs = 2 if idx_rank < 12_000 else 1
        senses_list = [
            {"pos": p, "defs": d[:max_defs]}
            for p, d in list(rec["senses_map"].items())[: (2 if idx_rank < 12_000 else 1)]
            if d
        ]
        if not senses_list:
            fallback_pos = "成语" if rec["cedict_is_idiom"] else "词语"
            senses_list = [{"pos": fallback_pos, "defs": [rec["gloss_en"] or rec["cedict_defs"][0]]}]
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
        for trad in sorted(trad_map.get(simp, ())):
            if trad != simp:
                trad_links.append((trad, simp))

    return zh_entries, trad_links


def assemble_and_write_production_db(
    out_path: Path,
    en_entries: list[dict[str, Any]],
    en_links: list[tuple[str, str, str]],
    participial_adjs: set[str],
    zh_entries: list[dict[str, Any]],
    zh_trad_links: list[tuple[str, str]],
    *,
    built_at: str,
) -> None:
    scale = 1.0
    for attempt in range(5):
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
                rel = PARTICIPIAL_ADJ_RELATION if low in participial_adjs else None
                forms.append((low, "en", idx, 1, rel))
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
            built_at=built_at,
        )
        size = out_path.stat().st_size
        if size <= MAX_TARGET_BYTES:
            return
        scale *= (MAX_TARGET_BYTES * 0.96) / size
        print(
            f"Output {size / (1024 * 1024):.2f} MB exceeds 20 MB cap; "
            f"scaling to {scale:.2f} (attempt {attempt + 2})"
        )

    if out_path.stat().st_size > MAX_TARGET_BYTES:
        sys.exit(f"Error: dict.db ({out_path.stat().st_size} bytes) still exceeds 20 MB cap")


def verify_production_db(db_path: Path, *, min_en: int = 80_000, min_zh: int = 60_000) -> None:
    if not db_path.exists():
        raise RuntimeError(f"Dictionary DB not found: {db_path}")
    size = db_path.stat().st_size
    if size > MAX_TARGET_BYTES:
        raise RuntimeError(f"Dictionary DB exceeds 20 MB cap: {size:,} bytes")
    if min_en >= 1000 and size < 1_000_000:
        raise RuntimeError(f"Dictionary DB looks like a test fixture ({size:,} bytes)")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        zdict_row = conn.execute("SELECT value FROM meta WHERE key = 'senses_zdict'").fetchone()
        zdict = bytes(zdict_row[0]) if zdict_row else None

        en_count = conn.execute("SELECT COUNT(*) FROM entries WHERE lang = 'en'").fetchone()[0]
        zh_count = conn.execute("SELECT COUNT(*) FROM entries WHERE lang = 'zh'").fetchone()[0]
        if en_count < min_en:
            raise RuntimeError(f"Too few EN entries: {en_count:,} < {min_en:,}")
        if zh_count < min_zh:
            raise RuntimeError(f"Too few ZH entries: {zh_count:,} < {min_zh:,}")

        def lookup_en(term: str):
            rows = conn.execute(
                """
                SELECT f.entry_id, f.is_lemma, f.relation, e.lemma, e.pron, e.senses_json, e.gloss_zh
                FROM forms f
                JOIN entries e ON e.id = f.entry_id
                WHERE f.form = ? AND f.lang = 'en'
                ORDER BY
                  CASE
                    WHEN f.is_lemma = 1 AND COALESCE(f.relation, '') NOT IN (?, ?) THEN 0
                    WHEN f.is_lemma = 0 THEN 1
                    ELSE 2
                  END ASC,
                  f.entry_id ASC
                """,
                (term.lower(), PARTICIPIAL_ADJ_RELATION, PARTICIPIAL_ADJ_CODE),
            ).fetchall()
            if not rows:
                raise RuntimeError(f"Missing EN lookup for {term!r}")
            primary = rows[0]
            decoded = decompress_entry_payload(
                primary[5], zdict, col_pron=primary[4], col_gloss_zh=primary[6]
            )
            alts = [r[3] for r in rows[1:] if r[3].lower() != term.lower()]
            return {
                "lemma": primary[3],
                "is_lemma": primary[1],
                "pron": decoded["pron"],
                "senses": decoded["senses"],
                "gloss_zh": decoded["gloss_zh"],
                "alternates": alts,
            }

        def lookup_zh(term: str):
            rows = conn.execute(
                """
                SELECT f.entry_id, f.is_lemma, e.lemma, e.pron, e.senses_json, e.gloss_en
                FROM forms f
                JOIN entries e ON e.id = f.entry_id
                WHERE f.form = ? AND f.lang = 'zh'
                ORDER BY f.is_lemma DESC, f.entry_id ASC
                """,
                (term,),
            ).fetchall()
            if not rows:
                raise RuntimeError(f"Missing ZH lookup for {term!r}")
            primary = rows[0]
            decoded = decompress_entry_payload(
                primary[4], zdict, col_pron=primary[3], col_gloss_en=primary[5]
            )
            return {
                "lemma": primary[2],
                "is_lemma": primary[1],
                "pron": decoded["pron"],
                "senses": decoded["senses"],
                "gloss_en": decoded["gloss_en"],
            }

        # Verify participial lemmatization (mortified / mortifying -> mortify)
        for form in ("mortified", "mortifying"):
            r = lookup_en(form)
            if r["lemma"] != "mortify" or r["is_lemma"] != 0:
                raise RuntimeError(f"Expected {form!r} -> 'mortify' (inflected), got {r}")
            if not r["senses"] or not r["gloss_zh"]:
                raise RuntimeError(f"Expected senses + gloss_zh for 'mortify', got {r}")

        # Verify independent homographs (left -> left + alt leave; saw -> saw + alt see)
        left = lookup_en("left")
        if left["lemma"] != "left" or "leave" not in left["alternates"]:
            raise RuntimeError(f"Expected 'left' primary with alt 'leave', got {left}")
        saw = lookup_en("saw")
        if saw["lemma"] != "saw" or "see" not in saw["alternates"]:
            raise RuntimeError(f"Expected 'saw' primary with alt 'see', got {saw}")

        if min_en >= 1000:
            for form, expected in (("went", "go"), ("ran", "run"), ("children", "child")):
                r = lookup_en(form)
                if r["lemma"] != expected:
                    raise RuntimeError(f"Expected {form!r} -> {expected!r}, got {r}")
            better = lookup_en("better")
            if better["lemma"] != "good" and "good" not in better["alternates"]:
                raise RuntimeError(f"Expected 'better' to link to 'good', got {better}")
            for form in ("计算机", "計算機"):
                comp = lookup_zh(form)
                if comp["lemma"] != "计算机" or not comp["gloss_en"] or "computer" not in comp["gloss_en"].lower():
                    raise RuntimeError(f"Expected {form!r} -> '计算机' (computer), got {comp}")

        # Verify Chinese idiom (Simplified + Traditional) has Chinese sense, 成语, and EN gloss
        for form in ("潜移默化", "潛移默化"):
            r = lookup_zh(form)
            if r["lemma"] != "潜移默化":
                raise RuntimeError(f"Expected {form!r} -> '潜移默化', got {r}")
            if not r["senses"] or r["senses"][0]["pos"] != "成语":
                raise RuntimeError(f"Expected 成语 POS for {form!r}, got {r}")
            first_def = r["senses"][0]["defs"][0]
            if not HANZI_ANY_RE.search(first_def):
                raise RuntimeError(f"Expected Chinese definition for {form!r}, got {first_def!r}")
            if not r["gloss_en"] or not ASCII_LETTER_RE.search(r["gloss_en"]):
                raise RuntimeError(f"Expected separate English gloss for {form!r}, got {r}")

        print(
            f"Verified {db_path}: {size / (1024 * 1024):.2f} MB, "
            f"{en_count:,} EN entries, {zh_count:,} ZH entries, all acceptance checks passed."
        )
    finally:
        conn.close()


def build_full(args: argparse.Namespace) -> None:
    manifest = load_sources_manifest()
    sources = manifest["sources"]
    cache_dir = Path(args.cache_dir)
    verify_ck = not args.skip_checksum

    def resolve_source(arg_val: str | None, key: str) -> Path:
        if arg_val:
            p = Path(arg_val)
            if not p.exists():
                raise RuntimeError(f"Specified {key} file does not exist: {p}")
            return p
        spec = sources[key]
        return download_verified(
            spec["url"],
            cache_dir / spec["filename"],
            spec.get("sha256"),
            verify_checksum=verify_ck,
        )

    en_kaikki_path = resolve_source(args.en_kaikki, "en_kaikki")
    zh_kaikki_path = resolve_source(args.zh_kaikki, "zh_kaikki")
    ecdict_path = resolve_source(args.ecdict, "ecdict_zip")
    cedict_path = resolve_source(args.cedict, "cedict")

    print("Loading ECDICT…")
    ecdict = load_ecdict(ecdict_path)
    print(f"Loaded {len(ecdict):,} ECDICT headwords")

    print(f"Parsing EN Kaikki ({en_kaikki_path})…")
    en_entries, en_links, participial_adjs = parse_en_kaikki(
        en_kaikki_path, ecdict, max_lemmas=args.max_en
    )
    print(
        f"Prepared {len(en_entries):,} EN entries, {len(en_links):,} EN form links, "
        f"{len(participial_adjs):,} participial-only adjectives"
    )

    print(f"Parsing ZH Wiktionary + CC-CEDICT ({zh_kaikki_path}, {cedict_path})…")
    zh_freq_ranks = extract_ecdict_zh_ranks(ecdict)
    zh_entries, zh_trad_links = parse_zh_entries(
        zh_kaikki_path, cedict_path, max_entries=args.max_zh, zh_freq_ranks=zh_freq_ranks
    )
    print(
        f"Prepared {len(zh_entries):,} ZH entries and {len(zh_trad_links):,} traditional mappings"
    )

    out_path = Path(args.output)
    assemble_and_write_production_db(
        out_path,
        en_entries,
        en_links,
        participial_adjs,
        zh_entries,
        zh_trad_links,
        built_at=manifest.get("version", "open-build-v1"),
    )

    # Run acceptance checks automatically on full default builds
    if not (args.en_kaikki or args.zh_kaikki or args.ecdict or args.cedict):
        verify_production_db(out_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Quill offline dictionary SQLite DB")
    parser.add_argument(
        "--fixture", action="store_true", help="Build deterministic dict-test.db fixture"
    )
    parser.add_argument(
        "--verify", type=str, default=None, help="Verify an existing production dict.db"
    )
    parser.add_argument("--output", "-o", type=str, default=None, help="Output SQLite file path")
    parser.add_argument("--cache-dir", type=str, default=str(DEFAULT_CACHE))
    parser.add_argument("--en-kaikki", type=str, default=None)
    parser.add_argument("--ecdict", type=str, default=None)
    parser.add_argument("--zh-kaikki", type=str, default=None)
    parser.add_argument("--cedict", type=str, default=None)
    parser.add_argument(
        "--skip-checksum",
        action="store_true",
        help="Skip SHA-256 verification against scripts/dict-sources.json (for manual refreshes only)",
    )
    parser.add_argument("--max-en", type=int, default=83_000)
    parser.add_argument("--max-zh", type=int, default=63_000)
    args = parser.parse_args()

    if args.verify:
        verify_production_db(Path(args.verify))
        return

    if args.fixture:
        out = Path(args.output) if args.output else FIXTURE_OUT
        build_fixture(out)
    else:
        if args.output is None:
            args.output = str(DEFAULT_OUT)
        build_full(args)


if __name__ == "__main__":
    main()
