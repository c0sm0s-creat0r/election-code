import os
import csv
import io
from uuid import uuid4
from functools import wraps
from typing import Optional
from flask import Flask, jsonify, request, Response, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from irv import run_irv, validate_ballot

from werkzeug.utils import secure_filename
UPLOAD_FOLDER = "uploads"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif"}
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# pull super secret info from .env
load_dotenv()

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "super-secret-admin-key")

# Set up react flask
app = Flask(__name__)
CORS(app)
# if i want to lock down CORS:
# CORS(app, resources={
#     r"/api/*": {
#         "origins": [
#             "https://vote.dalyell.com.au",
#             "https://admin.dalyell.com.au"
#         ],
#         "methods": ["GET", "POST", "PATCH", "OPTIONS"],
#         "allow_headers": ["Content-Type", "Authorization", "X-Admin-Token", "x-admin-token", "Access-Control-Allow-Origin"]
#     }
# })


DEFAULT_BRANDING = {
    "title": "Dalyell Elections",
    "org_name": "Dalyell Scholars Association",
    "accent_color": "#fffdd0",
    "logo_url": ""  # uploading via public url for now, will change so file upload
}

# DB is structured as batches (instances of elections for each organisations), elections, candidates
# batches { batch_id: { id, slug, name, admin_token, branding, elections: {election_id: {...}}
DB = { "batches": {} }



# -********- HELPER FUNCTIONS -******- looks after validations and any other stuff 

# Wrapper to require admin for certain REST endpoints 
# (Changed so individual for each site - might change back to single admin at some point)
def require_batch_admin(f):
    @wraps(f)
    def wrapper(batch_id, *args, **kwargs):
        token = request.headers.get("X-Admin-Token")
        batch = DB["batches"].get(batch_id)
        if not batch or token != batch["admin_token"]:
            return jsonify({"error": "Unauthorized - NOT ADMIN"}), 403
        return f(batch_id, *args, **kwargs)
    return wrapper


def _validate_usu_id(usu_id: str) -> bool:
    return isinstance(usu_id, str) and usu_id.isdigit() and (7 <= len(usu_id) <= 8) # Lowkey assuming that usu id is 7-8 numbers in length

# Grab batch associated with slug (slug is the last part of URL - used so that each organisation has it's own 'site')
# In effect, grabs the correct instance to be shown for a given domain
def get_batch_by_slug(slug: str):
    for b in DB["batches"].values():
        if b.get("slug") == slug:
            return b
    return None

# Filetype allowed for logo upload
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)


# -*******- HEALTH -******- anything relating to status, just current if active (i use to check render running as it has downtime)

# Backend use, can check that it is running okay - or check that backend is active
@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


# -****- BATCH RESTS -****- RESTful API relating to batch level of DB


@app.post("/api/batches")
def create_batch():
    data = request.json or {}
    name = (data.get("name") or "New Batch").strip()
    slug = (data.get("slug") or name.lower().replace(" ", "-")).strip()
    admin_token = data.get("admin_token")  # probs need to store in hash form for production

    if not admin_token:
        return jsonify({"error": "admin_token required"}), 400

    if get_batch_by_slug(slug):
        return jsonify({"error": "slug already exists"}), 400

    branding_in = data.get("branding") or {}
    branding = {
        "title": branding_in.get("title", DEFAULT_BRANDING["title"]),
        "org_name": branding_in.get("org_name", DEFAULT_BRANDING["org_name"]),
        "accent_color": branding_in.get("accent_color", DEFAULT_BRANDING["accent_color"]),
        "logo_url": branding_in.get("logo_url", DEFAULT_BRANDING["logo_url"]),  # PUBLIC URL for now
    }

    batch_id = str(uuid4())
    DB["batches"][batch_id] = {
        "id": batch_id,
        "slug": slug,
        "name": name,
        "admin_token": admin_token,
        "branding": branding,
        "elections": {}
    }
    safe = {k: v for k, v in DB["batches"][batch_id].items() if k != "admin_token"}
    return jsonify(safe), 201

