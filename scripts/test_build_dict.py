#!/usr/bin/env python3
"""Unit tests for scripts/build-dict.py using production-shaped upstream records."""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

BUILD_SCRIPT = Path(__file__).resolve().parent / "build-dict.py"
spec = importlib.util.spec_from_file_location("build_dict", BUILD_SCRIPT)
assert spec and spec.loader
build_dict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_dict)


class BuildDictTests(unittest.TestCase):
    def test_production_shaped_en_and_zh_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            en_jsonl = root / "en.jsonl"
            zh_jsonl = root / "zh.jsonl"
            ecdict_csv = root / "ecdict.csv"
            cedict_txt = root / "cedict.txt"
            out_db = root / "dict.db"

            # Production-shaped English Kaikki records (mirrors live kaikki.org schema)
            en_records = [
                {
                    "word": "mortify",
                    "pos": "verb",
                    "sounds": [{"ipa": "/ˈmɔːr.tɪ.faɪ/"}],
                    "forms": [
                        {"form": "mortifies", "tags": ["present", "singular", "third-person"]},
                        {"form": "mortifying", "tags": ["participle", "present"]},
                        {"form": "mortified", "tags": ["participle", "past"]},
                        {"form": "mortified", "tags": ["past"]},
                    ],
                    "senses": [
                        {"glosses": ["To kill."], "tags": ["obsolete", "transitive"]},
                        {
                            "glosses": ["To injure the dignity of; to embarrass; to humiliate."],
                            "tags": ["transitive"],
                        },
                    ],
                },
                {
                    "word": "mortified",
                    "pos": "verb",
                    "senses": [
                        {
                            "glosses": ["simple past and past participle of mortify"],
                            "form_of": [{"word": "mortify"}],
                            "tags": ["form-of", "participle", "past"],
                        }
                    ],
                },
                {
                    "word": "mortified",
                    "pos": "adj",
                    "senses": [{"glosses": ["Acutely embarrassed."], "tags": ["informal"]}],
                },
                {
                    "word": "mortifying",
                    "pos": "verb",
                    "senses": [
                        {
                            "glosses": ["present participle of mortify"],
                            "form_of": [{"word": "mortify"}],
                            "tags": ["form-of", "participle", "present"],
                        }
                    ],
                },
                {
                    "word": "mortifying",
                    "pos": "adj",
                    "senses": [{"glosses": ["Causing mortification or embarrassment."]}],
                },
                {
                    "word": "mortifying",
                    "pos": "noun",
                    "senses": [{"glosses": ["mortification; abstinence"]}],
                },
                {
                    "word": "child",
                    "pos": "noun",
                    "forms": [{"form": "children", "tags": ["plural"]}],
                    "senses": [{"glosses": ["A young human being."]}],
                },
                {
                    "word": "leave",
                    "pos": "verb",
                    "forms": [{"form": "left", "tags": ["past"]}],
                    "senses": [{"glosses": ["To depart from."]}],
                },
                {
                    "word": "left",
                    "pos": "adj",
                    "senses": [{"glosses": ["Designating the side toward the west when facing north."]}],
                },
                {
                    "word": "left",
                    "pos": "noun",
                    "senses": [{"glosses": ["The left side or direction."]}],
                },
                {
                    "word": "left",
                    "pos": "verb",
                    "senses": [
                        {
                            "glosses": ["simple past and past participle of leave"],
                            "form_of": [{"word": "leave"}],
                            "tags": ["form-of", "participle", "past"],
                        }
                    ],
                },
                {
                    "word": "see",
                    "pos": "verb",
                    "forms": [{"form": "saw", "tags": ["past"]}],
                    "senses": [{"glosses": ["To perceive with the eyes."]}],
                },
                {
                    "word": "saw",
                    "pos": "noun",
                    "senses": [{"glosses": ["A serrated tool for cutting wood."]}],
                },
                {
                    "word": "saw",
                    "pos": "verb",
                    "senses": [
                        {
                            "glosses": ["simple past of see"],
                            "form_of": [{"word": "see"}],
                            "tags": ["form-of", "past"],
                        }
                    ],
                },
            ]
            en_jsonl.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in en_records) + "\n",
                encoding="utf-8",
            )

            ecdict_csv.write_text(
                "word,phonetic,definition,translation,collins,oxford,bnc,frq,exchange\n"
                "mortify,ˈmɔ:tɪfaɪ,v. humiliate,vt. 使羞愧；克制,2,0,12000,14000,p:mortified/d:mortified/i:mortifying/3:mortifies\n"
                "mortified,ˈmɔ:tɪfaɪd,adj. embarrassed,adj. 窘迫的,1,0,18000,19000,\n"
                "mortifying,ˈmɔ:tɪfaɪɪŋ,adj. embarrassing,adj. 令人窘迫的,1,0,22000,23000,\n"
                "child,tʃaɪld,n. young person,n. 孩子,5,1,200,210,s:children\n"
                "children,ˈtʃɪldrən,n. young people,n. 孩子们,4,0,300,310,0:child/1:s\n"
                "leave,li:v,v. go away,v. 离开；留下,5,1,200,220,p:left/d:left\n"
                "left,left,adj. on the left,adj. 左边的,5,1,150,160,\n"
                "see,si:,v. look,v. 看见,5,1,100,110,p:saw/d:seen\n"
                "saw,sɔ:,n. cutting tool,n. 锯子,3,1,4000,4500,\n",
                encoding="utf-8",
            )

            # Production-shaped Chinese-edition zhwiktionary records + CC-CEDICT
            zh_records = [
                {
                    "word": "潛移默化",
                    "pos": "phrase",
                    "tags": ["idiomatic"],
                    "forms": [{"form": "潜移默化", "tags": ["Simplified-Chinese"]}],
                    "senses": [
                        {
                            "glosses": [
                                "人的思想、性格或習慣受到影響，不知不覺起了變化"
                            ]
                        }
                    ],
                },
                {
                    "word": "悖論",
                    "pos": "noun",
                    "forms": [{"form": "悖论", "tags": ["Simplified-Chinese"]}],
                    "senses": [
                        {
                            "glosses": [
                                "按普遍认可的逻辑推理方式，可推导出两个相互对立之结论的命題"
                            ]
                        }
                    ],
                },
            ]
            zh_jsonl.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in zh_records) + "\n",
                encoding="utf-8",
            )

            cedict_txt.write_text(
                "# CC-CEDICT sample\n"
                "潛移默化 潜移默化 [qian2 yi2 mo4 hua4] /to exert a subtle influence on sb's character, thinking, etc (idiom)/to imperceptibly influence/\n"
                "悖論 悖论 [bei4 lun4] /paradox (logic)/\n"
                "人工智能 人工智能 [ren2 gong1 zhi4 neng2] /artificial intelligence (AI)/\n",
                encoding="utf-8",
            )

            ecdict = build_dict.load_ecdict(ecdict_csv)
            en_entries, en_links, participial_adjs = build_dict.parse_en_kaikki(
                en_jsonl, ecdict, max_lemmas=100
            )
            self.assertIn("mortified", participial_adjs)
            self.assertIn("mortifying", participial_adjs)
            self.assertNotIn("left", participial_adjs)
            self.assertNotIn("saw", participial_adjs)
            self.assertNotIn("children", [e["lemma"] for e in en_entries])

            # Modern sense must rank ahead of obsolete sense for mortify
            mortify_entry = next(e for e in en_entries if e["lemma"] == "mortify")
            self.assertIn("embarrass", mortify_entry["senses"][0]["defs"][0].lower())

            zh_entries, zh_trad_links = build_dict.parse_zh_entries(
                zh_jsonl, cedict_txt, max_entries=100
            )
            ai_entry = next(e for e in zh_entries if e["lemma"] == "人工智能")
            # 4-char non-idiom must NOT be guessed as 成语
            self.assertEqual(ai_entry["senses"][0]["pos"], "词语")

            build_dict.assemble_and_write_production_db(
                out_db,
                en_entries,
                en_links,
                participial_adjs,
                zh_entries,
                zh_trad_links,
                built_at="test",
            )

            # Runs the exact verification checks (mortified/mortifying -> mortify,
            # left -> left + leave, saw -> saw + see, 潜移默化/潛移默化 with Chinese sense + 成语 + EN gloss)
            build_dict.verify_production_db(out_db, min_en=1, min_zh=1)

            # Double-check 悖论 / 悖論 Chinese sense & separate English gloss
            conn = sqlite3.connect(str(out_db))
            try:
                zdict = conn.execute(
                    "SELECT value FROM meta WHERE key = 'senses_zdict'"
                ).fetchone()[0]
                row = conn.execute(
                    "SELECT e.lemma, e.pron, e.senses_json, e.gloss_en FROM forms f JOIN entries e ON e.id = f.entry_id WHERE f.form = '悖論' AND f.lang = 'zh'"
                ).fetchone()
                self.assertIsNotNone(row)
                self.assertEqual(row[0], "悖论")
                decoded = build_dict.decompress_entry_payload(
                    row[2], bytes(zdict), col_pron=row[1], col_gloss_en=row[3]
                )
                self.assertEqual(decoded["senses"][0]["pos"], "名词")
                self.assertIn("逻辑", decoded["senses"][0]["defs"][0])
                self.assertIn("paradox", (decoded["gloss_en"] or "").lower())
            finally:
                conn.close()

    def test_fetch_artifact_verifies_checksum_and_rejects_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_artifact = root / "dict-v1.db"
            build_dict.build_fixture(src_artifact)
            good_sha = build_dict.sha256_file(src_artifact)

            dest = root / "fetched.db"
            manifest = {
                "artifact": {
                    "url": src_artifact.as_uri(),
                    "sha256": good_sha,
                }
            }
            fetched = build_dict.fetch_artifact(dest, manifest=manifest, verify_db=False)
            self.assertEqual(fetched, dest)
            self.assertEqual(build_dict.sha256_file(dest), good_sha)

            # Corrupting the manifest checksum must reject the download without writing dest
            bad_dest = root / "bad.db"
            bad_manifest = {
                "artifact": {
                    "url": src_artifact.as_uri(),
                    "sha256": "0" * 64,
                }
            }
            with self.assertRaises(RuntimeError):
                build_dict.fetch_artifact(bad_dest, manifest=bad_manifest, verify_db=False)
            self.assertFalse(bad_dest.exists())
            self.assertFalse(bad_dest.with_suffix(".db.part").exists())

    def test_zh_surname_upgrade_unknown_pos_cedict_boundaries_and_attested_en_morph(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            en_jsonl = root / "en.jsonl"
            zh_jsonl = root / "zh.jsonl"
            ecdict_csv = root / "ecdict.csv"
            cedict_txt = root / "cedict.txt"
            out_db = root / "dict.db"

            en_records = [
                {
                    "word": "shoe",
                    "pos": "verb",
                    "forms": [
                        {"form": "shoes", "tags": ["present", "singular", "third-person"]},
                        {"form": "shoeing", "tags": ["participle", "present"]},
                        {"form": "shoed", "tags": ["past"]},
                        {"form": "shod", "tags": ["past"]},
                        {"form": "shoon", "tags": ["archaic", "plural"]},
                    ],
                    "senses": [{"glosses": ["To fit with shoes."]}],
                },
                {
                    "word": "read",
                    "pos": "verb",
                    "forms": [
                        {"form": "reads", "tags": ["present", "singular", "third-person"]},
                        {"form": "reading", "tags": ["participle", "present"]},
                    ],
                    "senses": [{"glosses": ["To look at and comprehend written text."]}],
                },
                {
                    "word": "reader",
                    "pos": "noun",
                    "forms": [{"form": "readers", "tags": ["plural"]}],
                    "senses": [{"glosses": ["A person who reads."]}],
                },
                {
                    "word": "abbreviate",
                    "pos": "verb",
                    "forms": [
                        {"form": "abbreviates", "tags": ["present", "singular", "third-person"]},
                        {"form": "abbreviated", "tags": ["past"]},
                        {"form": "abbreviating", "tags": ["participle", "present"]},
                    ],
                    "senses": [{"glosses": ["To shorten a word or phrase."]}],
                },
            ]
            en_jsonl.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in en_records) + "\n",
                encoding="utf-8",
            )
            ecdict_csv.write_text(
                "word,phonetic,definition,translation,collins,oxford,bnc,frq,exchange\n"
                "shoe,ʃu:,v. fit with shoes,n. 鞋,4,1,1500,1500,s:shoes/i:shoeing/p:shod/d:shod\n"
                "read,ri:d,v. read,v. 读,5,1,200,200,i:reading/3:reads\n"
                "reader,ˈri:də,n. person who reads,n. 读者,4,1,900,900,s:readers\n"
                "abbreviate,əˈbri:vieɪt,v. shorten,v. 缩写,2,0,25000,26000,3:abbreviates/p:abbreviated/i:abbreviating\n",
                encoding="utf-8",
            )

            zh_records = [
                {
                    "word": "去",
                    "pos": "unknown",
                    "senses": [{"glosses": ["離開", "前往，離開所在地到另一地方"]}],
                },
                {
                    "word": "书",
                    "pos": "unknown",
                    "senses": [
                        {"glosses": ["__NOTITLECONVERT__\n關於「书」的發音和釋義，請見「書」。\n（此字是「書」的簡化字。）"]}
                    ],
                },
                {
                    "word": "書",
                    "pos": "unknown",
                    "senses": [{"glosses": ["書寫，記錄，記載。", "圖書，書籍。"]}],
                },
            ]
            zh_jsonl.write_text(
                "\n".join(json.dumps(r, ensure_ascii=False) for r in zh_records) + "\n",
                encoding="utf-8",
            )

            cedict_txt.write_text(
                "咊 和 [he2] /old variant of 和[he2]/\n"
                "和 和 [He2] /surname He/\n"
                "和 和 [he2] /(joining two nouns) and; together with; with/\n"
                "書 书 [Shu1] /abbr. for 書經|书经[Shu1 jing1]/\n"
                "書 书 [shu1] /book/letter/document/\n"
                "去 去 [qu4] /to go/to leave/\n"
                "不分勝負 不分胜负 [bu4 fen1 sheng4 fu4] /unable to determine victory or defeat (idiom); evenly matched/to come out even/to tie/\n"
                "成群結隊 成群结队 [cheng2 qun2 jie2 dui4] /(idiom) making up a group; forming a troupe; in large numbers; as a large crowd/\n",
                encoding="utf-8",
            )

            ecdict = build_dict.load_ecdict(ecdict_csv)
            en_entries, en_links, participial_adjs = build_dict.parse_en_kaikki(
                en_jsonl, ecdict, max_lemmas=100
            )
            zh_entries, zh_trad_links = build_dict.parse_zh_entries(
                zh_jsonl, cedict_txt, max_entries=100
            )
            build_dict.assemble_and_write_production_db(
                out_db,
                en_entries,
                en_links,
                participial_adjs,
                zh_entries,
                zh_trad_links,
                built_at="test",
            )

            conn = sqlite3.connect(str(out_db))
            try:
                zdict = bytes(
                    conn.execute("SELECT value FROM meta WHERE key = 'senses_zdict'").fetchone()[0]
                )

                def decode(lang: str, lemma: str) -> dict:
                    row = conn.execute(
                        "SELECT lemma, pron, senses_json, gloss_en, gloss_zh FROM entries WHERE lang = ? AND lemma = ?",
                        (lang, lemma),
                    ).fetchone()
                    self.assertIsNotNone(row, f"Missing {lang}:{lemma}")
                    return build_dict.decompress_entry_payload(
                        row[2], zdict, col_pron=row[1], col_gloss_en=row[3], col_gloss_zh=row[4], lemma=row[0]
                    )

                # Surname/variant-first CEDICT rows upgrade cleanly to everyday reading
                he = decode("zh", "和")
                self.assertEqual(he["pron"], "hé")
                self.assertNotIn("surname", (he["gloss_en"] or "").lower())
                self.assertIn("and", (he["gloss_en"] or "").lower())

                # Redirect stub on `书` is skipped; `unknown` POS sense on `書` is retained cleanly
                shu = decode("zh", "书")
                self.assertEqual(shu["pron"], "shū")
                self.assertEqual(shu["senses"][0]["pos"], "字")
                self.assertIn("書寫", shu["senses"][0]["defs"][0])
                self.assertNotIn("__NOTITLECONVERT__", shu["senses"][0]["defs"][0])

                qu = decode("zh", "去")
                self.assertEqual(qu["senses"][0]["pos"], "字")
                self.assertIn("離開", qu["senses"][0]["defs"][0])

                # CEDICT-only idioms keep complete source senses and never truncate mid-word
                tie = decode("zh", "不分胜负")
                self.assertEqual(tie["senses"][0]["pos"], "成语")
                self.assertIn("evenly matched", tie["senses"][0]["defs"][0])
                self.assertIn("to come out even", tie["senses"][0]["defs"][1])
                self.assertFalse((tie["gloss_en"] or "").endswith("; t"))

                crowd = decode("zh", "成群结队")
                self.assertIn("as a large crowd", crowd["senses"][0]["defs"][0])
                self.assertFalse((crowd["gloss_en"] or "").endswith("; a"))

                # Source-attested English morphology flags
                shoe = decode("en", "shoe")
                self.assertIn("shoeing", shoe["forms"])
                self.assertIn("shod", shoe["forms"])
                self.assertNotIn("shoing", shoe["forms"])
                self.assertNotIn("shoon", shoe["forms"])

                read = decode("en", "read")
                self.assertIn("reads", read["forms"])
                self.assertIn("reading", read["forms"])
                self.assertNotIn("reader", read["forms"])

                abbr = decode("en", "abbreviate")
                self.assertIn("abbreviates", abbr["forms"])
                self.assertIn("abbreviated", abbr["forms"])
                self.assertIn("abbreviating", abbr["forms"])
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
