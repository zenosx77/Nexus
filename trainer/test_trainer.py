#!/usr/bin/env python3
"""NEXUS trainer unit tests (stdlib unittest — no network, no database)."""
import json
import unittest

from train import (
    artifact_sha256,
    blend_weights,
    canonical_json,
    canonical_jsonl,
    chronological_split,
    compute_strategy_stats,
    dataset_sha256,
    evaluate_majority,
    evaluate_weights,
    load_env_file,
    promotion_gate,
    sanitize_json,
    strategy_votes,
    walk_forward_folds,
)

# Cross-implementation fixture: the browser smoke suite rebuilds EXACTLY this
# artifact in JS and must produce the same sha256 (crypto.subtle verification).
FIXTURE_ARTIFACT = {
    "kind": "strategy-weights",
    "model_id": "nexus-weights-test",
    "timeframes": {
        "1m": {"strats": {"ema": {"vwr": 0.55, "vtrades": 120}, "rsi": {"vwr": 0.5, "vtrades": 60}}},
        "3m": {"strats": {"ema": {"vwr": 1.0, "vtrades": 40}}},
    },
    "metrics": {"holdout": {"win_rate": 0.6, "n": 50, "expectancy_bps": 1.25,
                            "profit_factor": None, "max_drawdown_bps": 12.5}},
    "note": "café ✓",   # non-ASCII must be escaped identically in Python and JS
}


FIXTURE_SHA = "43925bb7706d2e548f1a280bd123848a31189ff57a41f67654e2f5c0c1fdc3ec"


def rec(ts, direction, outcome, agents, tf="1m", net_bps=3.0, pair="EUR/USD"):
    return {
        "id": f"r{ts}", "pair_code": pair, "timeframe": tf,
        "target_open_ts": ts, "direction": direction,
        "strategy_detail": {"agents": agents},
        "outcome": outcome, "is_valid": True, "net_return_bps": net_bps,
        "feature_version": "browser-live-v1",
    }


AGENTS_WINNING_CALL = [{"n": "ema", "d": "CALL"}, {"n": "rsi", "d": "CALL"}, {"n": "macd", "d": "PUT"}]


class TestSplits(unittest.TestCase):
    def test_holdout_is_the_chronologically_last_block(self):
        rows = [{"t": i} for i in range(100)]
        train, holdout = chronological_split(rows, holdout_frac=0.2, min_holdout=20)
        self.assertEqual(len(holdout), 20)
        self.assertEqual(holdout[0]["t"], 80)
        self.assertEqual(holdout[-1]["t"], 99)
        self.assertEqual(train[-1]["t"], 79)

    def test_no_overlap_and_order_preserved(self):
        rows = list(range(57))
        train, holdout = chronological_split(rows, holdout_frac=0.3, min_holdout=10)
        self.assertEqual(sorted(train + holdout), rows)
        self.assertLess(max(train), min(holdout))

    def test_tiny_datasets_still_split(self):
        train, holdout = chronological_split([1, 2])
        self.assertTrue(train)
        self.assertTrue(holdout)

    def test_folds_are_chronological_and_non_overlapping(self):
        folds = walk_forward_folds(1000, n_folds=4, min_val=30)
        self.assertEqual(len(folds), 4)
        for train_end, val_start, val_end in folds:
            self.assertEqual(train_end, val_start)      # no gap = no leakage
            self.assertGreater(val_end, val_start)
        starts = [f[1] for f in folds]
        self.assertEqual(starts, sorted(starts))         # chronological
        self.assertLessEqual(folds[-1][2], 1000)         # stays inside the pool

    def test_too_few_rows_yield_no_folds(self):
        self.assertEqual(walk_forward_folds(40, min_val=30), [])


class TestDatasetReproducibility(unittest.TestCase):
    def test_canonical_jsonl_is_deterministic(self):
        rows = [{"b": 2, "a": 1}, {"a": 3, "b": 4}]
        self.assertEqual(canonical_jsonl(rows), canonical_jsonl(json.loads(json.dumps(rows))))
        self.assertNotEqual(dataset_sha256(rows), dataset_sha256(rows[::-1]))

    def test_sha_is_hex_64(self):
        h = dataset_sha256([{"x": 1}])
        self.assertEqual(len(h), 64)
        int(h, 16)


