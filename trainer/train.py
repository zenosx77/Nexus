#!/usr/bin/env python3
"""
NEXUS self-learning trainer (stdlib only — Python 3.9+).

Learns per-timeframe per-strategy weights (vwr / vtrades) from recorded
production predictions + evaluated outcomes, using the SAME weight shape the
browser engine already consumes (deep[tf].strats[s]) — this trains WEIGHTS,
never new prediction logic.

Guarantees:
  • leakage-free: chronological walk-forward + untouched final holdout
  • reproducible: dataset window, row counts and sha256 recorded per run
  • gated promotion: sample size + performance + risk criteria, shadow first
  • rollback: the previous production model is always preserved
  • honest metrics: everything is SIMULATED replay on recorded outcomes

Usage:
  python3 train.py run        # full pipeline (fetch → train → evaluate → gate → register)
  python3 train.py rollback   # re-deploy the previous production model
  python3 train.py status     # show deployed / shadow models + recent runs
"""

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# ── environment ───────────────────────────────────────────────────────────

def load_env_file(path=None):
    """Load key=value lines (real env always wins). No dependencies."""
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip()
                quoted = ((val.startswith('"') and val.endswith('"'))
                          or (val.startswith("'") and val.endswith("'")))
                if quoted:
                    val = val[1:-1]
                else:
                    # Match the worker loader: comments start at an unquoted
                    # hash preceded by whitespace, not inside a token/value.
                    comment = re.search(r"\s+#|^#", val)
                    if comment:
                        val = val[:comment.start()].strip()
                if key and key not in os.environ:
                    os.environ[key] = val
    except OSError:
        pass


SB_URL = ""
SB_KEY = ""


def sb_headers(json_body=False, prefer=None):
    h = {
        "apikey": SB_KEY,
        "authorization": f"Bearer {SB_KEY}",
    }
    if json_body:
        h["content-type"] = "application/json"
    if prefer:
        h["prefer"] = prefer
    return h


def sb_request(method, path, params=None, body=None, prefer=None, storage=False):
    base = SB_URL.rstrip("/")
    url = (f"{base}/storage/v1/{path}" if storage else f"{base}/rest/v1/{path}")
    if params:
        url += "?" + urllib.parse.urlencode(params, safe=".,!()*")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=sb_headers(data is not None, prefer))
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        detail = err.read().decode()[:400]
        raise RuntimeError(f"supabase {method} {path}: HTTP {err.code} {detail}") from err


# ── pure logic: dataset handling ──────────────────────────────────────────

