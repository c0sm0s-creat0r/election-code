import os
import csv
import io
from uuid import uuid4
from functools import wraps
from typing import Optional
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from dotenv import load_dotenv
from irv import run_irv, validate_ballot

# pull super secret info from .env
load_dotenv()

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "super-secret-admin-key")

# Set up react flask
app = Flask(__name__)
# ended up locking down CORS... let's see how it goees
CORS(app, resources={
    r"/api/*": {
        "origins": [
            "https://vote.dalyell.com.au",
            "https://admin.dalyell.com.au"
        ],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization", "X-Admin-Token"]
    }
})




DB = { "elections": {} }

def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("X-Admin-Token")
        if token != ADMIN_TOKEN:
            return jsonify({"error": "Unauthorized"}), 403
        return f(*args, **kwargs)
    return wrapper

def _validate_usu_id(usu_id: str) -> bool:
    return isinstance(usu_id, str) and usu_id.isdigit() and (7 <= len(usu_id) <= 8)

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

@app.post("/api/elections/<eid>/login")
def voter_login(eid):
    # Pseudo-login: record attendee (name + usu_id).
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    data = request.json or {}
    name = (data.get("name") or "").strip()
    usu_id = (data.get("usu_id") or "").strip()
    if not name or not _validate_usu_id(usu_id):
        return jsonify({"error": "Invalid name or USU ID (must be 7-8 digits)."}), 400

    existing = next((a for a in election["attendees"] if a["usu_id"] == usu_id), None)
    if not existing:
        attendee = {"name": name, "usu_id": usu_id, "voted": False}
        election["attendees"].append(attendee)
        return jsonify({"ok": True, "attendee": attendee})
    else:
        if existing["name"] != name:
            existing["name"] = name
        return jsonify({"ok": True, "attendee": existing})

@app.post("/api/elections/<eid>/ballots")
def add_ballot(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    data = request.json or {}
    ballot = data.get("ballot", [])
    # Handle voter information - addition
    voter = data.get("voter", {}) or {}
    name = (voter.get("name") or "").strip()
    usu_id = (voter.get("usu_id") or "").strip()

    if not name or not _validate_usu_id(usu_id):
        return jsonify({"error": "Invalid voter credentials. Please login first."}), 400

    attendee = next((a for a in election["attendees"] if a["usu_id"] == usu_id), None)
    if not attendee:
        attendee = {"name": name, "usu_id": usu_id, "voted": False}
        election["attendees"].append(attendee)
    else:
        if attendee["name"] != name:
            attendee["name"] = name

    if attendee.get("voted"):
        return jsonify({"error": "This USU ID has already voted in this election."}), 403

    ok, msg = validate_ballot(ballot, [c["id"] for c in election["candidates"]])
    if not ok:
        return jsonify({"error": msg}), 400

    election["ballots"].append(ballot)
    attendee["voted"] = True
    return jsonify({"ok": True, "ballots_count": len(election["ballots"])})

@app.post("/api/elections")
@require_admin
def create_election():
    data = request.json or {}
    name = data.get("name", "Untitled Election")
    eid = str(uuid4())
    DB["elections"][eid] = {
        "id": eid,
        "name": name,
        "candidates": [],
        "ballots": [],
        "attendees": [],
    }
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

@app.get("/api/elections/<eid>/attendance")
@require_admin
def attendance(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    return jsonify({"attendees": election["attendees"]})

@app.get("/api/elections/<eid>/attendance.csv")
@require_admin
def attendance_csv(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["name", "usu_id", "voted"])
    for a in election["attendees"]:
        writer.writerow([a.get("name",""), a.get("usu_id",""), "yes" if a.get("voted") else "no"])
    csv_data = output.getvalue()
    output.close()

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={ "Content-Disposition": f"attachment; filename=attendance_{eid}.csv" }
    )
    
@app.get("/api/elections/attendance.csv")
@require_admin
def download_all_attendance():
    # Create an in-memory buffer
    output = io.StringIO()
    writer = csv.writer(output)

    # Write header
    writer.writerow(["Election ID", "Election Name", "Name", "USU ID", "Voted"])

    # Loop through all elections
    for election_id, election in DB["elections"].items():
        election_name = election["name"]
        for attendee in election.get("attendees", []):
            writer.writerow([
                election_id,
                election_name,
                attendee["name"],
                attendee["usu_id"],
                "Yes" if attendee.get("voted") else "No"
            ])
    csv_data = output.getvalue()
    output.close()

    # Return response with CSV mimetype
    return Response(
        csv_data, 
        mimetype="text/csv", 
        headers={ "Content-Disposition": "attachment; filename=all_attendance.csv" }
    )

if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "127.0.0.1")
    port = int(os.getenv("FLASK_PORT", "4500"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host=host, port=port, debug=debug)