class TestStrategyStats(unittest.TestCase):
    def test_votes_parse_both_shapes(self):
        # browser canonical: votes dict (what sbTrackPrediction records)
        self.assertEqual(strategy_votes({"votes": {"ema": "CALL", "rsi": "PUT", "flat": None}}),
                         [("ema", "CALL"), ("rsi", "PUT")])
        # tolerated: list-of-dicts agents
        self.assertEqual(strategy_votes({"agents": [{"n": "a", "d": "CALL"}]}), [("a", "CALL")])
        self.assertEqual(strategy_votes({"agents": [{"name": "b", "dir": "PUT"}]}), [("b", "PUT")])
        # browser agents map (channel biases: numbers) must yield nothing
        self.assertEqual(strategy_votes({"agents": {"STRATEGY": 1, "TREND": -1}}), [])
        self.assertEqual(strategy_votes({}), [])
        self.assertEqual(strategy_votes({"agents": ["junk", 5]}), [])

    def test_win_rates_per_strategy(self):
        # ema right twice, wrong once; rsi right once, wrong twice; macd once (below min)
        rows = [
            rec("t1", "CALL", "win", [{"n": "ema", "d": "CALL"}, {"n": "rsi", "d": "PUT"}, {"n": "macd", "d": "CALL"}]),
            rec("t2", "CALL", "win", [{"n": "ema", "d": "CALL"}, {"n": "rsi", "d": "PUT"}]),
            rec("t3", "CALL", "loss", [{"n": "ema", "d": "CALL"}, {"n": "rsi", "d": "PUT"}]),
        ]
        w = compute_strategy_stats(rows, min_trades=2)
        self.assertAlmostEqual(w["1m"]["strats"]["ema"]["vwr"], 2 / 3, places=4)
        self.assertAlmostEqual(w["1m"]["strats"]["rsi"]["vwr"], 1 / 3, places=4)
        self.assertNotIn("macd", w["1m"]["strats"])

    def test_min_trades_gate(self):
        rows = [rec("t1", "CALL", "win", [{"n": "x", "d": "CALL"}])] * 2
        self.assertEqual(compute_strategy_stats(rows, min_trades=5), {})

    def test_neutral_invalid_excluded(self):
        rows = [
            rec("t1", "CALL", "neutral", [{"n": "x", "d": "CALL"}]),
            rec("t2", "CALL", "invalid", [{"n": "x", "d": "CALL"}]),
        ]
        self.assertEqual(compute_strategy_stats(rows, min_trades=1), {})


class TestEvaluateWeights(unittest.TestCase):
    def test_perfect_weights_score_perfectly(self):
        # ema is right in both rows; rsi is wrong in both — weight ema higher
        rows = [
            rec("t1", "CALL", "win", [{"n": "ema", "d": "CALL"}, {"n": "rsi", "d": "PUT"}]),
            rec("t2", "CALL", "loss", [{"n": "ema", "d": "PUT"}, {"n": "rsi", "d": "CALL"}]),
        ]
        w = {"1m": {"strats": {"ema": {"vwr": 0.9, "vtrades": 200}, "rsi": {"vwr": 0.2, "vtrades": 200}}}}
        m = evaluate_weights(rows, w)
        self.assertEqual(m["n"], 2)
        self.assertEqual(m["win_rate"], 1.0)
        self.assertGreater(m["expectancy_bps"], 0)

    def test_unweighted_opinions_carry_no_vote(self):
        rows = [rec("t1", "CALL", "win", [{"n": "ema", "d": "CALL"}])]
        m = evaluate_weights(rows, {"1m": {"strats": {}}})
        self.assertEqual(m["n"], 0)
        self.assertIsNone(m["win_rate"])

    def test_majority_baseline_counts_all_strats_equally(self):
        # row1 majority CALL (right), row2 majority PUT on a CALL-win record (wrong)
        rows = [
            rec("t1", "CALL", "win", [{"n": "a", "d": "CALL"}, {"n": "b", "d": "CALL"}, {"n": "c", "d": "PUT"}]),
            rec("t2", "CALL", "win", [{"n": "a", "d": "CALL"}, {"n": "b", "d": "PUT"}, {"n": "c", "d": "PUT"}]),
        ]
        m = evaluate_majority(rows)
        self.assertEqual(m["n"], 2)
        self.assertEqual(m["win_rate"], 0.5)


