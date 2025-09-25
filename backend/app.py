import os
from uuid import uuid4
from functools import wraps
from typing import Optional
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv
from irv import run_irv, validate_ballot

# pull super secret info from .env
load_dotenv()

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "super-secret-admin-key")

# Set up react flask
app = Flask(__name__)
CORS(app)

DB = {"elections": {}}

def require_admin(f):
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("X-Admin-Token")
        if token != ADMIN_TOKEN:
            return jsonify({"error": "Unauthorized"}), 403
        return f(*args, **kwargs)
    return wrapper

@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})

@app.get("/api/elections")
def list_elections():
    return jsonify(list(DB["elections"].values()))

@app.get("/api/elections/<eid>")
def get_election(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    return jsonify(election)

@app.post("/api/elections/<eid>/ballots")
def add_ballot(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    
    data = request.json or {}
    ballot = data.get("ballot", [])
    
    ok, msg = validate_ballot(ballot, [c["id"] for c in election["candidates"]])
    if not ok:
        return jsonify({"error": msg}), 400
    
    election["ballots"].append(ballot)
    return jsonify({"ok": True, "ballots_count": len(election["ballots"])})

@app.post("/api/elections")
@require_admin
def create_election():
    data = request.json or {}
    name = data.get("name", "Untitled Election")
    eid = str(uuid4())
    DB["elections"][eid] = {"id": eid, "name": name, "candidates": [], "ballots": []}
    return jsonify(DB["elections"][eid]), 201

@app.post("/api/elections/<eid>/candidates")
@require_admin
def add_candidate(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    data = request.json or {}
    name = data.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    cid = str(uuid4())
    election["candidates"].append({"id": cid, "name": name})
    return jsonify(election)

@app.get("/api/elections/<eid>/tally")
@require_admin
def tally(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    if not election["candidates"]:
        return jsonify({"error": "no candidates"}), 400
    rounds, winner = run_irv(election["candidates"], election["ballots"])
    return jsonify({"rounds": rounds, "winner": winner})



if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "127.0.0.1")
    port = int(os.getenv("FLASK_PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host=host, port=port, debug=debug)