# Public listing of batches (no admin_token)
@app.get("/api/batches")
def list_batches():
    return jsonify([
        {k: v for k, v in b.items() if k != "admin_token"}
        for b in DB["batches"].values()
    ])

# Calling helper to retrieve necessary instance for current slug (url)
@app.get("/api/batches/by-slug/<slug>")
def get_batch_by_slug_route(slug):
    batch = get_batch_by_slug(slug)
    
    if not batch:
        return jsonify({"error": "batch not found when searching by slug"}), 404
    
    return jsonify({k: v for k, v in batch.items() if k != "admin_token"})

# Update bradning for specific site instance (specific batch)
@app.patch("/api/batches/<batch_id>/branding")
@require_batch_admin
def update_branding(batch_id):
    
    batch = DB["batches"].get(batch_id)
    
    if not batch:
        return jsonify({"error": "batch not found when searching by id to update branding"}), 404
    
    data = request.json or {}
    instance_branding = batch["branding"]
    
    if "title" in data: instance_branding["title"] = data["title"]
    if "org_name" in data: instance_branding["org_name"] = data["org_name"]
    if "accent_color" in data: instance_branding["accent_color"] = data["accent_color"]
    if "logo_url" in data: instance_branding["logo_url"] = data["logo_url"]  # CHANGE SO NOT PUBLIC URL IMPLEMENTATION
    
    return jsonify({"branding": instance_branding})


# Update bradning for specific site instance (specific batch) - by slug
@app.patch("/api/batches/by-slug/<slug>/branding")
def update_branding_by_slug(slug):
    
    batch = get_batch_by_slug(slug)
    
    if not batch:
        return jsonify({"error": "batch not found when searching by slug to update branding"}), 404
    
    token = request.headers.get("X-Admin-Token")
    if token != batch["admin_token"]:
        return jsonify({"error": "Unauthorized - NO ADMIN ACCESS"}), 403
    
    data = request.json or {}
    instance_branding = batch["branding"]
    
    if "title" in data: instance_branding["title"] = data["title"]
    if "org_name" in data: instance_branding["org_name"] = data["org_name"]
    if "accent_color" in data: instance_branding["accent_color"] = data["accent_color"]
    if "logo_url" in data: instance_branding["logo_url"] = data["logo_url"]
    return jsonify({"branding": instance_branding})