class TestBlendWeights(unittest.TestCase):
    def test_shrinkage_pulls_learned_toward_prior(self):
        deployed = {"1m": {"strats": {"ema": {"vwr": 0.5, "vtrades": 100}}}}
        learned = {"1m": {"strats": {"ema": {"vwr": 1.0, "vtrades": 30}}}}
        blended = blend_weights(deployed, learned, prior_strength=30)
        vwr = blended["1m"]["strats"]["ema"]["vwr"]
        self.assertGreater(vwr, 0.5)
        self.assertLess(vwr, 1.0)

    def test_unseen_strategy_keeps_deployed_values_decayed(self):
        deployed = {"1m": {"strats": {"old": {"vwr": 0.6, "vtrades": 100}}}}
        learned = {"1m": {"strats": {"new": {"vwr": 0.7, "vtrades": 50}}}}
        blended = blend_weights(deployed, learned)
        self.assertAlmostEqual(blended["1m"]["strats"]["old"]["vwr"], 0.6, places=4)
        self.assertLess(blended["1m"]["strats"]["old"]["vtrades"], 100)
        self.assertEqual(blended["1m"]["strats"]["new"]["vwr"], 0.7)

    def test_no_deployed_model_passes_learned_through(self):
        learned = {"1m": {"strats": {"x": {"vwr": 0.8, "vtrades": 40}}}}
        self.assertEqual(blend_weights({}, learned)["1m"]["strats"]["x"]["vwr"], 0.8)


class TestPromotionGate(unittest.TestCase):
    SETTINGS = {"min_train_rows": 100, "min_wf_winrate_delta": 0.02, "min_holdout_winrate": 0.5}

    def candidate(self, wf=0.6, ho=0.55, pf=1.2, exp=1.0):
        return {"walk_forward": {"win_rate": wf}, "holdout": {
            "win_rate": ho, "profit_factor": pf, "expectancy_bps": exp}}

    def test_pass(self):
        ok, reasons = promotion_gate(self.candidate(), self.candidate(wf=0.55, ho=0.52, exp=0.5),
                                     self.SETTINGS, dataset_rows=200)
        self.assertTrue(ok, reasons)
        self.assertEqual(reasons, [])

    def test_fails_on_sample_size(self):
        ok, reasons = promotion_gate(self.candidate(), self.candidate(), self.SETTINGS, dataset_rows=50)
        self.assertFalse(ok)
        self.assertTrue(any("min_train_rows" in r for r in reasons))

    def test_fails_when_no_wf_improvement(self):
        ok, reasons = promotion_gate(self.candidate(wf=0.56), self.candidate(wf=0.55),
                                     self.SETTINGS, dataset_rows=200)
        self.assertFalse(ok)
        self.assertTrue(any("WF win rate" in r for r in reasons))

    def test_fails_below_holdout_floor(self):
        ok, reasons = promotion_gate(self.candidate(ho=0.45), self.candidate(ho=0.40),
                                     self.SETTINGS, dataset_rows=200)
        self.assertFalse(ok)
        self.assertTrue(any("holdout win rate" in r for r in reasons))

    def test_fails_when_expectancy_worse_than_deployed(self):
        ok, reasons = promotion_gate(self.candidate(exp=0.2), self.candidate(exp=1.5),
                                     self.SETTINGS, dataset_rows=200)
        self.assertFalse(ok)
        self.assertTrue(any("expectancy" in r for r in reasons))

    def test_no_deployed_model_uses_holdout_floor_only(self):
        ok, reasons = promotion_gate(self.candidate(), None, self.SETTINGS, dataset_rows=200)
        self.assertTrue(ok, reasons)


class TestCanonicalArtifact(unittest.TestCase):
    def test_sanitize_converts_whole_floats_to_ints(self):
        self.assertEqual(sanitize_json({"a": 1.0, "b": 0.5, "c": [2.0, 3]}),
                         {"a": 1, "b": 0.5, "c": [2, 3]})

    def test_canonical_json_is_compact_sorted_ascii(self):
        s = canonical_json({"b": 1, "a": {"y": [1, 2], "x": "é"}})
        self.assertEqual(s, '{"a":{"x":"\\u00e9","y":[1,2]},"b":1}')

    def test_artifact_sha_is_stable_and_hex64(self):
        h1 = artifact_sha256(FIXTURE_ARTIFACT)
        h2 = artifact_sha256(json.loads(json.dumps(FIXTURE_ARTIFACT)))
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)

    def test_fixture_hash_matches_the_browser_verifier(self):
        # computed once and pinned: JS (smoke.cjs sbCanonical) must reproduce it
        self.assertEqual(artifact_sha256(FIXTURE_ARTIFACT), FIXTURE_SHA)