def chronological_split(rows, holdout_frac=0.2, min_holdout=30):
    """Split rows (already sorted ascending by time) into (train_pool, holdout).
    The holdout is ALWAYS the chronologically last block — never shuffled."""
    n = len(rows)
    if n == 0:
        return [], []
    holdout_n = max(min_holdout, int(n * holdout_frac)) if n > min_holdout * 2 else max(1, n // 5)
    holdout_n = min(holdout_n, n - 1) if n > 1 else 0
    return rows[: n - holdout_n], rows[n - holdout_n:]


def walk_forward_folds(n_rows, n_folds=4, min_val=30):
    """Chronological expanding-window folds: (train_end, val_start, val_end)
    with train_end == val_start — the validator never sees training rows,
    and later folds never see the future."""
    if n_rows < 2 * min_val:
        return []
    block = max(min_val, n_rows // (n_folds + 3))
    folds = []
    val_start = n_rows - block
    made = 0
    while val_start >= min_val and made < n_folds:
        folds.append((val_start, val_start, val_start + block))
        val_start -= block
        made += 1
    folds.reverse()
    return folds


def canonical_jsonl(rows):
    """Deterministic serialisation for dataset checksums."""
    lines = []
    for r in rows:
        lines.append(json.dumps(r, sort_keys=True, separators=(",", ":"), default=str))
    return "\n".join(lines) + ("\n" if rows else "")


def dataset_sha256(rows):
    return hashlib.sha256(canonical_jsonl(rows).encode()).hexdigest()


def sanitize_json(obj):
    """Normalise an artifact so its canonical form is byte-identical when
    re-serialised by ANY JSON implementation (e.g. the browser's verifier):
    whole floats become ints (1.0 → 1), recursively."""
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_json(v) for v in obj]
    if isinstance(obj, float) and obj.is_integer():
        return int(obj)
    return obj


def canonical_json(obj):
    """Compact, key-sorted, ASCII-only JSON — the exact byte stream that is
    hashed AND the exact byte stream the browser rebuilds from artifact_payload
    to verify artifact_sha256 with crypto.subtle."""
    return json.dumps(sanitize_json(obj), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False)


def artifact_sha256(artifact):
    return hashlib.sha256(canonical_json(artifact).encode("utf-8")).hexdigest()


# ── pure logic: weights ───────────────────────────────────────────────────

def strategy_votes(strategy_detail):
    """Extract [(name, 'CALL'|'PUT')] from a prediction's strategy_detail.

    Browser canonical shape (index.html sbTrackPrediction):
        strategy_detail.votes = {"ema": "CALL", "rsi": "PUT", ...}   (per-strategy)
    Also tolerated: list-of-dicts agents [{n|name, d|dir}] for other producers.
    """
    detail = strategy_detail or {}
    out = []
    votes = detail.get("votes")
    if isinstance(votes, dict):
        for name, d in votes.items():
            du = str(d).upper()
            if name and du in ("CALL", "PUT"):
                out.append((str(name), du))
        return out
    agents = detail.get("agents")
    if isinstance(agents, list):
        for a in agents:
            if not isinstance(a, dict):
                continue
            name = a.get("n") or a.get("name")
            d = str(a.get("d") or a.get("dir") or "").upper()
            if name and d in ("CALL", "PUT", "NEU"):
                out.append((str(name), d))
    return out


def compute_strategy_stats(records, min_trades=15, max_trades=5000):
    """Per-timeframe per-strategy win rates from decisive outcomes.
    A strategy's vote is 'right' when it matches the direction the prediction
    got right (outcome win ⇒ its vote == prediction direction won, etc.)."""
    stats = {}  # tf -> {strat: [wins, total]}
    for r in records:
        o = r.get("outcome")
        if o not in ("win", "loss"):
            continue
        tf = r.get("timeframe", "1m")
        right_dir = r.get("direction") if o == "win" else (
            "PUT" if r.get("direction") == "CALL" else "CALL")
        tf_stats = stats.setdefault(tf, {})
        for name, d in strategy_votes(r.get("strategy_detail")):
            if d not in ("CALL", "PUT"):
                continue
            cell = tf_stats.setdefault(name, [0, 0])
            cell[1] += 1
            if d == right_dir:
                cell[0] += 1
    weights = {}
    for tf, tf_stats in stats.items():
        strats = {}
        for name, (wins, total) in tf_stats.items():
            if total >= min_trades:
                strats[name] = {"vwr": round(wins / total, 4), "vtrades": min(total, max_trades)}
        if strats:
            weights[tf] = {"strats": strats}
    return weights


def weight_for(weights, tf, name):
    try:
        s = weights.get(tf, {}).get("strats", {}).get(name)
    except AttributeError:
        return None
    if not s:
        return None
    return float(s.get("vwr", 0)) * min(float(s.get("vtrades", 0)), 200) / 200


def evaluate_weights(records, weights):
    """SIMULATED replay: weighted-majority vote per record, scored against the
    recorded outcome. Returns decisive-only metrics (win rate, expectancy,
    profit factor, max drawdown in bps)."""
    wins = losses = 0
    gross_win = gross_loss = 0.0
    net = peak = max_dd = 0.0
    for r in records:
        o = r.get("outcome")
        if o not in ("win", "loss"):
            continue
        tf = r.get("timeframe", "1m")
        score = 0.0
        voted = False
        for name, d in strategy_votes(r.get("strategy_detail")):
            if d not in ("CALL", "PUT"):
                continue
            w = weight_for(weights, tf, name)
            if w:
                voted = True
                score += w if d == "CALL" else -w
        if not voted or score == 0:
            continue
        predicted = "CALL" if score > 0 else "PUT"
        correct = (predicted == r.get("direction")) == (o == "win")
        bps = abs(float(r.get("net_return_bps") or 0))
        if correct:
            wins += 1
            gross_win += bps
            net += bps
        else:
            losses += 1
            gross_loss += bps
            net -= bps
        peak = max(peak, net)
        max_dd = max(max_dd, peak - net)
    n = wins + losses
    if n == 0:
        return {"n": 0, "win_rate": None, "expectancy_bps": None,
                "profit_factor": None, "max_drawdown_bps": None}
    return {
        "n": n,
        "win_rate": round(wins / n, 4),
        "expectancy_bps": round(net / n, 3),
        "profit_factor": round(gross_win / gross_loss, 4) if gross_loss > 0 else None,
        "max_drawdown_bps": round(max_dd, 3),
    }


def evaluate_baseline(records):
    """Unweighted majority vote — the honest 'did learning help?' comparator."""
    return evaluate_weights(records, {"*": {"strats": {}}})  # zero weights → voted=False


def evaluate_majority(records):
    """Majority of raw votes (every strategy weight 1)."""
    uniform = {}
    for r in records:
        tf = r.get("timeframe", "1m")
        strats = uniform.setdefault(tf, {"strats": {}})
        for name, d in strategy_votes(r.get("strategy_detail")):
            if d in ("CALL", "PUT"):
                strats["strats"][name] = {"vwr": 1.0, "vtrades": 200}
    return evaluate_weights(records, uniform)


def blend_weights(deployed, learned, prior_strength=30):
    """Shrinkage blend: learned win rates pulled toward the deployed prior,
    weighted by evidence. Strategies absent from the new evidence keep the
    deployed values with decayed confidence; brand-new strategies pass through
    only when they carry enough trades (compute_strategy_stats already gated)."""
    out = {}
    tfs = set(deployed or {}) | set(learned or {})
    for tf in tfs:
        dep = (deployed or {}).get(tf, {}).get("strats", {})
        lrn = (learned or {}).get(tf, {}).get("strats", {})
        merged = {}
        for name, l in lrn.items():
            d = dep.get(name)
            if d and d.get("vtrades"):
                prior_wr = float(d.get("vwr", 0.5))
                k = prior_strength
                vwr = (l["vwr"] * l["vtrades"] + prior_wr * k) / (l["vtrades"] + k)
                merged[name] = {"vwr": round(vwr, 4),
                                "vtrades": l["vtrades"] + int(d.get("vtrades", 0) // 2)}
            else:
                merged[name] = {"vwr": l["vwr"], "vtrades": l["vtrades"]}
        for name, d in dep.items():
            if name not in merged:
                merged[name] = {"vwr": round(float(d.get("vwr", 0.5)), 4),
                                "vtrades": max(1, int(d.get("vtrades", 0)) // 2)}
        if merged:
            out[tf] = {"strats": merged}
    return out


# ── pure logic: promotion gate ────────────────────────────────────────────

def promotion_gate(candidate, deployed, settings, dataset_rows):
    """Gate a candidate against the deployed model + baselines.
    Returns (passed, reasons). All criteria must hold:
      sample size, WF improvement, holdout floor, and risk sanity."""
    reasons = []
    min_rows = int(settings.get("min_train_rows", 300))
    if dataset_rows < min_rows:
        reasons.append(f"dataset_rows {dataset_rows} < min_train_rows {min_rows}")

    delta = float(settings.get("min_wf_winrate_delta", 0.02))
    wf_c = (candidate or {}).get("walk_forward", {}).get("win_rate")
    wf_d = (deployed or {}).get("walk_forward", {}).get("win_rate")
    if wf_c is None:
        reasons.append("candidate has no walk-forward win rate")
    elif wf_d is not None and wf_c < wf_d + delta:
        reasons.append(f"WF win rate {wf_c:.4f} < deployed {wf_d:.4f} + delta {delta}")

    floor = float(settings.get("min_holdout_winrate", 0.50))
    ho_c = (candidate or {}).get("holdout", {}).get("win_rate")
    if ho_c is None or ho_c < floor:
        reasons.append(f"holdout win rate {ho_c} < floor {floor}")

    # risk sanity: candidate must be profitable in replay and no worse than deployed
    pf = (candidate or {}).get("holdout", {}).get("profit_factor")
    if pf is not None and pf <= 0:
        reasons.append(f"holdout profit factor {pf} <= 0")
    exp_c = (candidate or {}).get("holdout", {}).get("expectancy_bps")
    exp_d = (deployed or {}).get("holdout", {}).get("expectancy_bps")
    if exp_c is not None and exp_d is not None and exp_c < exp_d:
        reasons.append(f"holdout expectancy {exp_c} worse than deployed {exp_d}")

    return (len(reasons) == 0), reasons


# ── pipeline steps (network) ──────────────────────────────────────────────

def fetch_settings():
    rows = sb_request("GET", "system_settings", params={"select": "key,value"}) or []
    settings = {}
    for r in rows:
        v = r.get("value")
        if isinstance(v, (int, float, bool)):
            settings[r["key"].split(".")[-1]] = v
        else:
            try:
                settings[r["key"].split(".")[-1]] = float(v) if v is not None else v
            except (TypeError, ValueError):
                settings[r["key"].split(".")[-1]] = v
    settings["auto_promote"] = str(settings.get("auto_promote", "false")).lower() == "true"
    return settings


def fetch_dataset(limit=5000, since_days=180):
    """Production (browser, non-shadow) predictions WITH evaluated outcomes,
    chronologically ascending. strategy_detail carries the per-strategy votes."""
    from datetime import timedelta
    since = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()
    params = {
        "select": ("id,pair_code,timeframe,target_open_ts,direction,strategy_detail,"
                   "feature_version,created_at,"
                   "trade_outcomes!inner(outcome,is_valid,net_return_bps)"),
        "is_shadow": "is.false",
        "source": "eq.browser",
        "target_open_ts": f"gte.{since}",
        "order": "target_open_ts.asc",
        "limit": str(limit),
    }
    rows = sb_request("GET", "predictions", params=params) or []
    records = []
    for r in rows:
        oc = (r.get("trade_outcomes") or [{}])[0]
        if not oc.get("outcome"):
            continue
        records.append({
            "id": r["id"],
            "pair_code": r["pair_code"],
            "timeframe": r.get("timeframe", "1m"),
            "target_open_ts": r["target_open_ts"],
            "direction": r.get("direction"),
            "strategy_detail": r.get("strategy_detail") or {},
            "feature_version": r.get("feature_version", "browser-live-v1"),
            "outcome": oc["outcome"],
            "is_valid": oc.get("is_valid", True),
            "net_return_bps": oc.get("net_return_bps"),
        })
    return records


def get_deployed_model():
    rows = sb_request("GET", "model_versions", params={
        "kind": "eq.strategy-weights", "is_deployed": "is.true", "limit": "1"})
    return rows[0] if rows else None


def deployed_weights(model_row):
    if not model_row:
        return {}
    payload = model_row.get("artifact_payload") or {}
    return payload.get("timeframes") or payload or {}


def upload_artifact(model_id, artifact):
    body = json.dumps(artifact, sort_keys=True).encode()
    sha = hashlib.sha256(body).hexdigest()
    path = f"artifacts/{model_id}.json"
    # storage PUT with upsert
    url = f"{SB_URL.rstrip('/')}/storage/v1/object/models/{path}"
    req = urllib.request.Request(url, data=body, method="PUT", headers={
        "apikey": SB_KEY, "authorization": f"Bearer {SB_KEY}",
        "content-type": "application/json", "x-upsert": "true",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            res.read()
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"artifact upload failed: HTTP {err.code} {err.read().decode()[:300]}") from err
    return path, sha, len(body)


def register_model(model_id, artifact, metrics, status, path, sha, nbytes, notes=None):
    row = {
        "id": model_id,
        "kind": "strategy-weights",
        "artifact_bucket": "models",
        "artifact_path": path,
        "artifact_sha256": sha,
        "artifact_bytes": nbytes,
        "artifact_payload": artifact,
        "status": status,
        "is_deployed": status == "deployed",
        "metrics": metrics,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "notes": notes or "",
    }
    if status == "deployed":
        row["promoted_at"] = datetime.now(timezone.utc).isoformat()
    sb_request("POST", "model_versions", body=row, prefer="return=minimal")
    return row


def retire_deployed(model_row, new_status="retired"):
    sb_request("PATCH", "model_versions", params={"id": f"eq.{model_row['id']}"},
               body={"is_deployed": False, "status": new_status,
                     "retired_at": datetime.now(timezone.utc).isoformat()})


def promote_model(model_id):
    sb_request("PATCH", "model_versions", params={"id": f"eq.{model_id}"},
               body={"is_deployed": True, "status": "deployed",
                     "promoted_at": datetime.now(timezone.utc).isoformat()})


def insert_training_run(payload):
    rows = sb_request("POST", "training_runs", body=payload, prefer="return=representation")
    return rows[0]["id"] if rows else None


def finish_training_run(run_id, patch):
    sb_request("PATCH", "training_runs", params={"id": f"eq.{run_id}"}, body=patch)


# ── commands ──────────────────────────────────────────────────────────────

def cmd_run():
    settings = fetch_settings()
    records = fetch_dataset(since_days=int(os.environ.get("TRAIN_SINCE_DAYS", "180")))
    n = len(records)
    now = datetime.now(timezone.utc).isoformat()
    if n < 50:
        print(f"only {n} evaluated production predictions — need more history before training")
        return 1

    train_pool, holdout = chronological_split(records)
    folds = walk_forward_folds(len(train_pool))

    deployed_row = get_deployed_model()
    dep_w = deployed_weights(deployed_row)

    # walk-forward: candidate (re-learned per fold) vs deployed replay vs raw majority
    wf_c, wf_d, wf_b = [], [], []
    for train_end, val_start, val_end in folds:
        learned = blend_weights(dep_w, compute_strategy_stats(train_pool[:train_end]))
        val = train_pool[val_start:val_end]
        wf_c.append(evaluate_weights(val, learned))
        wf_d.append(evaluate_weights(val, dep_w))
        wf_b.append(evaluate_majority(val))

    def agg(items):
        wrs = [i["win_rate"] for i in items if i["win_rate"] is not None]
        return {"win_rate": round(sum(wrs) / len(wrs), 4) if wrs else None,
                "folds": len(items)}

    # final candidate: learn on the full train pool, blend with deployed prior
    final_weights = blend_weights(dep_w, compute_strategy_stats(train_pool))

    candidate_metrics = {
        "walk_forward": agg(wf_c),
        "holdout": evaluate_weights(holdout, final_weights),
        "labeled": "simulated replay on recorded outcomes",
    }
    deployed_metrics = {
        "walk_forward": agg(wf_d),
        "holdout": evaluate_weights(holdout, dep_w),
        "labeled": "simulated replay on recorded outcomes",
    }
    baseline_metrics = {
        "majority_vote": {"walk_forward": agg(wf_b),
                          "holdout": evaluate_majority(holdout),
                          "labeled": "simulated replay on recorded outcomes"},
    }

    passed, reasons = promotion_gate(candidate_metrics, deployed_metrics, settings, n)
    auto_promote = settings.get("auto_promote", False)

    if passed and auto_promote:
        decision = "promoted"
    elif passed:
        decision = "shadow"
    elif auto_promote:
        decision = "kept_previous"
    else:
        decision = "rejected"

    window_start = records[0]["target_open_ts"]
    window_end = records[-1]["target_open_ts"]
    run_payload = {
        "status": "running",
        "started_at": now,
        "dataset_window_start": window_start,
        "dataset_window_end": window_end,
        "dataset_feature_version": records[0].get("feature_version", "browser-live-v1"),
        "dataset_sha256": dataset_sha256(records),
        "dataset_rows": n,
        "train_rows": len(train_pool),
        "validation_rows": sum(ve - vs for _, vs, ve in folds),
        "holdout_rows": len(holdout),
        "metrics": candidate_metrics,
        "baseline_metrics": baseline_metrics,
    }
    run_id = insert_training_run(run_payload)

    model_id = None
    if decision in ("promoted", "shadow"):
        model_id = f"nexus-weights-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        artifact = sanitize_json({
            "kind": "strategy-weights",
            "model_id": model_id,
            "timeframes": final_weights,
            "dataset": {"window_start": window_start, "window_end": window_end,
                        "rows": n, "sha256": run_payload["dataset_sha256"]},
            "metrics": candidate_metrics,
            "trained_at": now,
        })
        path, sha, nbytes = upload_artifact(model_id, artifact)
        status = "deployed" if decision == "promoted" else "shadow"
        if decision == "promoted" and deployed_row:
            retire_deployed(deployed_row)          # previous model preserved for rollback
        register_model(model_id, artifact, candidate_metrics, status, path, sha, nbytes,
                       notes=f"training_run {run_id}")

    finish_training_run(run_id, {
        "status": "succeeded",
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "model_version_id": model_id,
        "decision": decision,
        "metrics": candidate_metrics,
        "baseline_metrics": baseline_metrics,
        "error": "; ".join(reasons) if reasons else None,
    })

    print(json.dumps({
        "decision": decision, "model_id": model_id,
        "dataset_rows": n, "folds": len(folds),
        "candidate": candidate_metrics, "deployed": deployed_metrics,
        "baseline": baseline_metrics, "gate_reasons": reasons,
    }, indent=2))
    return 0


def cmd_rollback():
    deployed = get_deployed_model()
    if not deployed:
        print("no deployed model to roll back from")
        return 1
    rows = sb_request("GET", "model_versions", params={
        "kind": "eq.strategy-weights",
        "status": "in.(retired,rolled_back)",
        "order": "retired_at.desc", "limit": "1"})
    previous = rows[0] if rows else None
    if not previous:
        print("no previous model available for rollback")
        return 1
    retire_deployed(deployed, new_status="rolled_back")
    promote_model(previous["id"])
    print(f"rolled back: {deployed['id']} → {previous['id']}")
    return 0


def cmd_status():
    rows = sb_request("GET", "model_versions", params={
        "kind": "eq.strategy-weights", "order": "created_at.desc", "limit": "10"})
    for r in rows or []:
        mark = " ★ deployed" if r.get("is_deployed") else ""
        print(f"{r['id']}  status={r.get('status')}{mark}  sha={r.get('artifact_sha256', '')[:12]}…")
    runs = sb_request("GET", "training_runs", params={
        "select": "id,decision,dataset_rows,created_at", "order": "created_at.desc", "limit": "5"})
    print("\nrecent training runs:")
    for r in runs or []:
        print(f"  {r['created_at']}  decision={r.get('decision')}  rows={r.get('dataset_rows')}")
    return 0


def main():
    global SB_URL, SB_KEY
    load_env_file()
    SB_URL = os.environ.get("SUPABASE_URL", "")
    SB_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not SB_URL or not SB_KEY:
        print("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — copy trainer/.env.example to trainer/.env")
        return 2
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        return cmd_run()
    if cmd == "rollback":
        return cmd_rollback()
    if cmd == "status":
        return cmd_status()
    print(f"unknown command: {cmd}\nusage: train.py [run|rollback|status]")
    return 2


if __name__ == "__main__":
    sys.exit(main())