# Upload logo
@app.post("/api/batches/<batch_id>/logo")
def upload_logo(batch_id):
    batch = DB["batches"].get(batch_id)
    if not batch:
        return jsonify({"error": "not found"}), 404

    if "file" not in request.files:
        return jsonify({"error": "no file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "empty filename"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "invalid file type"}), 400

    filename = secure_filename(file.filename)
    save_path = os.path.join(UPLOAD_FOLDER, filename)
    file.save(save_path)

    # Construct a public-ish URL (for dev/demo)
    file_url = f"/uploads/{filename}"
    batch["branding"]["logo_url"] = file_url

    return jsonify({"logo_url": file_url})

# -*********- Elections -*****- all api relating to election level

# -*- VOTER APIs -*-

# All information relating to elections in API run through /elections REST 


# list elections in batch
@app.get("/api/batches/<batch_id>/elections")
def list_elections_in_batch(batch_id):
    batch = DB["batches"].get(batch_id)
    if not batch:
        return jsonify({"error": "batch not found when searching by id for election list"}), 404
    return jsonify(list(batch["elections"].values()))


# get election, for batch
@app.get("/api/batches/<batch_id>/elections/<eid>")
def get_election_in_batch(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404
    return jsonify(batch["elections"][eid])

# Pseudo-login that just records attendee (name + usu_id) - should probs fix this to be an overall page login but oh well. or not run it through the election
@app.post("/api/batches/<batch_id>/elections/<eid>/login")
def voter_login(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404
    data = request.json or {}
    name = (data.get("name") or "").strip()
    usu_id = (data.get("usu_id") or "").strip()
    if not name or not _validate_usu_id(usu_id):
        return jsonify({"error": "Invalid name or USU ID (must be 7-8 digits)."}), 400
    
    election = batch["elections"][eid]
    existing = next((a for a in election["attendees"] if a["usu_id"] == usu_id), None)
    if not existing:
        attendee = {"name": name, "usu_id": usu_id, "voted": False}
        election["attendees"].append(attendee)
        return jsonify({"ok": True, "attendee": attendee})
    else:
        if existing["name"] != name:
            existing["name"] = name
        return jsonify({"ok": True, "attendee": existing})


# Submit ballot by voter
@app.post("/api/batches/<batch_id>/elections/<eid>/ballots")
def add_ballot(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404
    
    election = batch["elections"][eid]
    
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

# -*- ADMIN APIs -*-

# Add election to the data base
@app.post("/api/batches/<batch_id>/elections")
@require_batch_admin
def create_election(batch_id):
    batch = DB["batches"].get(batch_id)
    
    if not batch:
        return jsonify({"error": "not found"}), 404
    
    data = request.json or {}
    name = data.get("name", "Untitled Election").strip()
    eid = str(uuid4())
    batch["elections"][eid] = {
        "id": eid,
        "name": name,
        "candidates": [],
        "ballots": [],
        "attendees": [],
    }
    return jsonify(batch["elections"][eid]), 201

# Add candidate to the election
@app.post("/api/batches/<batch_id>/elections/<eid>/candidates")
@require_batch_admin
def add_candidate(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404
    data = request.json or {}
    name = data.get("name")
    if not name:
        return jsonify({"error": "name required"}), 400
    
    cid = str(uuid4())
    batch["elections"][eid]["candidates"].append({"id": cid, "name": name})
    
    return jsonify(batch["elections"][eid])



# Tally the election results
@app.get("/api/batches/<batch_id>/elections/<eid>/tally")
@require_batch_admin
def tally(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404
    
    election = batch["elections"][eid]
    if not election["candidates"]:
        return jsonify({"error": "no candidates"}), 400
    rounds, winner = run_irv(election["candidates"], election["ballots"])
    return jsonify({"rounds": rounds, "winner": winner})


# Grab attendance for single election in json format
# lowkey don't think i use this anymore need to check
@app.get("/api/batches/<batch_id>/elections/<eid>/attendance")
@require_batch_admin
def attendance(eid):
    election = DB["elections"].get(eid)
    if not election:
        return jsonify({"error": "not found"}), 404
    return jsonify({"attendees": election["attendees"]})


# Download attendance for single elections in a csv
@app.get("/api/batches/<batch_id>/elections/<eid>/attendance.csv")
@require_batch_admin
def attendance_csv(batch_id, eid):
    batch = DB["batches"].get(batch_id)
    
    if not batch or eid not in batch["elections"]:
        return jsonify({"error": "not found"}), 404

    election = batch["elections"][eid]
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["name", "usu_id", "voted"])
    for a in election["attendees"]:
        writer.writerow([a.get("name",""), a.get("usu_id",""), "yes" if a.get("voted") else "no"])  # Maybe change this to differnet info idk
    csv_data = output.getvalue()
    output.close()

    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=attendance_{eid}.csv"}
    )

    

# Download attendance for all elections (in a batch)
@app.get("/api/batches/<batch_id>/attendance.csv")
@require_batch_admin
def download_all_attendance(batch_id):
    
    batch = DB["batches"].get(batch_id)
    if not batch:
        return jsonify({"error": "not found"}), 404
    output = io.StringIO()
    writer = csv.writer(output)
    
    writer.writerow(["Election ID", "Election Name", "Name", "USU ID", "Voted"])
    
    for election_id, election in batch["elections"].items():
        for attendee in election.get("attendees", []):
            writer.writerow([
                election_id,
                election.get("name",""),
                attendee.get("name",""),
                attendee.get("usu_id",""),
                "yes" if attendee.get("voted") else "no"
            ])
    csv_data = output.getvalue()
    output.close()
    
    return Response(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=all_attendance_batch_{batch_id}.csv"}
    )

if __name__ == "__main__":
    host = os.getenv("FLASK_HOST", "127.0.0.1")
    port = int(os.getenv("FLASK_PORT", "4500"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host=host, port=port, debug=debug)