class TestEnvLoader(unittest.TestCase):
    def test_real_env_wins(self):
        import os, tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as fh:
            fh.write("TEST_NX_TRAINER_VAR=fromfile\nTEST_NX_TRAINER_REAL=fromfile\n")
            path = fh.name
        os.environ["TEST_NX_TRAINER_REAL"] = "fromenv"
        try:
            load_env_file(path)
            self.assertEqual(os.environ["TEST_NX_TRAINER_VAR"], "fromfile")
            self.assertEqual(os.environ["TEST_NX_TRAINER_REAL"], "fromenv")
        finally:
            for k in ("TEST_NX_TRAINER_VAR", "TEST_NX_TRAINER_REAL"):
                os.environ.pop(k, None)
            os.unlink(path)

    def test_missing_file_is_silent(self):
        load_env_file("/nonexistent/.env")


class TestIntegrityRegression(unittest.TestCase):
    def test_uploaded_bytes_are_browser_canonical(self):
        import hashlib
        from unittest.mock import patch, MagicMock
        from train import upload_artifact
        response = MagicMock()
        response.__enter__.return_value.read.return_value = canonical_json(FIXTURE_ARTIFACT).encode()
        with patch('urllib.request.urlopen', return_value=response) as send:
            import train
            with patch.object(train, 'SB_URL', 'https://example.invalid'):
                _, sha, nbytes = upload_artifact('test', FIXTURE_ARTIFACT)
            request = send.call_args_list[0].args[0]
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("X-upsert"), "false")
            body = request.data
        self.assertEqual(body.decode(), canonical_json(FIXTURE_ARTIFACT))
        self.assertEqual(sha, FIXTURE_SHA)
        self.assertEqual(nbytes, len(body))
        self.assertEqual(sha, hashlib.sha256(body).hexdigest())

    def test_invalid_wins_do_not_train_or_evaluate(self):
        from train import eligible_record
        r = rec('t1', 'CALL', 'win', AGENTS_WINNING_CALL)
        for validity in (False, None, 'true', 1):
            r['is_valid'] = validity
            self.assertFalse(eligible_record(r))
            self.assertEqual(compute_strategy_stats([r], min_trades=1), {})
            self.assertEqual(evaluate_majority([r])['n'], 0)

    def test_fetch_filters_before_split_count_and_hash(self):
        from unittest.mock import patch
        from train import fetch_dataset
        good = rec('2026-01-01T00:00:00Z', 'CALL', 'win', AGENTS_WINNING_CALL)
        rows = []
        for i, (outcome, valid) in enumerate([('win',True),('loss',True),('win',False),('invalid',False),('neutral',True),(None,True)]):
            rows.append({**good, 'created_at':'2025-12-31T23:59:00Z', 'id':str(i), 'trade_outcomes':{'outcome':outcome,'is_valid':valid}})
        with patch('train.sb_request', return_value=rows):
            records = fetch_dataset()
        self.assertEqual(len(records), 2)
        self.assertEqual([r['id'] for r in records], ['0','1'])

    def test_browser_validates_whole_model_before_upload(self):
        from train import browser_contract
        import copy
        for weight in ({'vwr':2,'vtrades':1}, {'vwr':0.5,'vtrades':1.1}, {'vwr':0.5,'vtrades':5001}):
            artifact = copy.deepcopy(FIXTURE_ARTIFACT)
            artifact['timeframes']['1m']['strats']['ema'] = weight
            with self.assertRaises(ValueError): browser_contract(artifact, validate=True)
        with self.assertRaises(ValueError): browser_contract({'kind':'strategy-weights','timeframes':{}}, validate=True)

    def test_js_number_edges_and_unicode(self):
        self.assertEqual(canonical_json({'x':1e-7,'y':1e-6,'z':-0.0,'s':'\x7f😀'}),
                         '{"s":"\\u007f\\ud83d\\ude00","x":1e-7,"y":0.000001,"z":0}')

    def test_split_purges_same_target_and_overlapping_horizons(self):
        from train import purge_overlapping_labels
        rows = [
            {"target_open_ts":"2026-01-01T00:00:00Z", "evaluation_horizon":1},
            {"target_open_ts":"2026-01-01T00:01:00Z", "evaluation_horizon":3},
            {"target_open_ts":"2026-01-01T00:04:00Z", "evaluation_horizon":1},
        ]
        self.assertEqual(purge_overlapping_labels(rows, [rows[-1]]), [rows[0]])


if __name__ == "__main__":
    unittest.main()
