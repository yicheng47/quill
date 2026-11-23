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
                    "SELECT e.lemma, e.senses_json, e.gloss_en FROM forms f JOIN entries e ON e.id = f.entry_id WHERE f.form = '悖論' AND f.lang = 'zh'"
                ).fetchone()
                self.assertIsNotNone(row)
                self.assertEqual(row[0], "悖论")
                senses = build_dict.decompress_senses(row[1], bytes(zdict))
                self.assertEqual(senses[0]["pos"], "名词")
                self.assertIn("逻辑", senses[0]["defs"][0])
                self.assertIn("paradox", row[2].lower())
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
