"""Generate differential-test fixtures from the legacy irv.py.

Run once: python3 scripts/generate-irv-fixtures.py
Cases where the old code returns no winner (its tie bug) are recorded with
"winner": null and skipped by the differential test, which asserts separately
that the new count DOES return a winner for them.
"""
import json, random, sys
sys.path.insert(0, 'backend')
from irv import run_irv

random.seed(42)
cases = []
for i in range(200):
    n = random.randint(2, 6)
    candidates = [{"id": f"c{j}", "name": f"Candidate {j}"} for j in range(n)]
    ballots = []
    for _ in range(random.randint(1, 60)):
        order = [c["id"] for c in candidates]
        random.shuffle(order)
        ballots.append(order[: random.randint(1, n)])
    rounds, winner = run_irv(candidates, ballots)
    cases.append({
        "candidates": candidates,
        "ballots": ballots,
        "winner": winner["id"] if winner else None,
    })

with open('packages/core/tests/fixtures/irv-cases.json', 'w') as f:
    json.dump(cases, f, indent=2)
print(f"wrote {len(cases)} cases, {sum(1 for c in cases if c['winner'] is None)} with no winner")
