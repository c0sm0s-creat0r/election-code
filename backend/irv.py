from typing import List, Dict, Tuple
from collections import Counter

def validate_ballot(ballot: List[str], candidate_ids: List[str]) -> Tuple[bool, str]:
    seen = set()
    for cid in ballot:
        if cid not in candidate_ids:
            return False, f"Unknown candidate id: {cid}"
        if cid in seen:
            return False, f"Duplicate candidate id in ballot: {cid}"
        seen.add(cid)
    return True, ""

def run_irv(candidates: List[Dict[str, str]], ballots: List[List[str]]):
    active = [dict(c) for c in candidates]
    active_ids = [c["id"] for c in active]
    eliminated = set()

    working_ballots = []
    for b in ballots:
        filtered = [cid for cid in b if cid in active_ids]
        if filtered:
            working_ballots.append(filtered)

    rounds = []
    winner = None

    while True:
        total_valid = 0
        counts = Counter()

        for b in working_ballots:
            for cid in b:
                if cid not in eliminated:
                    counts[cid] += 1
                    total_valid += 1
                    break

        round_summary = {
            "tally": [],
            "eliminated": [],
            "threshold": 0.5
        }

        if total_valid == 0:
            rounds.append(round_summary)
            break

        result_line = []
        for c in active:
            if c["id"] in eliminated:
                continue
            v = counts.get(c["id"], 0)
            share = v / total_valid if total_valid else 0.0
            result_line.append({"id": c["id"], "name": c["name"], "votes": v, "share": share})
        result_line.sort(key=lambda x: (-x["votes"], x["name"].lower()))
        round_summary["tally"] = result_line

        leader = result_line[0] if result_line else None
        if leader and leader["share"] > 0.5:
            winner = next(c for c in active if c["id"] == leader["id"])
            rounds.append(round_summary)
            break

        min_votes = min(r["votes"] for r in result_line)
        to_eliminate = [r["id"] for r in result_line if r["votes"] == min_votes]

        round_summary["eliminated"] = [
            {"id": cid, "name": next(c["name"] for c in active if c["id"] == cid)}
            for cid in to_eliminate
        ]
        rounds.append(round_summary)

        for cid in to_eliminate:
            eliminated.add(cid)

        remaining = [c for c in active if c["id"] not in eliminated]
        if len(remaining) == 1:
            winner = remaining[0]
            break

    return rounds, winner